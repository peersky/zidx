/* eslint-disable @typescript-eslint/no-explicit-any */
import { getSql, closeSql } from "../db/client.js";
import { loadSigners } from "../providers/loader.js";
import { ZamaDecryptor, isAclMismatch } from "../providers/decryptor.js";
import { pickSignerForTransfer } from "../repositories/queries.js";
import { normAddr, type Address, type Hex32 } from "../util/hex.js";
import { createPublicClient, http, parseAbi } from "viem";
import pino from "pino";

const log = pino({ name: "balance-refresh" });

const ABI = parseAbi([
  "function confidentialBalanceOf(address account) view returns (bytes32)",
]);

const POLL_INTERVAL_MS = 10_000;
const BATCH_SIZE = 16;

export async function main(): Promise<void> {
  const sql = getSql();
  const rpcUrl = process.env.RPC_URL ?? "http://localhost:8545";
  const chainId = parseInt(process.env.CHAIN_ID ?? "31337", 10);
  const tokenAddress = (process.env.TOKEN_ADDRESS ?? "") as Address;
  if (!tokenAddress) {
    log.warn("TOKEN_ADDRESS not set; balance-refresh worker idle");
    return;
  }
  const chain: any = {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  let signers = await loadSigners(sql);
  while (signers.length === 0) {
    log.warn("no signers configured; waiting 5s for POST /admin/signers");
    await new Promise((r) => setTimeout(r, 5_000));
    signers = await loadSigners(sql);
  }
  const decryptors = new Map<Address, ZamaDecryptor>(
    signers.map((s) => [
      s.addr,
      new ZamaDecryptor(s.signer, { rpcUrl, chainId, contractAddress: tokenAddress }),
    ]),
  );

  log.info({ tokenAddress, signers: signers.length, intervalMs: POLL_INTERVAL_MS }, "balance-refresh started");

  while (true) {
    try {
      const stale = await sql<{ addr: Address }[]>`
        SELECT addr FROM app.balances WHERE stale ORDER BY updated_at ASC LIMIT ${BATCH_SIZE}`;
      for (const { addr } of stale) {
        await refreshOne(sql, publicClient, tokenAddress, addr, decryptors);
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, "balance-refresh loop error");
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function refreshOne(
  sql: any,
  publicClient: any,
  tokenAddress: Address,
  addr: Address,
  decryptors: Map<Address, ZamaDecryptor>,
): Promise<void> {
  let handle: Hex32;
  try {
    handle = (await publicClient.readContract({
      address: tokenAddress,
      abi: ABI,
      functionName: "confidentialBalanceOf",
      args: [addr],
    })) as Hex32;
  } catch (err) {
    log.warn({ addr, err: (err as Error).message }, "RPC confidentialBalanceOf failed");
    return;
  }

  if (/^0x0+$/.test(handle)) {
    await sql`
      INSERT INTO app.balances (addr, current_handle, cleartext_amount, source, stale, updated_at)
      VALUES (${addr}, ${handle}, NULL, 'never_shielded', FALSE, now())
      ON CONFLICT (addr) DO UPDATE SET
        current_handle=EXCLUDED.current_handle,
        cleartext_amount=NULL,
        source='never_shielded',
        stale=FALSE,
        updated_at=now()`;
    return;
  }

  // Pick a signer that can decrypt this addr's balance handle.
  // Synthetic transfer-like query: from=addr (party-ship gives addr rights),
  // ACL handle grants for addr also apply, delegations from addr's account too.
  const signerAddr = await pickSignerForTransfer(sql, {
    from: addr,
    to: addr,
    handle,
    contract: tokenAddress,
    excluded: [],
  });
  if (!signerAddr) {
    await sql`
      INSERT INTO app.balances (addr, current_handle, cleartext_amount, source, stale, updated_at)
      VALUES (${addr}, ${handle}, NULL, 'no_decrypt_rights', FALSE, now())
      ON CONFLICT (addr) DO UPDATE SET
        current_handle=EXCLUDED.current_handle,
        cleartext_amount=NULL,
        source='no_decrypt_rights',
        stale=FALSE,
        updated_at=now()`;
    return;
  }

  const decryptor = decryptors.get(signerAddr);
  if (!decryptor) {
    log.warn({ signerAddr, addr }, "no decryptor for selected signer");
    return;
  }

  try {
    const { amount } = await decryptor.decrypt(handle);
    await sql`
      INSERT INTO app.balances (addr, current_handle, cleartext_amount, source, stale, updated_at)
      VALUES (${addr}, ${handle}, ${amount.toString()}, 'decrypted', FALSE, now())
      ON CONFLICT (addr) DO UPDATE SET
        current_handle=EXCLUDED.current_handle,
        cleartext_amount=EXCLUDED.cleartext_amount,
        source='decrypted',
        stale=FALSE,
        updated_at=now()`;
  } catch (err) {
    if (isAclMismatch(err)) {
      await sql`
        INSERT INTO app.balances (addr, current_handle, cleartext_amount, source, stale, updated_at)
        VALUES (${addr}, ${handle}, NULL, 'no_decrypt_rights', FALSE, now())
        ON CONFLICT (addr) DO UPDATE SET
          current_handle=EXCLUDED.current_handle,
          cleartext_amount=NULL,
          source='no_decrypt_rights',
          stale=FALSE,
          updated_at=now()`;
    } else {
      log.warn({ addr, signerAddr, err: (err as Error).message }, "decrypt failed (retryable); leaving stale");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      log.error({ err: (err as Error).message }, "balance-refresh fatal");
      process.exit(1);
    })
    .finally(() => closeSql());
}

export { normAddr };
