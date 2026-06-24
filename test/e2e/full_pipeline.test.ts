/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FULL END-TO-END through running docker compose stack.
 *
 * Required preconditions (test FAILS, does not skip, if missing):
 *   - Anvil on $RPC_URL (default http://127.0.0.1:8545)
 *   - fhEVM host contracts + ConfidentialToken deployed (TOKEN_ADDRESS in .env.local)
 *   - `docker compose up -d --build` — runs envio-postgres, graphql-engine,
 *     envio-indexer, nats, api, worker, escalator, balance-refresh
 *   - TOKEN_ADDRESS, ACL_CONTRACT_ADDRESS, INDEXER_PRIVATE_KEY, DATABASE_URL,
 *     NATS_URL exported (source .env.local)
 *
 * What's actually exercised end-to-end:
 *   1. SDK encrypts → ConfidentialToken.mint/confidentialTransfer on anvil.
 *   2. Envio HyperIndex sees ConfidentialTransfer log, runs EventHandler,
 *      writes row to app.transfers, publishes NATS msg on decrypt.<signer>.
 *   3. Worker consumes msg, calls real userDecrypt via ZamaDecryptor, writes
 *      cleartext_amount back to PG.
 *   4. Test polls GET /transfers/:addr via the running Fastify API until
 *      cleartext appears (or the explicit status the test expects).
 *
 * No piece is mocked: every byte of the data path runs through real infra.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeEventTopics,
  decodeEventLog,
  defineChain,
  type Hex,
  type Chain,
  type HttpTransport,
  type Account,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Wallet = ReturnType<typeof createWalletClient<HttpTransport, Chain, Account>>;
type Public = ReturnType<typeof createPublicClient<HttpTransport, Chain>>;
import { normAddr, type Address, type Hex32 } from "../../src/util/hex.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const TOKEN = (process.env.TOKEN_ADDRESS ?? "") as Address;
const PK = (process.env.INDEXER_PRIVATE_KEY ?? process.env.DEPLOYER_PK ?? "") as `0x${string}`;
const API_URL = process.env.API_URL ?? "http://127.0.0.1:3000";

const POLL_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 750;
const BALANCE_DEADLINE_MS = 120_000;

const TOKEN_ABI = parseAbi([
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function mint(address to, bytes32 encryptedAmount, bytes calldata inputProof) returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes calldata inputProof) returns (bytes32)",
]);

const CONDITIONS_MET = !!TOKEN && !!PK;
const describeIfChain = CONDITIONS_MET ? describe : describe.skip;

interface ApiTransfer {
  id: number;
  block: number;
  logIndex: number;
  txHash: string;
  from: string;
  to: string;
  handle: string;
  amountCleartext: string | null;
  status: "ready" | "done" | "no_acl" | "failed";
  reason: string | null;
}

interface ApiTransfersResponse {
  items: ApiTransfer[];
  count: number;
  nextCursor: string | null;
}

interface ApiBalance {
  addr: string;
  amount: string | null;
  source: string | null;
  reason: string | null;
  currentHandle: string | null;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function waitFor<T>(predicate: () => Promise<T | null>, deadlineMs: number, label: string): Promise<T> {
  const start = Date.now();
  let last: unknown = null;
  while (Date.now() - start < deadlineMs) {
    try {
      const v = await predicate();
      if (v != null) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out (${deadlineMs}ms) waiting for ${label}; last=${String(last)}`);
}

async function findTransfer(addr: Address, txHash: string, logIndex: number): Promise<ApiTransfer | null> {
  const body = await apiGet<ApiTransfersResponse>(`/transfers/${addr}?limit=200`);
  return (
    body.items.find(
      (i) => i.txHash.toLowerCase() === txHash.toLowerCase() && Number(i.logIndex) === Number(logIndex),
    ) ?? null
  );
}

async function waitForTransferReady(addr: Address, txHash: string, logIndex: number): Promise<ApiTransfer> {
  return waitFor(
    () => findTransfer(addr, txHash, logIndex),
    POLL_DEADLINE_MS,
    `transfer ${txHash}#${logIndex} to appear in /transfers/${addr}`,
  );
}

async function waitForTransferStatus(
  addr: Address,
  txHash: string,
  logIndex: number,
  predicate: (t: ApiTransfer) => boolean,
  label: string,
): Promise<ApiTransfer> {
  return waitFor(
    async () => {
      const t = await findTransfer(addr, txHash, logIndex);
      return t && predicate(t) ? t : null;
    },
    POLL_DEADLINE_MS,
    `transfer ${txHash}#${logIndex} ${label}`,
  );
}

const chain: Chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

let publicClient: Public;
let walletClient: Wallet;
let holderAddr: Address;
// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
let sdkAny: any;

beforeAll(async () => {
  if (!CONDITIONS_MET) return;

  const account = privateKeyToAccount(PK);
  holderAddr = normAddr(account.address);

  publicClient = createPublicClient({ chain, transport: http(RPC) });
  walletClient = createWalletClient({ account, chain, transport: http(RPC) });

  // 1. API must be up. /health proves it.
  await waitFor(
    async () => {
      const res = await fetch(`${API_URL}/health`);
      return res.ok ? true : null;
    },
    30_000,
    `API at ${API_URL}/health`,
  );

  // 2. Register holder as a signer (idempotent — POST is upsert). Worker
  //    self-restarts via compose's restart:unless-stopped and reloads signers
  //    on next boot.
  await apiPost(`/admin/signers`, {
    addr: holderAddr,
    kind: "local_eoa",
    costRank: 0,
    config: { privateKeyEnv: "INDEXER_PRIVATE_KEY" },
  });

  // 3. Wait until worker is alive — NATS reports a worker-<addr> consumer.
  await waitFor(
    async () => {
      const h = await apiGet<any>("/health");
      const wanted = `worker-${holderAddr.toLowerCase()}`;
// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
      const found = h?.nats?.consumers?.some((c: any) => c.name?.toLowerCase() === wanted);
      return found ? true : null;
    },
    60_000,
    `NATS consumer for ${holderAddr} (worker restart after admin POST)`,
  );

  // 4. Bring up the SDK with the same cleartext relayer the indexer uses.
  process.env.ZAMA_RELAYER_MODE = "cleartext";
// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
  const sdkMod: any = await import("@zama-fhe/sdk");
// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
  const viemMod: any = await import("@zama-fhe/sdk/viem");
  const config = viemMod.createConfig({
    chains: [sdkMod.anvil],
    walletClient,
    publicClient,
    relayers: { [sdkMod.anvil.id]: sdkMod.cleartext() },
    storage: new sdkMod.MemoryStorage(),
  });
  sdkAny = new sdkMod.ZamaSDK(config);
}, 180_000);

// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
function extractTransferLog(receipt: any): {
  from: Address;
  to: Address;
  handle: Hex32;
  blockNumber: number;
  logIndex: number;
  txHash: string;
} {
  const topic0 = encodeEventTopics({ abi: TOKEN_ABI, eventName: "ConfidentialTransfer" })[0];
  const log = receipt.logs.find(
// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
    (l: any) => l.topics[0] === topic0 && l.address.toLowerCase() === TOKEN.toLowerCase(),
  );
  if (!log) throw new Error("no ConfidentialTransfer log in receipt");
  const decoded = decodeEventLog({
    abi: TOKEN_ABI,
    eventName: "ConfidentialTransfer",
// TODO(slop): `as any` cast — discards the compiler's view of the value; narrow via `as unknown` + a real interface or fix the upstream type
    topics: log.topics as any,
    data: log.data,
// TODO(slop): `as any` cast — discards the compiler's view of the value; narrow via `as unknown` + a real interface or fix the upstream type
  }) as any;
  return {
    from: normAddr(decoded.args.from),
    to: normAddr(decoded.args.to),
    handle: (decoded.args.amount as string).toLowerCase() as Hex32,
    blockNumber: Number(log.blockNumber),
    logIndex: Number(log.logIndex),
    txHash: log.transactionHash.toLowerCase(),
  };
}

async function mintTo(recipient: Address, amount: bigint): Promise<ReturnType<typeof extractTransferLog>> {
  const enc = await sdkAny.relayer.encrypt({
    values: [{ value: amount, type: "euint64" }],
    contractAddress: TOKEN,
    userAddress: recipient,
  });
  const tx = await walletClient.writeContract({
    address: TOKEN,
    abi: TOKEN_ABI,
    functionName: "mint",
    args: [recipient, enc.encryptedValues[0], enc.inputProof],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  expect(receipt.status).toBe("success");
  return extractTransferLog(receipt);
}

describeIfChain("full pipeline — chain → envio → nats → worker → REST API", () => {
  it("contract is alive and reports expected metadata", async () => {
    const name = await publicClient.readContract({
      address: TOKEN,
      abi: TOKEN_ABI,
      functionName: "name",
    });
    expect(name).toBe("Confidential USD");
  });

  it("mint to holder → /transfers/:holder returns cleartext amount", async () => {
    const MINT = 4242n;
    const log = await mintTo(holderAddr, MINT);

    const t = await waitForTransferStatus(
      holderAddr,
      log.txHash,
      log.logIndex,
      (r) => r.status === "done" && r.amountCleartext !== null,
      `decrypted to ${MINT}`,
    );
    expect(t.amountCleartext).toBe(MINT.toString());
    expect(t.from.toLowerCase()).toBe("0x0000000000000000000000000000000000000000");
    expect(t.to.toLowerCase()).toBe(holderAddr.toLowerCase());
    expect(t.handle.toLowerCase()).toBe(log.handle.toLowerCase());
  }, 180_000);

  it("confidentialTransfer holder → recipient → /transfers/:recipient returns cleartext amount", async () => {
    const MINT = 5000n;
    const TRANSFER = 1234n;
    const recipient = normAddr("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"); // anvil[1]

    // Mint funding so the transfer carries non-zero balance.
    await mintTo(holderAddr, MINT);

    // confidentialTransfer via SDK high-level path.
    const tokenObj = sdkAny.createToken(TOKEN);
    const xferResult = await tokenObj.confidentialTransfer(recipient, TRANSFER);
    expect(xferResult.receipt.status).toBe("success");
    const log = extractTransferLog(xferResult.receipt);
    expect(log.from.toLowerCase()).toBe(holderAddr.toLowerCase());
    expect(log.to.toLowerCase()).toBe(recipient.toLowerCase());

    // Holder is `from` → has rights → assigned as signer → worker decrypts → API shows cleartext.
    const t = await waitForTransferStatus(
      holderAddr,
      log.txHash,
      log.logIndex,
      (r) => r.status === "done" && r.amountCleartext !== null,
      `decrypted to ${TRANSFER}`,
    );
    expect(t.amountCleartext).toBe(TRANSFER.toString());
  }, 240_000);

  it("UNHAPPY: transfer between two unregistered addresses → status=no_acl, reason=no_decrypt_rights", async () => {
    // The FHE mint path requires msg.sender == userAddress in the input proof,
    // so we can't mint directly to an unregistered address. Instead: holder
    // (registered) seeds anvil[1] via confidentialTransfer; then anvil[1]
    // forwards to anvil[2] using its OWN wallet. Step 2's emitted handle has
    // only anvil[1] (from) and anvil[2] (to) as eligible parties. Neither is
    // a registered signer in app.signers → pickSigner returns null → row is
    // inserted with status='no_acl' and the worker never sees it.
    const aliceePk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as `0x${string}`; // anvil[1]
    const aliceAccount = privateKeyToAccount(aliceePk);
    const aliceAddr = normAddr(aliceAccount.address);
    const aliceWallet = createWalletClient({ account: aliceAccount, chain, transport: http(RPC) });
    const bob = normAddr("0x90F79bf6EB2c4f870365E785982E1f101E93b906"); // anvil[2]

    // Seed: holder mints to self, then sends a small amount to alice (anvil[1]).
    await mintTo(holderAddr, 5000n);
    const aliceToken = sdkAny.createToken(TOKEN);
    const seed = await aliceToken.confidentialTransfer(aliceAddr, 200n);
    expect(seed.receipt.status).toBe("success");
    // Wait for alice's balance to land in PG so her next transfer has fund-knowledge.
    const seedLog = extractTransferLog(seed.receipt);
    await waitForTransferStatus(
      aliceAddr,
      seedLog.txHash,
      seedLog.logIndex,
      (r) => r.status === "done" && r.amountCleartext !== null,
      "seed transfer decrypted",
    );

    // The unhappy half: alice → bob, signed by alice's own wallet.
    const enc = await sdkAny.relayer.encrypt({
      values: [{ value: 50n, type: "euint64" }],
      contractAddress: TOKEN,
      userAddress: aliceAddr,
    });
    const tx = await aliceWallet.writeContract({
      address: TOKEN,
      abi: TOKEN_ABI,
      functionName: "confidentialTransfer",
      args: [bob, enc.encryptedValues[0], enc.inputProof],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    const log = extractTransferLog(receipt);
    expect(log.from.toLowerCase()).toBe(aliceAddr.toLowerCase());
    expect(log.to.toLowerCase()).toBe(bob.toLowerCase());

    // Verify via Bob's /transfers — neither alice nor bob is in app.signers.
    const t = await waitForTransferStatus(
      bob,
      log.txHash,
      log.logIndex,
      (r) => r.status === "no_acl",
      `landed as no_acl (no eligible signer for alice→bob)`,
    );
    expect(t.amountCleartext).toBeNull();
    expect(t.reason).toBe("no_decrypt_rights");
  }, 240_000);

  it("UNHAPPY: confidentialTransfer with insufficient balance → API surfaces amountCleartext=0", async () => {
    // OpenZeppelin ERC7984 returns transferred=0 on insufficient balance.
    // Poor (anvil[3]) → holder. Holder is the `to`, holder IS our signer, so
    // pickSigner assigns holder; worker decrypts; cleartext=0.
    const poorPk = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as `0x${string}`; // anvil[3]
    const poorAccount = privateKeyToAccount(poorPk);
    const poorWallet = createWalletClient({ account: poorAccount, chain, transport: http(RPC) });

    const enc = await sdkAny.relayer.encrypt({
      values: [{ value: 100n, type: "euint64" }],
      contractAddress: TOKEN,
      userAddress: poorAccount.address,
    });
    const tx = await poorWallet
      .writeContract({
        address: TOKEN,
        abi: TOKEN_ABI,
        functionName: "confidentialTransfer",
        args: [holderAddr, enc.encryptedValues[0], enc.inputProof],
      })
      .catch((e: { message?: string }): { revert: string } => ({ revert: e.message ?? "" }));

    if (typeof tx !== "string") {
      expect(tx.revert).toMatch(/revert|insufficient|balance/i);
      return;
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    const log = extractTransferLog(receipt);
    expect(log.from.toLowerCase()).toBe(normAddr(poorAccount.address).toLowerCase());
    expect(log.to.toLowerCase()).toBe(holderAddr.toLowerCase());

    const t = await waitForTransferStatus(
      holderAddr,
      log.txHash,
      log.logIndex,
      (r) => r.status === "done" && r.amountCleartext !== null,
      `decrypted to 0 (insufficient balance per ERC-7984)`,
    );
    expect(t.amountCleartext).toBe("0");
  }, 240_000);

  it("U-104: mint(holder,100) then confidentialTransfer(holder,recipient,42) → API shows amount=42", async () => {
    const MINT = 100n;
    const TRANSFER = 42n;
    const recipient = normAddr("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

    await mintTo(holderAddr, MINT);

    const encXfer = await sdkAny.relayer.encrypt({
      values: [{ value: TRANSFER, type: "euint64" }],
      contractAddress: TOKEN,
      userAddress: holderAddr,
    });
    const tx = await walletClient.writeContract({
      address: TOKEN,
      abi: TOKEN_ABI,
      functionName: "confidentialTransfer",
      args: [recipient, encXfer.encryptedValues[0], encXfer.inputProof],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    const log = extractTransferLog(receipt);

    const t = await waitForTransferStatus(
      holderAddr,
      log.txHash,
      log.logIndex,
      (r) => r.status === "done" && r.amountCleartext !== null,
      `decrypted to ${TRANSFER}`,
    );
    expect(t.amountCleartext).toBe(TRANSFER.toString());
  }, 240_000);

  it("balance-refresh: mint(holder, X) → /balance/:holder eventually exposes cleartext ≥ X", async () => {
    const SECOND_MINT = 1000n;
    await mintTo(holderAddr, SECOND_MINT);

    // The balance-refresh worker polls every 10s (POLL_INTERVAL_MS in src/worker/balance-refresh.ts).
    // Row is marked stale on each ConfidentialTransfer → next sweep decrypts.
    const b = await waitFor<ApiBalance>(
      async () => {
        const x = await apiGet<ApiBalance>(`/balance/${holderAddr}`);
        return x.amount != null && BigInt(x.amount) >= SECOND_MINT ? x : null;
      },
      BALANCE_DEADLINE_MS,
      `/balance/${holderAddr}.amount ≥ ${SECOND_MINT}`,
    );
    expect(b.amount).not.toBeNull();
    expect(BigInt(b.amount!)).toBeGreaterThanOrEqual(SECOND_MINT);
  }, 180_000);
});

if (!CONDITIONS_MET) {
  describe.skip("full E2E (skipped — TOKEN_ADDRESS or INDEXER_PRIVATE_KEY missing)", () => {
    it("see test/e2e/full_pipeline.test.ts for required env", () => undefined);
  });
}
