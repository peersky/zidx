import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { IndexerSigner, SignTypedDataArgs } from "./signer.js";
import type { Address } from "../util/hex.js";

export class LocalEoaSigner implements IndexerSigner {
  readonly kind = "local_eoa" as const;
  private account: PrivateKeyAccount;

  constructor(privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
  }

  async getAddress(): Promise<Address> {
    return this.account.address as Address;
  }

  async signTypedData(args: SignTypedDataArgs): Promise<`0x${string}`> {
    return this.account.signTypedData({
      domain: args.domain,
      types: args.types,
      primaryType: args.primaryType,
      message: args.message,
    } as Parameters<PrivateKeyAccount["signTypedData"]>[0]);
  }
}

export function localEoaFromEnv(envVar = "INDEXER_PRIVATE_KEY"): LocalEoaSigner {
  const pk = process.env[envVar];
  if (!pk) throw new Error(`${envVar} not set`);
  return new LocalEoaSigner(pk as `0x${string}`);
}
