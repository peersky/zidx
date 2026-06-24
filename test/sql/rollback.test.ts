import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, type PgFixture } from "../helpers/pg-fixture.js";
import { rollbackAppSchema } from "../../src/db/rollback.js";

let fx: PgFixture;

beforeAll(async () => {
  fx = await startPg();
}, 120_000);

afterAll(async () => {
  await fx?.shutdown();
});

const TOKEN = "0x52908400098527886E0F7030069857D2E4169EE7";
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

async function reset() {
  await fx.sql`TRUNCATE
    app.transfers, app.acl_events, app.handle_rights_current,
    app.delegations_current, app.disclosed_amounts, app.operators,
    app.balances, app.signers, app.nats_events RESTART IDENTITY`;
}

async function seedTransferAt(block: number, logIndex = 0) {
  const tx = ("0x" + (block * 1000 + logIndex).toString(16).padStart(64, "0")) as `0x${string}`;
  const h = ("0x" + (block * 99 + logIndex).toString(16).padStart(64, "0")) as `0x${string}`;
  await fx.sql`
    INSERT INTO app.transfers
      (block, log_index, tx_hash, contract, from_addr, to_addr, handle, status, assigned_signer)
    VALUES (${block}, ${logIndex}, ${tx}, ${TOKEN}, ${ALICE}, ${BOB}, ${h}, 'done', ${ALICE})`;
}

async function seedAclEventAt(block: number, logIndex = 0) {
  const tx = ("0x" + (block * 7 + logIndex).toString(16).padStart(64, "0")) as `0x${string}`;
  await fx.sql`
    INSERT INTO app.acl_events
      (block, log_index, tx_hash, kind, contract, caller, account, handle)
    VALUES (${block}, ${logIndex}, ${tx}, 'allow', ${TOKEN}, ${ALICE}, ${BOB}, ${tx})`;
}

async function seedHandleRightAt(block: number, handleByte = 0xaa) {
  const h = ("0x" + handleByte.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
  await fx.sql`
    INSERT INTO app.handle_rights_current (handle, account, granted_at_block, granted_at_log_index)
    VALUES (${h}, ${ALICE}, ${block}, 0)`;
}

describe("rollbackAppSchema — reorg cleanup", () => {
  it("deletes transfers above rollbackToBlock, keeps those at or below", async () => {
    await reset();
    await seedTransferAt(5);
    await seedTransferAt(8);
    await seedTransferAt(10);
    await seedTransferAt(12);

    const counts = await rollbackAppSchema(fx.sql, 8);
    expect(counts.transfers).toBe(2);    // blocks 10, 12 removed

    const rows = await fx.sql<{ block: string }[]>`SELECT block FROM app.transfers ORDER BY block`;
    expect(rows.map((r) => Number(r.block))).toEqual([5, 8]);
  });

  it("cleans acl_events, handle_rights_current, disclosed_amounts, operators in one tx", async () => {
    await reset();
    await seedAclEventAt(5);
    await seedAclEventAt(11);
    await seedHandleRightAt(5, 0x11);
    await seedHandleRightAt(11, 0x22);
    await fx.sql`
      INSERT INTO app.disclosed_amounts (handle, amount, block, tx_hash, log_index)
      VALUES (${("0x" + "dd".repeat(32)) as `0x${string}`}, 100, 11, ${("0x" + "ee".repeat(32)) as `0x${string}`}, 0)`;
    await fx.sql`
      INSERT INTO app.operators (holder, operator, until_ts, set_at_block)
      VALUES (${ALICE}, ${BOB}, 9999999999, 11)`;

    const counts = await rollbackAppSchema(fx.sql, 10);
    expect(counts.acl_events).toBe(1);
    expect(counts.handle_rights_current).toBe(1);
    expect(counts.disclosed_amounts).toBe(1);
    expect(counts.operators).toBe(1);

    expect((await fx.sql`SELECT count(*) FROM app.acl_events`)[0]).toMatchObject({ count: "1" });
    expect((await fx.sql`SELECT count(*) FROM app.handle_rights_current`)[0]).toMatchObject({ count: "1" });
  });

  it("marks balances stale (does not delete) — balance-refresh re-fetches authoritative value", async () => {
    await reset();
    await fx.sql`
      INSERT INTO app.balances (addr, cleartext_amount, source, stale, updated_at_block)
      VALUES
        (${ALICE}, '100', 'decrypted', FALSE, 5),
        (${BOB}, '200', 'decrypted', FALSE, 12),
        (${"0xfFffFffFfFffFffFFfFFFFffFfFFffFFffFFffFf"}, NULL, 'never_shielded', FALSE, NULL)`;

    const counts = await rollbackAppSchema(fx.sql, 10);
    // BOB (block 12) marked stale; null-updated-at also marked (defensive — possibly fresh)
    expect(counts.balances_marked_stale).toBe(2);

    const rows = await fx.sql<{ addr: string; stale: boolean }[]>`
      SELECT addr, stale FROM app.balances ORDER BY addr`;
    const aliceRow = rows.find((r) => r.addr === ALICE);
    const bobRow = rows.find((r) => r.addr === BOB);
    expect(aliceRow?.stale).toBe(false);     // block 5 ≤ 10 → untouched
    expect(bobRow?.stale).toBe(true);
  });

  it("preserves app.signers, app.nats_events, app.indexer_state (off-chain state)", async () => {
    await reset();
    await fx.sql`
      INSERT INTO app.signers (addr, kind, config, cost_rank, enabled)
      VALUES (${ALICE}, 'local_eoa', '{}'::jsonb, 1, TRUE)`;
    await fx.sql`
      INSERT INTO app.nats_events (kind, subject, payload)
      VALUES ('msg_naked', 'test', '{}'::jsonb)`;
    // indexer_state seeded by migration with id=1
    await rollbackAppSchema(fx.sql, 0);

    const signers = await fx.sql<{ count: string }[]>`SELECT COUNT(*) FROM app.signers`;
    const events = await fx.sql<{ count: string }[]>`SELECT COUNT(*) FROM app.nats_events`;
    const states = await fx.sql<{ count: string }[]>`SELECT COUNT(*) FROM app.indexer_state`;
    expect(Number(signers[0]!.count)).toBe(1);
    expect(Number(events[0]!.count)).toBe(1);
    expect(Number(states[0]!.count)).toBe(1);
  });

  it("is idempotent — second call with same rollbackToBlock is a no-op", async () => {
    await reset();
    await seedTransferAt(5);
    await seedTransferAt(12);
    const first = await rollbackAppSchema(fx.sql, 7);
    const second = await rollbackAppSchema(fx.sql, 7);
    expect(first.transfers).toBe(1);
    expect(second.transfers).toBe(0);
  });

  it("rollbackToBlock=0 wipes ALL chain-derived state (full resync)", async () => {
    await reset();
    await seedTransferAt(1);
    await seedTransferAt(5);
    await seedAclEventAt(3);
    await seedHandleRightAt(2);
    const counts = await rollbackAppSchema(fx.sql, 0);
    expect(counts.transfers).toBe(2);
    expect(counts.acl_events).toBe(1);
    expect(counts.handle_rights_current).toBe(1);
  });

  it("delegations_current: respects last_changed_block, not delegation_counter", async () => {
    await reset();
    await fx.sql`
      INSERT INTO app.delegations_current
        (delegator, delegatee, target_contract, expiration_ts, delegation_counter,
         last_changed_block, last_changed_log_index)
      VALUES
        (${ALICE}, ${BOB}, ${TOKEN}, 9999999999, 1, 5, 0),
        (${BOB}, ${ALICE}, ${TOKEN}, 9999999999, 1, 11, 0)`;
    const counts = await rollbackAppSchema(fx.sql, 10);
    expect(counts.delegations_current).toBe(1);
    const rows = await fx.sql<{ delegator: string }[]>`SELECT delegator FROM app.delegations_current`;
    expect(rows.map((r) => r.delegator)).toEqual([ALICE]);
  });
});
