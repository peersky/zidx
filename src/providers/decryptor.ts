/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { IndexerSigner } from "./signer.js";
import type { Address, Hex32 } from "../util/hex.js";

// `any` is used liberally below: the @zama-fhe/sdk@alpha types churn between
// releases and the contract we depend on is small enough to assert at runtime.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

function buildViemClients(cfg: { rpcUrl: string; chainId: number }, account: ReturnType<typeof privateKeyToAccount>) {
  const transport = http(cfg.rpcUrl);
  const chain: any = {
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account, chain, transport }),
  };
}

async function buildRelayerFactory(cfg: { chainId: number; relayerApiKey?: string }, sdkMod: any) {
  const mode = process.env.ZAMA_RELAYER_MODE ?? (cfg.chainId === 31337 ? "cleartext" : "node");
  if (mode === "cleartext") return sdkMod.cleartext();
  const nodeMod: any = await import("@zama-fhe/sdk/node").catch(() => null);
  if (nodeMod?.node) return nodeMod.node({ apiKey: cfg.relayerApiKey });
  throw new Error(`relayer mode '${mode}': factory not available`);
}

async function decryptHandle(sdk: any, contractAddress: Address, handle: Hex32): Promise<bigint> {
  const out: Record<string, any> = await sdk.decryption.decryptValues([
    { encryptedValue: handle, contractAddress },
  ]);
  const v = out?.[handle];
  if (v === undefined || v === null) {
    throw new Error(`decrypt: handle ${handle} missing from result; got ${JSON.stringify(out)}`);
  }
  return typeof v === "bigint" ? v : BigInt(v as string);
}

export interface DecryptorConfig {
  rpcUrl: string;
  chainId: number;
  relayerApiKey?: string;
  contractAddress: Address;
}

export interface DecryptResult {
  amount: bigint;
}

interface InitializedSdk {
  decrypt: (handle: Hex32) => Promise<bigint>;
  decryptBalance: () => Promise<bigint>;
  teardown: () => Promise<void>;
}

export class ZamaDecryptor {
  private sdkPromise: Promise<InitializedSdk> | null = null;

  constructor(
    readonly signer: IndexerSigner,
    private readonly config: DecryptorConfig,
  ) {}

  private async getSdk(): Promise<InitializedSdk> {
    if (this.sdkPromise) return this.sdkPromise;
    this.sdkPromise = this.initSdk();
    return this.sdkPromise;
  }

  private async initSdk(): Promise<InitializedSdk> {
    const sdkMod: any = await import("@zama-fhe/sdk");
    const viemMod: any = await import("@zama-fhe/sdk/viem");
    const account = privateKeyToAccount(requireEnv("INDEXER_PRIVATE_KEY") as `0x${string}`);
    const { walletClient, publicClient } = buildViemClients(this.config, account);
    const relayerFactory = await buildRelayerFactory(this.config, sdkMod);
    const fheChain = { ...(this.config.chainId === 31337 ? sdkMod.anvil : sdkMod.sepolia), network: this.config.rpcUrl };
    const sdk: any = new sdkMod.ZamaSDK(
      viemMod.createConfig({
        chains: [fheChain],
        walletClient, publicClient,
        relayers: { [fheChain.id]: relayerFactory },
        storage: new sdkMod.MemoryStorage(),
      }),
    );
    const token: any = sdk.createToken(this.config.contractAddress);
    return {
      decrypt: (handle: Hex32) => decryptHandle(sdk, this.config.contractAddress, handle),
      decryptBalance: () => token.balanceOf(account.address),
      teardown: async () => { if (typeof sdk[Symbol.dispose] === "function") sdk[Symbol.dispose](); },
    };
  }

  async decrypt(handle: Hex32): Promise<DecryptResult> {
    const sdk = await this.getSdk();
    const amount = await sdk.decrypt(handle);
    return { amount };
  }

  async decryptBalance(): Promise<DecryptResult> {
    const sdk = await this.getSdk();
    const amount = await sdk.decryptBalance();
    return { amount };
  }

  async teardown(): Promise<void> {
    if (!this.sdkPromise) return;
    const sdk = await this.sdkPromise;
    await sdk.teardown();
  }
}

export function isAclMismatch(err: unknown): boolean {
  if (!err) return false;
  const m = (err as { message?: string }).message ?? "";
  const code = (err as { code?: string }).code ?? "";
  // DelegationNotPropagatedError is retryable, not a real ACL mismatch.
  if ((err as { name?: string }).name === "DelegationNotPropagatedError") return false;
  return /ACL[_ ]?MISMATCH|not authorized|unauthorized for decrypt|NotAuthorized/i.test(m) ||
         /ACL_MISMATCH|NotAuthorized/i.test(code);
}

export function isPoison(err: unknown): boolean {
  if (!err) return false;
  const m = (err as { message?: string }).message ?? "";
  return /invalid handle|type mismatch|malformed/i.test(m);
}

export function isRetryable(err: unknown): boolean {
  return !isAclMismatch(err) && !isPoison(err);
}
