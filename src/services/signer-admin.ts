import type { Sql } from "../db/client.js";
import type { Address } from "../util/hex.js";
import { upsertSigner, backfillForNewSigner, type SignerInput } from "../repositories/queries.js";
import { connectNats, ensureStream, ensureConsumerForSigner, publishWork } from "../nats/stream.js";

export interface RegisterSignerResult {
  addr: Address;
  backfilled: number;
  natsError: string | null;
}

// Multi-step orchestration: PG upsert + backfill MUST succeed; NATS publish is
// best-effort. If NATS is down, PG state is still correct — worker picks up
// rows on next message arrival once the bus is restored.
export async function registerOrUpdateSigner(
  sql: Sql,
  input: SignerInput,
): Promise<RegisterSignerResult> {
  await upsertSigner(sql, input);
  const backfilledRows = await backfillForNewSigner(sql, input.addr);

  let natsError: string | null = null;
  try {
    const ctx = await connectNats();
    await ensureStream(ctx.jsm);
    await ensureConsumerForSigner(ctx.jsm, input.addr);
    for (const r of backfilledRows) await publishWork(ctx.js, input.addr, { rowId: r.id });
    await ctx.nc.close();
  } catch (err) {
    natsError = (err as Error).message;
  }

  return { addr: input.addr, backfilled: backfilledRows.length, natsError };
}
