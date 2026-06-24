import type { Address } from "../util/hex.js";

/**
 * Custody backends (LocalEoa, Fireblocks, KMS, MPC, ...) differ only in how
 * they sign EIP-712 typed data; everything else in the userDecrypt flow lives
 * in ZamaDecryptor. Address is the join key against on-chain ACL state and
 * the `app.signers` table.
 */
export interface IndexerSigner {
  readonly kind: SignerKind;
  getAddress(): Promise<Address>;
  signTypedData(args: SignTypedDataArgs): Promise<`0x${string}`>;
}

export type SignerKind = "local_eoa" | "fireblocks" | "aws_kms" | "silence_labs" | "turnkey";

export interface SignTypedDataArgs {
  domain: {
    name?: string;
    version?: string;
    chainId?: number | bigint;
    verifyingContract?: Address;
  };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignerConfig {
  addr: Address;
  kind: SignerKind;
  costRank: number;
  signer: IndexerSigner;
}
