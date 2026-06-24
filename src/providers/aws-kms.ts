import type { IndexerSigner, SignTypedDataArgs } from "./signer.js";
import type { Address } from "../util/hex.js";

/**
 * Not implemented. Reference contract for AWS KMS ECC_SECG_P256K1 key adapter:
 *   - getAddress: GetPublicKey → keccak(uncompressed pubkey)[-20:]
 *   - signTypedData: hash EIP-712 via viem.hashTypedData, then
 *                    kms.Sign({KeyId, Message: digest, MessageType: 'DIGEST',
 *                              SigningAlgorithm: 'ECDSA_SHA_256'});
 *                    parse DER signature, recover v.
 */
export class KmsSigner implements IndexerSigner {
  readonly kind = "aws_kms" as const;
  constructor(_config: { keyId: string; region: string }) {
    throw new Error("KmsSigner: not implemented in this submission");
  }
  getAddress(): Promise<Address> { throw new Error("not implemented"); }
  signTypedData(_args: SignTypedDataArgs): Promise<`0x${string}`> { throw new Error("not implemented"); }
}
