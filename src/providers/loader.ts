import type { Sql } from "../db/client.js";
import type { SignerConfig, IndexerSigner } from "./signer.js";
import { LocalEoaSigner } from "./local-eoa.js";
import { FireblocksSigner } from "./fireblocks.js";
import { KmsSigner } from "./aws-kms.js";
import type { Address } from "../util/hex.js";

interface DbSignerRow {
  addr: Address;
  kind: "local_eoa" | "fireblocks" | "aws_kms" | "silence_labs" | "turnkey";
  config: Record<string, unknown>;
  cost_rank: number;
}

export async function loadSigners(sql: Sql): Promise<SignerConfig[]> {
  const rows = await sql<DbSignerRow[]>`
    SELECT addr, kind, config, cost_rank FROM app.signers WHERE enabled ORDER BY cost_rank ASC
  `;
  const out: SignerConfig[] = [];
  for (const r of rows) {
    const signer = buildSigner(r.kind, r.config);
    out.push({ addr: r.addr, kind: r.kind, costRank: r.cost_rank, signer });
  }
  return out;
}

function buildSigner(kind: DbSignerRow["kind"], config: Record<string, unknown>): IndexerSigner {
  switch (kind) {
    case "local_eoa": {
      const envVar = (config.privateKeyEnv as string | undefined) ?? "INDEXER_PRIVATE_KEY";
      const pk = process.env[envVar];
      if (!pk) throw new Error(`signer config refs env var ${envVar} (not set)`);
      return new LocalEoaSigner(pk as `0x${string}`);
    }
    case "fireblocks":
      return new FireblocksSigner(config as never);
    case "aws_kms":
      return new KmsSigner(config as never);
    default:
      throw new Error(`signer kind not implemented: ${kind}`);
  }
}
