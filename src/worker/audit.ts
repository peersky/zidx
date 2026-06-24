import { connect } from "@nats-io/transport-node";
import postgres from "postgres";
import { getSql, closeSql } from "../db/client.js";
import pino from "pino";

const log = pino({ name: "nats-audit" });

export const ADVISORY_SUBJECTS = {
  msg_terminated: "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>",
  msg_naked: "$JS.EVENT.ADVISORY.CONSUMER.MSG_NAKED.>",
  consumer_created: "$JS.EVENT.ADVISORY.CONSUMER.CREATED.>",
  consumer_deleted: "$JS.EVENT.ADVISORY.CONSUMER.DELETED.>",
} as const;

export type AdvisoryKind = keyof typeof ADVISORY_SUBJECTS;

export interface AdvisoryPayload {
  stream?: string;
  consumer?: string;
  stream_seq?: number;
  deliveries?: number;
  [k: string]: unknown;
}

export async function recordAdvisory(
  sql: postgres.Sql,
  kind: AdvisoryKind,
  subject: string,
  payload: AdvisoryPayload,
): Promise<void> {
  // postgres.js auto-serializes objects to JSONB when the column is JSONB.
  // We pass via sql.json() to be explicit (works around occasional inference issues).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonHelper = (sql as any).json(payload);
  await sql`
    INSERT INTO app.nats_events (kind, subject, stream, consumer, stream_seq, deliveries, payload)
    VALUES (
      ${kind}, ${subject},
      ${payload.stream ?? null},
      ${payload.consumer ?? null},
      ${payload.stream_seq ?? null},
      ${payload.deliveries ?? null},
      ${jsonHelper}
    )`;
}

export async function main(): Promise<void> {
  const sql = getSql();
  const nc = await connect({ servers: process.env.NATS_URL ?? "nats://localhost:4222" });
  log.info("nats-audit subscribing to MSG_TERMINATED, MSG_NAKED, CONSUMER.CREATED, CONSUMER.DELETED");

  await Promise.all(
    (Object.keys(ADVISORY_SUBJECTS) as AdvisoryKind[]).map(async (kind) => {
      const sub = nc.subscribe(ADVISORY_SUBJECTS[kind]);
      for await (const msg of sub) {
        try {
          const payload = JSON.parse(new TextDecoder().decode(msg.data)) as AdvisoryPayload;
          await recordAdvisory(sql, kind, msg.subject, payload);
          log.debug({ kind, consumer: payload.consumer, stream_seq: payload.stream_seq }, "audit row inserted");
        } catch (err) {
          log.error({ err: (err as Error).message, subject: msg.subject }, "audit insert failed");
        }
      }
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      log.error({ err: err.message }, "audit fatal");
      process.exit(1);
    })
    .finally(() => closeSql());
}
