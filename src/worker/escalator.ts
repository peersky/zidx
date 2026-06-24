import { getSql, closeSql } from "../db/client.js";
import {
  pickSignerForTransfer,
  markTransferReassigned,
  markTransferTerminallyFailed,
  getTransferById,
} from "../repositories/queries.js";
import { connectNats, publishWork, consumerToSignerAddr, ADVISORY_SUBJECT, STREAM_NAME } from "../nats/stream.js";
import { normAddr } from "../util/hex.js";
import pino from "pino";

const log = pino({ name: "escalator" });

interface MaxDeliveriesAdvisory {
  stream: string;
  consumer: string;     // e.g. "worker-0x..."
  stream_seq: number;
  deliveries: number;
}

export async function main(): Promise<void> {
  const sql = getSql();
  const ctx = await connectNats();
  log.info("escalator subscribing to MAX_DELIVERIES advisory");

  const sub = ctx.nc.subscribe(ADVISORY_SUBJECT);

  for await (const advMsg of sub) {
    const adv = JSON.parse(new TextDecoder().decode(advMsg.data)) as MaxDeliveriesAdvisory;
    // Durable consumer names are stored lowercase; normalize to EIP-55 so
    // exclusion comparisons against app.signers.addr (checksummed) match.
    const failedSigner = normAddr(consumerToSignerAddr(adv.consumer));

    let rowId: number | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const original = await (ctx.jsm as any).streams.getMessage(STREAM_NAME, { seq: adv.stream_seq });
      const payload = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new TextDecoder().decode((original as any).data),
      ) as { rowId: number };
      rowId = payload.rowId;
    } catch (err) {
      log.warn({ err: (err as Error).message, seq: adv.stream_seq }, "could not fetch original message");
      continue;
    }
    if (rowId == null) continue;

    const row = await getTransferById(sql, rowId);
    if (!row || row.status !== "ready") {
      log.debug({ rowId }, "row gone or not ready; nothing to escalate");
      continue;
    }

    if (row.assigned_signer && row.assigned_signer.toLowerCase() !== failedSigner.toLowerCase()) {
      log.debug({ rowId, currentSigner: row.assigned_signer, failedSigner }, "advisory for previous signer, already reassigned");
      continue;
    }

    const excluded = Array.from(new Set([...row.tried_signers, failedSigner]));
    const next = await pickSignerForTransfer(sql, {
      from: row.from_addr,
      to: row.to_addr,
      handle: row.handle,
      contract: row.contract,
      excluded,
    });

    if (!next) {
      await markTransferTerminallyFailed(sql, rowId, excluded, "all_signers_exhausted");
      log.warn({ rowId, tried: excluded }, "no alternative signer — marked failed");
      continue;
    }

    await markTransferReassigned(sql, rowId, next, excluded);
    await publishWork(ctx.js, next, { rowId });
    log.info({ rowId, from: failedSigner, to: next }, "re-elected signer, republished");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      log.error({ err: err.message }, "escalator fatal");
      process.exit(1);
    })
    .finally(() => closeSql());
}
