import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, type PgFixture } from "../helpers/pg-fixture.js";
import {
  pickSignerForTransfer,
  insertTransfer,
  recordTransferAttempt,
  markTransferReassigned,
  markTransferTerminallyFailed,
} from "../../src/repositories/queries.js";
import { normAddr, normHandle, type Address, type Hex32 } from "../../src/util/hex.js";

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE TEST: relayer retry / escalation lifecycle
//
// What we test (and why this one was picked):
//   The brief asks for ONE negative test of our choice. We picked the
//   relayer-flaky → escalator-cycles-signers lifecycle because it directly
//   exercises the indexer's lifecycle judgment: "events must not be silently
//   dropped" + "external service unavailable" + "redundancy across signers".
//
//   Mocking userDecrypt at module level requires the full @zama-fhe/sdk
//   integration, which only works against a live forge-fhevm node. Instead,
//   we simulate the lifecycle deterministically by driving the same state
//   transitions the worker + escalator would drive on real failure:
//
//     1. handler picks cheap signer  → ready, assigned=cheap
//     2. cheap fails N times         → status stays ready, attempts grows
//     3. escalator re-elects to mid  → ready, assigned=mid, tried=[cheap]
//     4. mid fails N times           → attempts++
//     5. escalator re-elects pricey  → ready, assigned=pricey, tried=[cheap,mid]
//     6. pricey fails                → no alternatives → status=failed
//
//   Properties asserted: (a) zero duplicate inserts, (b) every escalation
//   produces a strictly larger tried_signers set, (c) terminal `failed` state
//   when all eligible signers exhausted, (d) tried_signers history preserved.
// ─────────────────────────────────────────────────────────────────────────────

const CHEAP  = normAddr("0xAAaa1111111111111111111111111111111111A1");
const MID    = normAddr("0xBBbb2222222222222222222222222222222222B2");
const PRICEY = normAddr("0xCCcc3333333333333333333333333333333333C3");
const EXTERN = normAddr("0xDDdd4444444444444444444444444444444444D4");
const TOKEN  = normAddr("0xFFff6666666666666666666666666666666666F6");
const H: Hex32 = normHandle("0x" + "ad".repeat(32));
const TX = normHandle("0x" + "be".repeat(32));

let fx: PgFixture;

beforeAll(async () => {
  fx = await startPg();
}, 120_000);
afterAll(async () => {
  await fx?.shutdown();
});

async function seed() {
  await fx.sql`TRUNCATE app.transfers, app.handle_rights_current, app.delegations_current, app.signers, app.disclosed_amounts, app.balances RESTART IDENTITY`;
  await fx.sql`
    INSERT INTO app.signers (addr, kind, config, cost_rank, enabled) VALUES
      (${CHEAP},  'local_eoa', ${JSON.stringify({})}, 1,   TRUE),
      (${MID},    'local_eoa', ${JSON.stringify({})}, 50,  TRUE),
      (${PRICEY}, 'local_eoa', ${JSON.stringify({})}, 100, TRUE)
  `;
  // ConfidentialTransfer where all three signers are eligible (use as from/to/contract-aware setup)
  await fx.sql`
    INSERT INTO app.handle_rights_current (handle, account, granted_at_block, granted_at_log_index) VALUES
      (${H}, ${CHEAP},  1, 0),
      (${H}, ${MID},    1, 1),
      (${H}, ${PRICEY}, 1, 2)
  `;
}

describe("relayer-retry → escalator lifecycle (negative)", () => {
  it("cycles cheapest → mid → pricey → failed, with tried_signers preserved", async () => {
    await seed();

    // 1. Handler-time pick: cheap is cheapest qualified.
    const initial = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: EXTERN, handle: H, contract: TOKEN, excluded: [],
    });
    expect(initial).toBe(CHEAP);

    const rowId = await insertTransfer(fx.sql, {
      block: 5, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: EXTERN, handle: H,
      status: "ready", assigned_signer: initial,
    });

    // 2. Simulate 3 worker attempts that fail with retryable errors (relayer 503).
    await recordTransferAttempt(fx.sql, rowId, "RelayerRequestFailedError: 503");
    await recordTransferAttempt(fx.sql, rowId, "RelayerRequestFailedError: 503");
    await recordTransferAttempt(fx.sql, rowId, "RelayerRequestFailedError: 503");

    // 3. max_deliver exhausted → escalator fires. Pick next cheapest, exclude cheap.
    const triedAfterCheap = [CHEAP];
    const next1 = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: EXTERN, handle: H, contract: TOKEN, excluded: triedAfterCheap,
    });
    expect(next1).toBe(MID);
    await markTransferReassigned(fx.sql, rowId, next1!, triedAfterCheap);

    // Verify state after first re-election
    let [row] = await fx.sql<{ assigned_signer: string; tried_signers: string[]; status: string; attempts: number; last_error?: string }[]>`
      SELECT assigned_signer, tried_signers, status, attempts FROM app.transfers WHERE id=${rowId}`;
    expect(row).toMatchObject({
      assigned_signer: MID,
      tried_signers: [CHEAP],
      status: "ready",
      attempts: 0,
    });

    // 4. Mid fails N times.
    await recordTransferAttempt(fx.sql, rowId, "RelayerRequestFailedError: 503");
    await recordTransferAttempt(fx.sql, rowId, "RelayerRequestFailedError: 503");

    // 5. Escalator fires again → pricey.
    const triedAfterMid = [...triedAfterCheap, MID];
    const next2 = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: EXTERN, handle: H, contract: TOKEN, excluded: triedAfterMid,
    });
    expect(next2).toBe(PRICEY);
    await markTransferReassigned(fx.sql, rowId, next2!, triedAfterMid);

    [row] = await fx.sql<{ assigned_signer: string; tried_signers: string[]; status: string; attempts: number; last_error?: string }[]>`
      SELECT assigned_signer, tried_signers, status, attempts FROM app.transfers WHERE id=${rowId}`;
    expect(row).toMatchObject({
      assigned_signer: PRICEY,
      tried_signers: [CHEAP, MID],
      status: "ready",
    });

    // 6. Pricey exhausts too.
    await recordTransferAttempt(fx.sql, rowId, "RelayerRequestFailedError: 503");

    // 7. Escalator: no alternatives → terminal failed.
    const triedAfterPricey = [...triedAfterMid, PRICEY];
    const next3 = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: EXTERN, handle: H, contract: TOKEN, excluded: triedAfterPricey,
    });
    expect(next3).toBeNull();

    await markTransferTerminallyFailed(fx.sql, rowId, triedAfterPricey, "all_signers_exhausted");

    [row] = await fx.sql<{ assigned_signer: string; tried_signers: string[]; status: string; attempts: number; last_error?: string }[]>`
      SELECT assigned_signer, tried_signers, status, attempts, last_error FROM app.transfers WHERE id=${rowId}`;
    expect(row).toMatchObject({
      status: "failed",
      tried_signers: [CHEAP, MID, PRICEY],
      last_error: "all_signers_exhausted",
    });
  });

  it("never produces duplicate inserts when handler is retried for the same (tx, log_index)", async () => {
    await seed();

    const meta = { block: 7, log_index: 2, tx_hash: TX, contract: TOKEN, from_addr: EXTERN, to_addr: EXTERN, handle: H };
    const id1 = await insertTransfer(fx.sql, { ...meta, status: "ready", assigned_signer: CHEAP });
    const id2 = await insertTransfer(fx.sql, { ...meta, status: "ready", assigned_signer: CHEAP });
    const id3 = await insertTransfer(fx.sql, { ...meta, status: "ready", assigned_signer: CHEAP });

    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
    const counts = await fx.sql<{ count: string }[]>`SELECT COUNT(*) FROM app.transfers WHERE tx_hash=${TX} AND log_index=2`;
    expect(Number(counts[0]!.count)).toBe(1);
  });

  it("indexer head can advance independently of decrypt failures (no blocking)", async () => {
    await seed();

    // Insert transfer 1, mark as ready
    const t1 = await insertTransfer(fx.sql, {
      block: 10, log_index: 0, tx_hash: normHandle("0x" + "11".repeat(32)), contract: TOKEN,
      from_addr: EXTERN, to_addr: EXTERN, handle: H, status: "ready", assigned_signer: CHEAP,
    });
    // Simulate cheap failing — row stays 'ready' with attempts > 0
    await recordTransferAttempt(fx.sql, t1, "transient");

    // Meanwhile a new block lands with a successful transfer — different tx
    const t2 = await insertTransfer(fx.sql, {
      block: 11, log_index: 0, tx_hash: normHandle("0x" + "22".repeat(32)), contract: TOKEN,
      from_addr: EXTERN, to_addr: EXTERN, handle: H, status: "done", assigned_signer: CHEAP,
      cleartext_amount: 100n, cleartext_source: "user_decrypt",
    });

    // Both rows exist independently. The retry-in-flight does NOT block the
    // new insert. This is the load-bearing property: decrypt failures don't
    // stall the indexer head.
    expect(t1).not.toBe(t2);
    const totals = await fx.sql<{ count: string }[]>`SELECT COUNT(*) FROM app.transfers`;
    expect(Number(totals[0]!.count)).toBe(2);
  });
});
