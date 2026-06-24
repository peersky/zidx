import type { IndexerSigner, SignTypedDataArgs } from "./signer.js";
import type { Address } from "../util/hex.js";

/**
 * Not implemented. Reference contract for future adapter:
 *   - SDK: @fireblocks/ts-sdk
 *   - getAddress: GET /v1/vault/accounts/{vaultId}/{assetId}/addresses
 *   - signTypedData: POST /v1/transactions with operation=TYPED_MESSAGE,
 *                    extraParameters.rawMessageData.messages[0]={content:eip712,type:'EIP712'};
 *                    poll until COMPLETED, extract signature.
 */
export class FireblocksSigner implements IndexerSigner {
  readonly kind = "fireblocks" as const;
  constructor(_config: { vaultAccountId: number; assetId: string; apiKey: string; secretPath: string }) {
    throw new Error("FireblocksSigner: not implemented in this submission");
  }
  getAddress(): Promise<Address> { throw new Error("not implemented"); }
  signTypedData(_args: SignTypedDataArgs): Promise<`0x${string}`> { throw new Error("not implemented"); }
}
