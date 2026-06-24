import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, type PgFixture } from "../helpers/pg-fixture.js";
import {
  pickSignerForTransfer,
  backfillForNewSigner,
  insertTransfer,
  upsertHandleRight,
  upsertDelegation,
} from "../../src/repositories/queries.js";
import { normAddr, normHandle, type Address, type Hex32 } from "../../src/util/hex.js";

// Deterministic test addresses. EIP-55 checksummed.
const CHEAP   = normAddr("0xAAaa1111111111111111111111111111111111A1");
const MID     = normAddr("0xBBbb2222222222222222222222222222222222B2");
const PRICEY  = normAddr("0xCCcc3333333333333333333333333333333333C3");
const EXTERN  = normAddr("0xDDdd4444444444444444444444444444444444D4");
const DELE    = normAddr("0xEEee5555555555555555555555555555555555E5");
const TOKEN   = normAddr("0xFFff6666666666666666666666666666666666F6");

const H1: Hex32 = normHandle("0x" + "11".repeat(32));
const H2: Hex32 = normHandle("0x" + "22".repeat(32));
const H3: Hex32 = normHandle("0x" + "33".repeat(32));
const TX = normHandle("0x" + "ab".repeat(32));

let fx: PgFixture;

beforeAll(async () => {
  fx = await startPg();
}, 120_000);

afterAll(async () => {
  await fx?.shutdown();
});

async function reset() {
  await fx.sql`TRUNCATE app.transfers, app.handle_rights_current, app.delegations_current, app.signers, app.disclosed_amounts, app.balances RESTART IDENTITY`;
}

async function seedSigners(signers: { addr: Address; cost: number }[]) {
  for (const s of signers) {
    await fx.sql`
      INSERT INTO app.signers (addr, kind, config, cost_rank, enabled)
      VALUES (${s.addr}, 'local_eoa', ${JSON.stringify({})}, ${s.cost}, TRUE)
    `;
  }
}

describe("pickSignerForTransfer — forward picker", () => {
  it("Case 1: from-party is held — picks it (cheapest path)", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }, { addr: PRICEY, cost: 100 }]);
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: CHEAP, to: EXTERN, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBe(CHEAP);
  });

  it("Case 2: to-party is held but cheaper signer exists → still picks cheapest qualified", async () => {
    await reset();
    await seedSigners([{ addr: PRICEY, cost: 100 }, { addr: CHEAP, cost: 1 }]);
    // CHEAP is not a party; only PRICEY (to) is. PRICEY wins by elimination.
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: PRICEY, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBe(PRICEY);
  });

  it("Case 3: both from + to are held → cheapest cost_rank wins", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }, { addr: PRICEY, cost: 100 }]);
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: CHEAP, to: PRICEY, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBe(CHEAP);
  });

  it("Case 4: excluded array removes a signer — next cheapest wins", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }, { addr: PRICEY, cost: 100 }]);
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: CHEAP, to: PRICEY, handle: H1, contract: TOKEN, excluded: [CHEAP],
    });
    expect(chosen).toBe(PRICEY);
  });

  it("Case 5: all qualified signers excluded → null", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }, { addr: PRICEY, cost: 100 }]);
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: CHEAP, to: PRICEY, handle: H1, contract: TOKEN, excluded: [CHEAP, PRICEY],
    });
    expect(chosen).toBeNull();
  });

  it("Case 6: no eligible held signers → null (no_acl)", async () => {
    await reset();
    await seedSigners([{ addr: MID, cost: 50 }]);
    // MID is not party, no grants, no delegations
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: DELE, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBeNull();
  });

  it("Case 7: explicit handle grant via Allowed makes account eligible", async () => {
    await reset();
    await seedSigners([{ addr: MID, cost: 50 }]);
    await upsertHandleRight(fx.sql, { handle: H1, account: MID, block: 1, log_index: 0 });
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: DELE, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBe(MID);
  });

  it("Case 8: delegation makes delegatee eligible (delegator=from)", async () => {
    await reset();
    await seedSigners([{ addr: DELE, cost: 10 }]);
    const future = Math.floor(Date.now() / 1000) + 3600;
    await upsertDelegation(fx.sql, {
      delegator: EXTERN, delegatee: DELE, target_contract: TOKEN,
      expiration_ts: future, delegation_counter: 1, block: 1, log_index: 0,
    });
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: MID, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBe(DELE);
  });

  it("Case 9: expired delegation does not count", async () => {
    await reset();
    await seedSigners([{ addr: DELE, cost: 10 }]);
    const past = Math.floor(Date.now() / 1000) - 1;
    await upsertDelegation(fx.sql, {
      delegator: EXTERN, delegatee: DELE, target_contract: TOKEN,
      expiration_ts: past, delegation_counter: 1, block: 1, log_index: 0,
    });
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: MID, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBeNull();
  });

  it("Case 10: delegation for a different contract does not count", async () => {
    await reset();
    await seedSigners([{ addr: DELE, cost: 10 }]);
    const future = Math.floor(Date.now() / 1000) + 3600;
    const OTHER_TOKEN = normAddr("0x1111111111111111111111111111111111111111");
    await upsertDelegation(fx.sql, {
      delegator: EXTERN, delegatee: DELE, target_contract: OTHER_TOKEN,
      expiration_ts: future, delegation_counter: 1, block: 1, log_index: 0,
    });
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: EXTERN, to: MID, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBeNull();
  });

  it("Case 11: disabled signer ignored", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    await fx.sql`UPDATE app.signers SET enabled=FALSE WHERE addr=${CHEAP}`;
    const chosen = await pickSignerForTransfer(fx.sql, {
      from: CHEAP, to: EXTERN, handle: H1, contract: TOKEN,
    });
    expect(chosen).toBeNull();
  });
});

describe("backfillForNewSigner — inverse query", () => {
  it("Case 12: new signer X added unlocks no_acl rows where X is from", async () => {
    await reset();
    await seedSigners([{ addr: MID, cost: 50 }]);   // some other signer
    // Pre-insert a no_acl row where CHEAP is from (but CHEAP not in signers yet)
    const id = await insertTransfer(fx.sql, {
      block: 5, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: CHEAP, to_addr: EXTERN, handle: H1,
      status: "no_acl", assigned_signer: null,
    });
    // Add CHEAP as new signer, then backfill
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    const updated = await backfillForNewSigner(fx.sql, CHEAP);
    expect(updated.map((r) => r.id)).toContain(id);

    const [row] = await fx.sql`SELECT status, assigned_signer FROM app.transfers WHERE id=${id}`;
    expect(row).toMatchObject({ status: "ready", assigned_signer: CHEAP });
  });

  it("Case 13: backfill ignores rows where new signer is not eligible", async () => {
    await reset();
    await seedSigners([{ addr: MID, cost: 50 }]);
    await insertTransfer(fx.sql, {
      block: 5, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: DELE, handle: H1,
      status: "no_acl", assigned_signer: null,
    });
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    const updated = await backfillForNewSigner(fx.sql, CHEAP);
    expect(updated).toHaveLength(0);
  });

  it("Case 14: ACL grant unlocks via handle_rights_current", async () => {
    await reset();
    await seedSigners([{ addr: MID, cost: 50 }]);
    const id = await insertTransfer(fx.sql, {
      block: 5, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: DELE, handle: H2,
      status: "no_acl", assigned_signer: null,
    });
    // Grant MID rights on H2 via Allowed
    await upsertHandleRight(fx.sql, { handle: H2, account: MID, block: 6, log_index: 0 });
    const updated = await backfillForNewSigner(fx.sql, MID);
    expect(updated.map((r) => r.id)).toContain(id);

    const [row] = await fx.sql`SELECT assigned_signer, tried_signers FROM app.transfers WHERE id=${id}`;
    expect(row).toMatchObject({ assigned_signer: MID, tried_signers: [] });
  });

  it("Case 15: backfill resets tried_signers so it gets a fresh shot", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    const id = await insertTransfer(fx.sql, {
      block: 5, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: DELE, handle: H3,
      status: "no_acl", assigned_signer: null,
    });
    // Simulate a previous fail cycle leaving tried_signers populated
    await fx.sql`UPDATE app.transfers SET tried_signers=ARRAY[${PRICEY}]::TEXT[] WHERE id=${id}`;
    await upsertHandleRight(fx.sql, { handle: H3, account: CHEAP, block: 6, log_index: 0 });
    await backfillForNewSigner(fx.sql, CHEAP);
    const [row] = await fx.sql`SELECT tried_signers FROM app.transfers WHERE id=${id}`;
    expect(row?.tried_signers).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // failed-row recovery — the bug we just fixed.
  //
  // A row that went status='failed' / last_error='all_signers_exhausted' (the
  // escalator's verdict when every signer it tried failed transiently) should
  // recover when a fresh signer is added that holds ACL on the handle. The
  // poison case (last_error LIKE 'poison: %') stays terminal — same handle
  // fails identically for any signer.
  // ─────────────────────────────────────────────────────────────────────────

  it("Case 16: backfill recovers status='failed'+all_signers_exhausted when new signer is eligible", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    const id = await insertTransfer(fx.sql, {
      block: 7, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: DELE, handle: H1,
      status: "no_acl", assigned_signer: null,
    });
    await fx.sql`
      UPDATE app.transfers
      SET status='failed', last_error='all_signers_exhausted',
          tried_signers=ARRAY[${PRICEY}, ${MID}]::TEXT[],
          assigned_signer=${MID}
      WHERE id=${id}`;
    // Now operator adds CHEAP via ACL grant.
    await upsertHandleRight(fx.sql, { handle: H1, account: CHEAP, block: 8, log_index: 0 });
    const recovered = await backfillForNewSigner(fx.sql, CHEAP);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe(id);
    const [row] = await fx.sql<{ status: string; assigned_signer: string; tried_signers: string[]; last_error: string | null; attempts: number }[]>`
      SELECT status, assigned_signer, tried_signers, last_error, attempts FROM app.transfers WHERE id=${id}`;
    expect(row?.status).toBe("ready");
    expect(row?.assigned_signer).toBe(CHEAP);
    expect(row?.last_error).toBeNull();
    expect(row?.attempts).toBe(0);
    // tried_signers PRESERVED — if CHEAP also fails, escalator must not loop
    // back to PRICEY / MID.
    expect(row?.tried_signers).toEqual([PRICEY, MID]);
  });

  it("Case 17: backfill does NOT recover status='failed' when last_error indicates poison", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    const id = await insertTransfer(fx.sql, {
      block: 9, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: DELE, handle: H2,
      status: "no_acl", assigned_signer: null,
    });
    await fx.sql`
      UPDATE app.transfers
      SET status='failed', last_error='poison: INVALID_HANDLE',
          tried_signers=ARRAY[${PRICEY}]::TEXT[]
      WHERE id=${id}`;
    // Even though CHEAP holds ACL, poison handles fail for everyone.
    await upsertHandleRight(fx.sql, { handle: H2, account: CHEAP, block: 10, log_index: 0 });
    const recovered = await backfillForNewSigner(fx.sql, CHEAP);
    expect(recovered).toHaveLength(0);
    const [row] = await fx.sql<{ status: string; last_error: string }[]>`
      SELECT status, last_error FROM app.transfers WHERE id=${id}`;
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toBe("poison: INVALID_HANDLE");
  });

  it("Case 18: backfill does NOT recover a failed row if the new signer is already in tried_signers", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    const id = await insertTransfer(fx.sql, {
      block: 11, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: DELE, handle: H3,
      status: "no_acl", assigned_signer: null,
    });
    await fx.sql`
      UPDATE app.transfers
      SET status='failed', last_error='all_signers_exhausted',
          tried_signers=ARRAY[${CHEAP}, ${MID}]::TEXT[]
      WHERE id=${id}`;
    await upsertHandleRight(fx.sql, { handle: H3, account: CHEAP, block: 12, log_index: 0 });
    // CHEAP was already tried; "adding" it again shouldn't resurrect the row.
    const recovered = await backfillForNewSigner(fx.sql, CHEAP);
    expect(recovered).toHaveLength(0);
  });

  it("Case 19: backfill does NOT recover a failed row when the new signer is not eligible", async () => {
    await reset();
    await seedSigners([{ addr: CHEAP, cost: 1 }]);
    const id = await insertTransfer(fx.sql, {
      block: 13, log_index: 0, tx_hash: TX, contract: TOKEN,
      from_addr: EXTERN, to_addr: DELE, handle: H1,
      status: "no_acl", assigned_signer: null,
    });
    await fx.sql`
      UPDATE app.transfers
      SET status='failed', last_error='all_signers_exhausted',
          tried_signers=ARRAY[${PRICEY}]::TEXT[]
      WHERE id=${id}`;
    // CHEAP is NOT in handle_rights_current for H1, NOT from/to, no delegation.
    const recovered = await backfillForNewSigner(fx.sql, CHEAP);
    expect(recovered).toHaveLength(0);
  });
});
