import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, type PgFixture } from "../helpers/pg-fixture.js";
import { recordAdvisory } from "../../src/worker/audit.js";

let fx: PgFixture;

beforeAll(async () => {
  fx = await startPg();
}, 120_000);

afterAll(async () => {
  await fx?.shutdown();
});

async function reset() {
  await fx.sql`TRUNCATE app.nats_events RESTART IDENTITY`;
}

describe("nats audit: app.nats_events inserts", () => {
  it("records MSG_TERMINATED with stream, consumer, seq, deliveries", async () => {
    await reset();
    await recordAdvisory(
      fx.sql,
      "msg_terminated",
      "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.decrypt-work.worker-0xabc",
      { stream: "decrypt-work", consumer: "worker-0xabc", stream_seq: 42, deliveries: 1 },
    );
    const rows = await fx.sql<{ kind: string; consumer: string; stream_seq: string; deliveries: number }[]>`
      SELECT kind, consumer, stream_seq, deliveries FROM app.nats_events`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "msg_terminated", consumer: "worker-0xabc", deliveries: 1 });
    expect(Number(rows[0]!.stream_seq)).toBe(42);
  });

  it("records MSG_NAKED and exposes via partner-style forensics query", async () => {
    await reset();
    for (let i = 0; i < 3; i++) {
      await recordAdvisory(fx.sql, "msg_naked",
        "$JS.EVENT.ADVISORY.CONSUMER.MSG_NAKED.decrypt-work.worker-0xdead",
        { stream: "decrypt-work", consumer: "worker-0xdead", stream_seq: i, deliveries: i + 1 });
    }
    await recordAdvisory(fx.sql, "msg_naked",
      "$JS.EVENT.ADVISORY.CONSUMER.MSG_NAKED.decrypt-work.worker-0xhealthy",
      { stream: "decrypt-work", consumer: "worker-0xhealthy", stream_seq: 0, deliveries: 1 });
    // Forensics: how many naks for worker-0xdead in recent history?
    const counts = await fx.sql<{ count: string }[]>`
      SELECT COUNT(*) FROM app.nats_events
      WHERE consumer='worker-0xdead' AND kind='msg_naked'`;
    expect(Number(counts[0]!.count)).toBe(3);
  });

  it("records CONSUMER.CREATED + CONSUMER.DELETED for audit timeline", async () => {
    await reset();
    await recordAdvisory(fx.sql, "consumer_created",
      "$JS.EVENT.ADVISORY.CONSUMER.CREATED.decrypt-work.worker-0xnew",
      { stream: "decrypt-work", consumer: "worker-0xnew" });
    await recordAdvisory(fx.sql, "consumer_deleted",
      "$JS.EVENT.ADVISORY.CONSUMER.DELETED.decrypt-work.worker-0xnew",
      { stream: "decrypt-work", consumer: "worker-0xnew" });
    const rows = await fx.sql<{ kind: string }[]>`
      SELECT kind FROM app.nats_events WHERE consumer='worker-0xnew' ORDER BY ts ASC`;
    expect(rows.map((r) => r.kind)).toEqual(["consumer_created", "consumer_deleted"]);
  });

  it("stores full payload JSON for unstructured forensics", async () => {
    await reset();
    const payload = {
      stream: "decrypt-work",
      consumer: "worker-0xabc",
      stream_seq: 99,
      deliveries: 3,
      account: "$G",
      time: "2026-06-22T10:00:00Z",
      domain: "fhevm",
    };
    await recordAdvisory(fx.sql, "msg_terminated",
      "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.decrypt-work.worker-0xabc",
      payload);
    const [row] = await fx.sql<{ payload: { account: string; domain: string } }[]>`
      SELECT payload FROM app.nats_events`;
    expect(row?.payload.account).toBe("$G");
    expect(row?.payload.domain).toBe("fhevm");
  });
});
