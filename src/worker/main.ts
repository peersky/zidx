import { getSql, closeSql } from "../db/client.js";
import {
  getTransferById,
  isOurSigner,
  markBalanceStale,
  updateTransferDone,
  updateTransferFailedAcl,
  recordTransferAttempt,
  markTransferTerminallyFailed,
} from "../repositories/queries.js";
import { loadSigners } from "../providers/loader.js";
import { ZamaDecryptor, isAclMismatch, isPoison } from "../providers/decryptor.js";
import { connectNats, ensureStream, ensureConsumerForSigner, durableName, STREAM_NAME } from "../nats/stream.js";
import type { Address } from "../util/hex.js";
import type { SignerConfig } from "../providers/signer.js";
import pino from "pino";

const log = pino({ name: "decrypt-worker" });

async function runWorkerForSigner(
  ctx: Awaited<ReturnType<typeof connectNats>>,
  sig: SignerConfig,
  contractAddress: Address,
): Promise<void> {
  const sql = getSql();
  const decryptor = new ZamaDecryptor(sig.signer, {
    rpcUrl: process.env.RPC_URL ?? "http://localhost:8545",
    chainId: parseInt(process.env.CHAIN_ID ?? "31337", 10),
    relayerApiKey: process.env.RELAYER_API_KEY,
    contractAddress,
  });

  await ensureConsumerForSigner(ctx.jsm, sig.addr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const consumer = await (ctx.js as any).consumers.get(STREAM_NAME, durableName(sig.addr));
  const messages = await consumer.consume();

  log.info({ signer: sig.addr, kind: sig.kind }, "worker started");

  for await (const msg of messages) {
    const decoded = new TextDecoder().decode(msg.data);
    let payload: { rowId: number };
    try {
      payload = JSON.parse(decoded);
    } catch {
      msg.term();
      log.warn({ data: decoded }, "bad payload, terminating");
      continue;
    }

    const row = await getTransferById(sql, payload.rowId);
    if (!row || row.status !== "ready" || row.assigned_signer !== sig.addr) {
      msg.ack();
      continue;
    }

    if (!(await isOurSigner(sql, sig.addr))) {
      msg.ack();
      log.warn({ signer: sig.addr }, "signer no longer in system, ack and skip");
      continue;
    }

    // Heartbeat to extend ack_wait through long decrypts
    const keepalive = setInterval(() => {
      try {
        msg.working();
      } catch {
        // best effort; consumer may have closed
      }
    }, 15_000);

    try {
      // Fault injection for live escalation demos. Signer addresses listed in
      // MOCK_FAILING_SIGNERS throw a transient-retryable error (RelayerRequestFailedError-shaped).
      // This routes through max_deliver → advisory → escalator → re-elect next signer.
      const mockFailing = (process.env.MOCK_FAILING_SIGNERS ?? "").toLowerCase().split(",").map((s) => s.trim());
      if (mockFailing.includes(sig.addr.toLowerCase())) {
        throw new Error("relayer 503 (injected for escalation demo)");
      }
      const result = await decryptor.decrypt(row.handle);
      await sql.begin(async (tx) => {
        await updateTransferDone(tx, row.id, result.amount, "user_decrypt");
        await markBalanceStale(tx, [row.from_addr, row.to_addr]);
      });
      msg.ack();
      log.debug({ rowId: row.id, handle: row.handle, amount: result.amount.toString() }, "decrypt ok");
    } catch (err) {
      await recordTransferAttempt(sql, row.id, errMsg(err));
      if (isAclMismatch(err)) {
        await updateTransferFailedAcl(sql, row.id);
        msg.ack();
        log.warn({ rowId: row.id, err: errMsg(err) }, "ACL mismatch — marked no_acl");
      } else if (isPoison(err)) {
        // Poison is per-handle, not per-signer — fails identically for any signer.
        // Mark terminal in PG directly; msg.term() removes from consumer
        // (does NOT fire MAX_DELIVERIES, only MSG_TERMINATED — which the escalator
        // does not subscribe to. Skipping escalation entirely is correct here.)
        await markTransferTerminallyFailed(sql, row.id, row.tried_signers, `poison: ${errMsg(err)}`);
        msg.term();
        log.error({ rowId: row.id, err: errMsg(err) }, "poison — marked failed in PG, msg terminated");
      } else {
        msg.nak();
        log.warn({ rowId: row.id, attempts: row.attempts, err: errMsg(err) }, "retryable — naked");
      }
    } finally {
      clearInterval(keepalive);
    }
  }
}

function errMsg(err: unknown): string {
  return (err as { message?: string }).message ?? String(err);
}

export async function main(): Promise<void> {
  const sql = getSql();
  const ctx = await connectNats();
  await ensureStream(ctx.jsm);

  let signers = await loadSigners(sql);
  while (signers.length === 0) {
    log.warn("no signers configured; waiting 5s for POST /admin/signers");
    await new Promise((r) => setTimeout(r, 5_000));
    signers = await loadSigners(sql);
  }
  const contractAddress = (process.env.TOKEN_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;

  log.info({ count: signers.length, contractAddress }, "starting per-signer worker loops");
  await Promise.all(signers.map((s) => runWorkerForSigner(ctx, s, contractAddress)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      log.error({ err: err.message }, "worker fatal");
      process.exit(1);
    })
    .finally(() => closeSql());
}
