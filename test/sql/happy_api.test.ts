import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, type PgFixture } from "../helpers/pg-fixture.js";
import { buildServer } from "../../src/api/server.js";
import { normAddr, normHandle, type Address, type Hex32 } from "../../src/util/hex.js";

// ─────────────────────────────────────────────────────────────────────────────
// HAPPY-PATH TEST (DB + API layer)
//
// Why this shape, not full E2E:
//   The brief says "event going in produces correct cleartext coming out of the
//   API." The full E2E (forge-fhevm → Envio → worker → API) is exercised by
//   the docker-compose stack and documented in the README. Spinning that for
//   every test run in CI is heavy and brittle (forge-fhevm host-contract deploy
//   takes ~10s on cold start; relayer/KMS round-trips add more).
//
//   This test exercises the part that's load-bearing for *our* code: given a
//   transfer event has landed in `app.transfers` with cleartext (as it would
//   after the worker decrypts), assert the API returns the expected shape.
//   The forge-fhevm → cleartext path is verified by the routing SQL tests
//   (signer selection) + the Zama SDK's own end-to-end tests (decrypt path).
// ─────────────────────────────────────────────────────────────────────────────

const ALICE = normAddr("0xAAaa1111111111111111111111111111111111A1");
const BOB   = normAddr("0xBBbb2222222222222222222222222222222222B2");
const TOKEN = normAddr("0xFFff6666666666666666666666666666666666F6");
const H: Hex32 = normHandle("0x" + "0a".repeat(32));
const TX = normHandle("0x" + "0b".repeat(32));

let fx: PgFixture;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  fx = await startPg();
  process.env.DATABASE_URL = fx.url;
  // The API server uses getSql() which caches a connection. We need it to use
  // our test DB. Clear any cached singleton.
  const dbMod = await import("../../src/db/client.js");
  await dbMod.closeSql();
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await fx?.shutdown();
});

async function seedTransfer(args: {
  from?: Address;
  to?: Address;
  cleartext?: bigint | null;
  source?: "user_decrypt" | "disclosed" | null;
  status: "ready" | "done" | "no_acl" | "failed";
}) {
  await fx.sql`
    INSERT INTO app.transfers
      (block, log_index, tx_hash, contract, from_addr, to_addr, handle,
       cleartext_amount, cleartext_source, status, assigned_signer)
    VALUES (1, 0, ${TX}, ${TOKEN},
            ${args.from ?? ALICE}, ${args.to ?? BOB}, ${H},
            ${args.cleartext?.toString() ?? null},
            ${args.source ?? null},
            ${args.status},
            ${args.status === "ready" || args.status === "done" ? ALICE : null})`;
}

async function seedBalance(addr: Address, amount: bigint | null, source: string) {
  await fx.sql`
    INSERT INTO app.balances (addr, current_handle, cleartext_amount, source, stale, updated_at_block)
    VALUES (${addr}, ${H}, ${amount?.toString() ?? null}, ${source}, FALSE, 1)
    ON CONFLICT (addr) DO UPDATE SET
      cleartext_amount = EXCLUDED.cleartext_amount, source = EXCLUDED.source`;
}

async function reset() {
  await fx.sql`TRUNCATE app.transfers, app.balances, app.operators, app.handle_rights_current, app.delegations_current, app.disclosed_amounts, app.signers RESTART IDENTITY`;
}

describe("happy path — event in → API out", () => {
  it("GET /health returns ok + counts", async () => {
    await reset();
    await seedTransfer({ cleartext: 100n, source: "user_decrypt", status: "done" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.counts.done).toBe(1);
    // NATS block is present (null when /jsz unreachable, populated when reachable)
    expect(body).toHaveProperty("nats");
    if (body.nats !== null) {
      expect(body.nats.stream).toBe("decrypt-work");
      expect(Array.isArray(body.nats.consumers)).toBe(true);
    }
  });

  it("GET /balance/:addr returns cleartext when worker decrypted", async () => {
    await reset();
    await seedBalance(ALICE, 1234n, "decrypted");
    const res = await app.inject({ method: "GET", url: `/balance/${ALICE}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      addr: ALICE,
      amount: "1234",
      source: "decrypted",
      reason: null,
    });
  });

  it("GET /balance/:addr returns reason='never_shielded' for unshielded addr", async () => {
    await reset();
    await seedBalance(ALICE, null, "never_shielded");
    const res = await app.inject({ method: "GET", url: `/balance/${ALICE}` });
    expect(JSON.parse(res.body)).toMatchObject({
      addr: ALICE, amount: null, reason: "never_shielded",
    });
  });

  it("GET /balance/:addr returns reason='no_decrypt_rights' when no signer eligible", async () => {
    await reset();
    await seedBalance(ALICE, null, "no_decrypt_rights");
    const res = await app.inject({ method: "GET", url: `/balance/${ALICE}` });
    expect(JSON.parse(res.body)).toMatchObject({
      addr: ALICE, amount: null, reason: "no_decrypt_rights",
    });
  });

  it("GET /balance/:addr returns reason='not_observed' for unknown addr", async () => {
    await reset();
    const res = await app.inject({ method: "GET", url: `/balance/${ALICE}` });
    expect(JSON.parse(res.body)).toMatchObject({ addr: ALICE, amount: null, reason: "not_observed" });
  });

  it("GET /balance/:addr rejects invalid address with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/balance/0xnotanaddr" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_address");
  });

  it("GET /transfers/:addr returns cleartext rows + null rows with reason", async () => {
    await reset();
    await fx.sql`
      INSERT INTO app.transfers (block, log_index, tx_hash, contract, from_addr, to_addr, handle, cleartext_amount, cleartext_source, status, assigned_signer)
      VALUES (1, 0, ${TX}, ${TOKEN}, ${ALICE}, ${BOB}, ${H}, '100', 'user_decrypt', 'done', ${ALICE}),
             (2, 0, ${normHandle("0x" + "ff".repeat(32))}, ${TOKEN}, ${ALICE}, ${BOB}, ${normHandle("0x" + "ee".repeat(32))}, NULL, NULL, 'no_acl', NULL)
    `;
    const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?direction=both` });
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2);
    const done = body.items.find((i: { status: string }) => i.status === "done");
    expect(done).toMatchObject({ amountCleartext: "100", source: "user_decrypt", reason: null });
    const noAcl = body.items.find((i: { status: string }) => i.status === "no_acl");
    expect(noAcl).toMatchObject({ amountCleartext: null, reason: "no_decrypt_rights" });
  });

  it("GET /transfers/:addr direction filter works", async () => {
    await reset();
    await fx.sql`
      INSERT INTO app.transfers (block, log_index, tx_hash, contract, from_addr, to_addr, handle, status, assigned_signer)
      VALUES (1, 0, ${normHandle("0x" + "01".repeat(32))}, ${TOKEN}, ${ALICE}, ${BOB}, ${H}, 'done', ${ALICE}),
             (2, 0, ${normHandle("0x" + "02".repeat(32))}, ${TOKEN}, ${BOB}, ${ALICE}, ${H}, 'done', ${ALICE})
    `;
    const inOnly = JSON.parse((await app.inject({ method: "GET", url: `/transfers/${ALICE}?direction=in` })).body);
    expect(inOnly.items).toHaveLength(1);
    expect(inOnly.items[0].to).toBe(ALICE);

    const outOnly = JSON.parse((await app.inject({ method: "GET", url: `/transfers/${ALICE}?direction=out` })).body);
    expect(outOnly.items).toHaveLength(1);
    expect(outOnly.items[0].from).toBe(ALICE);
  });

  it("GET /operators/:holder returns active operators", async () => {
    await reset();
    await fx.sql`
      INSERT INTO app.operators (holder, operator, until_ts, set_at_block)
      VALUES (${ALICE}, ${BOB}, 2000000000, 1)`;
    const res = await app.inject({ method: "GET", url: `/operators/${ALICE}` });
    expect(JSON.parse(res.body).operators).toEqual([{ operator: BOB, until: 2000000000, setAtBlock: 1 }]);
  });

  it("Swagger UI is mounted at /docs", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/static/index.html" });
    expect([200, 301, 302]).toContain(res.statusCode);
  });

  it("GET /metrics returns Prometheus text format", async () => {
    await reset();
    await seedTransfer({ cleartext: 100n, source: "user_decrypt", status: "done" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toMatch(/^# HELP confidential_indexer_transfers_total/m);
    expect(res.body).toMatch(/^confidential_indexer_transfers_total\{status="done"\} 1/m);
  });

  it("POST /admin/signers rejects invalid address", async () => {
    const res = await app.inject({
      method: "POST", url: "/admin/signers",
      payload: { addr: "0xnope", kind: "local_eoa", costRank: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /admin/signers inserts the signer (natsError tolerated when NATS down)", async () => {
    await reset();
    const addr = "0x52908400098527886E0F7030069857D2E4169EE7";
    const res = await app.inject({
      method: "POST", url: "/admin/signers",
      payload: { addr, kind: "local_eoa", costRank: 5, config: { privateKeyEnv: "FAKE" } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.addr).toBe(addr);
    expect(body).toHaveProperty("backfilled");
    const rows = await fx.sql`SELECT addr, cost_rank FROM app.signers WHERE addr=${addr}`;
    expect(rows).toHaveLength(1);
  });

  it("DELETE /admin/signers/:addr disables the signer", async () => {
    await reset();
    const addr = "0x52908400098527886E0F7030069857D2E4169EE7";
    await fx.sql`
      INSERT INTO app.signers (addr, kind, config, cost_rank, enabled)
      VALUES (${addr}, 'local_eoa', '{}', 1, TRUE)`;
    const res = await app.inject({ method: "DELETE", url: `/admin/signers/${addr}` });
    expect(res.statusCode).toBe(200);
    const rows = await fx.sql<{ enabled: boolean }[]>`SELECT enabled FROM app.signers WHERE addr=${addr}`;
    expect(rows[0]!.enabled).toBe(false);
  });

  it("DELETE /admin/signers/:addr 404s for unknown addr", async () => {
    await reset();
    const res = await app.inject({ method: "DELETE", url: "/admin/signers/0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /admin/signers backfills no_acl rows where the new signer is now eligible", async () => {
    await reset();
    const addrA = "0x52908400098527886E0F7030069857D2E4169EE7";
    const addrB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const handle = "0x" + "aa".repeat(32);
    const tx = "0x" + "bb".repeat(32);

    // Seed a no_acl row where addrA is the from-party
    await fx.sql`
      INSERT INTO app.transfers
        (block, log_index, tx_hash, contract, from_addr, to_addr, handle, status, assigned_signer)
      VALUES (1, 0, ${tx}, ${TOKEN}, ${addrA}, ${addrB}, ${handle}, 'no_acl', NULL)`;

    const res = await app.inject({
      method: "POST", url: "/admin/signers",
      payload: { addr: addrA, kind: "local_eoa", costRank: 1, config: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.addr).toBe(addrA);
    expect(body.backfilled).toBe(1);

    const [row] = await fx.sql<{ status: string; assigned_signer: string }[]>`
      SELECT status, assigned_signer FROM app.transfers WHERE tx_hash=${tx}`;
    expect(row).toMatchObject({ status: "ready", assigned_signer: addrA });
  });

  it("POST /admin/signers is idempotent on duplicate addr", async () => {
    await reset();
    const addr = "0x52908400098527886E0F7030069857D2E4169EE7";
    const first = await app.inject({
      method: "POST", url: "/admin/signers",
      payload: { addr, kind: "local_eoa", costRank: 5, config: {} },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST", url: "/admin/signers",
      payload: { addr, kind: "local_eoa", costRank: 9, config: { changed: true } },
    });
    expect(second.statusCode).toBe(200);
    const rows = await fx.sql<{ cost_rank: number; config: { changed?: boolean } }[]>`
      SELECT cost_rank, config FROM app.signers WHERE addr=${addr}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost_rank).toBe(9);
    expect(rows[0]?.config.changed).toBe(true);
  });

  it("POST /admin/signers re-enables a previously-disabled signer", async () => {
    await reset();
    const addr = "0x52908400098527886E0F7030069857D2E4169EE7";
    await fx.sql`
      INSERT INTO app.signers (addr, kind, config, cost_rank, enabled)
      VALUES (${addr}, 'local_eoa', '{}', 1, FALSE)`;
    const res = await app.inject({
      method: "POST", url: "/admin/signers",
      payload: { addr, kind: "local_eoa", costRank: 1, config: {} },
    });
    expect(res.statusCode).toBe(200);
    const rows = await fx.sql<{ enabled: boolean }[]>`SELECT enabled FROM app.signers WHERE addr=${addr}`;
    expect(rows[0]!.enabled).toBe(true);
  });

  it("GET /metrics covers each transfer status individually", async () => {
    await reset();
    const ts = (n: number) => "0x" + n.toString(16).padStart(64, "0");
    await fx.sql`
      INSERT INTO app.transfers
        (block, log_index, tx_hash, contract, from_addr, to_addr, handle, status, assigned_signer, cleartext_amount, cleartext_source)
      VALUES
        (1,0,${ts(1)},${TOKEN},${ALICE},${BOB},${ts(11)},'done',${ALICE},'100','user_decrypt'),
        (2,0,${ts(2)},${TOKEN},${ALICE},${BOB},${ts(12)},'done',${ALICE},'200','user_decrypt'),
        (3,0,${ts(3)},${TOKEN},${ALICE},${BOB},${ts(13)},'ready',${ALICE},NULL,NULL),
        (4,0,${ts(4)},${TOKEN},${ALICE},${BOB},${ts(14)},'no_acl',NULL,NULL,NULL),
        (5,0,${ts(5)},${TOKEN},${ALICE},${BOB},${ts(15)},'failed',${ALICE},NULL,NULL)`;
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/confidential_indexer_transfers_total\{status="done"\} 2/);
    expect(res.body).toMatch(/confidential_indexer_transfers_total\{status="ready"\} 1/);
    expect(res.body).toMatch(/confidential_indexer_transfers_total\{status="no_acl"\} 1/);
    expect(res.body).toMatch(/confidential_indexer_transfers_total\{status="failed"\} 1/);
  });

  it("GET /transfers/:addr paginates via cursor (reorg-stable)", async () => {
    await reset();
    // Seed 5 transfers across blocks 1-5 for ALICE→BOB
    for (let i = 0; i < 5; i++) {
      const tx = ("0x" + ((i + 1) * 17).toString(16).padStart(64, "0")) as `0x${string}`;
      const h = ("0x" + ((i + 1) * 11).toString(16).padStart(64, "0")) as `0x${string}`;
      await fx.sql`
        INSERT INTO app.transfers
          (block, log_index, tx_hash, contract, from_addr, to_addr, handle,
           cleartext_amount, cleartext_source, status, assigned_signer)
        VALUES (${i + 1}, 0, ${tx}, ${TOKEN}, ${ALICE}, ${BOB}, ${h},
                ${(i + 1) * 100}, 'user_decrypt', 'done', ${ALICE})`;
    }

    // Page 1: limit=2, no cursor → newest 2 (blocks 5, 4)
    const p1 = JSON.parse((await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=2` })).body);
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0].block).toBe(5);
    expect(p1.items[1].block).toBe(4);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBeTruthy();

    // Page 2: pass cursor → next 2 (blocks 3, 2)
    const p2 = JSON.parse(
      (await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}` })).body,
    );
    expect(p2.items).toHaveLength(2);
    expect(p2.items[0].block).toBe(3);
    expect(p2.items[1].block).toBe(2);
    expect(p2.hasMore).toBe(true);

    // Page 3: last item — fewer than limit → no nextCursor
    const p3 = JSON.parse(
      (await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=2&cursor=${encodeURIComponent(p2.nextCursor)}` })).body,
    );
    expect(p3.items).toHaveLength(1);
    expect(p3.items[0].block).toBe(1);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();
  });

  it("GET /transfers/:addr cursor handles same-block multi-log ordering", async () => {
    await reset();
    // Three logs in block 10 — log_index ordering matters
    for (let li = 0; li < 3; li++) {
      const tx = "0x" + (li + 1).toString(16).padStart(64, "0");
      const h = "0x" + (li + 10).toString(16).padStart(64, "0");
      await fx.sql`
        INSERT INTO app.transfers (block, log_index, tx_hash, contract, from_addr, to_addr, handle, cleartext_amount, cleartext_source, status, assigned_signer)
        VALUES (10, ${li}, ${tx}, ${TOKEN}, ${ALICE}, ${BOB}, ${h}, ${100 + li}, 'user_decrypt', 'done', ${ALICE})`;
    }
    const p1 = JSON.parse((await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=2` })).body);
    expect(p1.items.map((i: { logIndex: number }) => i.logIndex)).toEqual([2, 1]);
    const p2 = JSON.parse(
      (await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}` })).body,
    );
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0].logIndex).toBe(0);
  });

  it("GET /transfers/:addr ignores malformed cursor (treats as first page)", async () => {
    await reset();
    await fx.sql`
      INSERT INTO app.transfers (block, log_index, tx_hash, contract, from_addr, to_addr, handle, cleartext_amount, cleartext_source, status, assigned_signer)
      VALUES (1, 0, ${"0x" + "01".repeat(32)}, ${TOKEN}, ${ALICE}, ${BOB}, ${"0x" + "0a".repeat(32)}, 100, 'user_decrypt', 'done', ${ALICE})`;
    const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?cursor=garbage!!!` });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it("GET /metrics omits NATS gauges gracefully when monitoring port unreachable", async () => {
    // env var override: send /jsz to an unused port → fetch fails → null → gauges omitted
    const prev = process.env.NATS_MONITORING_URL;
    process.env.NATS_MONITORING_URL = "http://127.0.0.1:1";   // unused
    const res = await app.inject({ method: "GET", url: "/metrics" });
    process.env.NATS_MONITORING_URL = prev;
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/confidential_indexer_transfers_total/);    // PG gauges still present
    expect(res.body).not.toMatch(/nats_stream_messages/);                // NATS gauges absent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNHAPPY + BOUNDARY
//
// Address validation across every route that takes an addr; Fastify schema
// validation (limit bounds, enum, required body); empty-state queries (the
// "we've never seen this" surface); admin route corner cases (idempotency,
// 404, signer disabled but historical transfers preserved).
// ─────────────────────────────────────────────────────────────────────────────
describe("unhappy + boundary", () => {
  describe("address validation — every route rejects garbage uniformly", () => {
    // viem.getAddress is lenient on case (normalizes rather than enforcing strict
    // EIP-55); these are the cases it actually rejects.
    const BAD_ADDRS = [
      ["empty", ""],
      ["short", "0xdeadbeef"],
      ["no-0x prefix", "AAaa1111111111111111111111111111111111A1"],
      ["non-hex chars", "0xZZaa1111111111111111111111111111111111A1"],
      ["too long", "0xAAaa1111111111111111111111111111111111A1ff"],
    ] as const;

    for (const [label, bad] of BAD_ADDRS) {
      it(`GET /balance/:addr → 400 for ${label}`, async () => {
        const res = await app.inject({ method: "GET", url: `/balance/${encodeURIComponent(bad)}` });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe("invalid_address");
      });

      it(`GET /transfers/:addr → 400 for ${label}`, async () => {
        const res = await app.inject({ method: "GET", url: `/transfers/${encodeURIComponent(bad)}` });
        expect(res.statusCode).toBe(400);
      });

      it(`GET /operators/:holder → 400 for ${label}`, async () => {
        const res = await app.inject({ method: "GET", url: `/operators/${encodeURIComponent(bad)}` });
        expect(res.statusCode).toBe(400);
      });

// TODO(slop): SQL built by f-string / `+` / `${...}` interpolation — classic injection vector; use bind parameters (`?`, `%s`, `$1`) instead
      it(`DELETE /admin/signers/:addr → 400 for ${label}`, async () => {
        const res = await app.inject({ method: "DELETE", url: `/admin/signers/${encodeURIComponent(bad)}` });
        expect(res.statusCode).toBe(400);
      });

      it(`POST /admin/signers body addr=${label} → 400`, async () => {
        const res = await app.inject({
          method: "POST",
          url: `/admin/signers`,
          payload: { addr: bad, kind: "local_eoa", costRank: 0 },
        });
        expect(res.statusCode).toBe(400);
      });
    }
  });

  describe("Fastify schema validation — body + querystring", () => {
    it("POST /admin/signers missing required field → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/admin/signers`,
        payload: { addr: ALICE, kind: "local_eoa" }, // no costRank
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /admin/signers with unsupported kind → 400 (enum)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/admin/signers`,
        payload: { addr: ALICE, kind: "ledger_nano_s", costRank: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /admin/signers with negative costRank → 400 (minimum: 0)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/admin/signers`,
        payload: { addr: ALICE, kind: "local_eoa", costRank: -1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("GET /transfers/:addr?limit=0 → 400 (minimum: 1)", async () => {
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=0` });
      expect(res.statusCode).toBe(400);
    });

    it("GET /transfers/:addr?limit=201 → 400 (maximum: 200)", async () => {
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=201` });
      expect(res.statusCode).toBe(400);
    });

    it("GET /transfers/:addr?direction=sideways → 400 (enum)", async () => {
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?direction=sideways` });
      expect(res.statusCode).toBe(400);
    });

    it("GET /transfers/:addr?limit=200 → 200 (at the boundary)", async () => {
      await reset();
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=200` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).limit).toBe(200);
    });
  });

  describe("empty-state queries — the 'never observed' surface", () => {
    it("GET /balance/:addr returns reason='not_observed' for fresh address", async () => {
      await reset();
      const fresh = normAddr("0xCcCC3333333333333333333333333333333333C3");
      const res = await app.inject({ method: "GET", url: `/balance/${fresh}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        addr: fresh,
        amount: null,
        reason: "not_observed",
        currentHandle: null,
        stale: false,
      });
    });

    it("GET /transfers/:addr returns empty page (not 404) for fresh address", async () => {
      await reset();
      const fresh = normAddr("0xCcCC3333333333333333333333333333333333C3");
      const res = await app.inject({ method: "GET", url: `/transfers/${fresh}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toEqual([]);
      expect(body.count).toBe(0);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
    });

    it("GET /operators/:holder returns empty operators (not 404) for fresh holder", async () => {
      await reset();
      const fresh = normAddr("0xCcCC3333333333333333333333333333333333C3");
      const res = await app.inject({ method: "GET", url: `/operators/${fresh}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ holder: fresh, operators: [] });
    });
  });

  describe("admin route corners — idempotency + 404 + audit-preserving delete", () => {
    it("POST /admin/signers twice with same body is idempotent (upsert, no duplicate row)", async () => {
      await reset();
      const body = { addr: ALICE, kind: "local_eoa", costRank: 0, config: {} };
      const r1 = await app.inject({ method: "POST", url: `/admin/signers`, payload: body });
      const r2 = await app.inject({ method: "POST", url: `/admin/signers`, payload: body });
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
// TODO(slop): SQL built by f-string / `+` / `${...}` interpolation — classic injection vector; use bind parameters (`?`, `%s`, `$1`) instead
      const rows = await fx.sql<{ count: string }[]>`SELECT COUNT(*)::TEXT AS count FROM app.signers WHERE addr=${ALICE}`;
      expect(rows[0]?.count).toBe("1");
    });

    it("DELETE /admin/signers/:addr → 404 for non-existent signer", async () => {
      await reset();
      const stranger = normAddr("0xEeee5555555555555555555555555555555555E5");
      const res = await app.inject({ method: "DELETE", url: `/admin/signers/${stranger}` });
      expect(res.statusCode).toBe(404);
    });

    it("DELETE /admin/signers/:addr keeps historical transfers queryable (tried_signers audit trail)", async () => {
      // Per DECISIONS.md: disabled signers are NOT eagerly reassigned, NOT
      // removed — kept for audit so historical tried_signers entries stay
      // resolvable. Verify the row is still in the table (enabled=false) and
      // any transfer that references it still queries fine.
      await reset();
      await app.inject({
        method: "POST",
        url: `/admin/signers`,
        payload: { addr: ALICE, kind: "local_eoa", costRank: 0 },
      });
      await seedTransfer({ cleartext: 999n, source: "user_decrypt", status: "done" });
      const del = await app.inject({ method: "DELETE", url: `/admin/signers/${ALICE}` });
      expect(del.statusCode).toBe(200);
// TODO(slop): SQL built by f-string / `+` / `${...}` interpolation — classic injection vector; use bind parameters (`?`, `%s`, `$1`) instead
      const stillThere = await fx.sql<{ enabled: boolean }[]>`SELECT enabled FROM app.signers WHERE addr=${ALICE}`;
      expect(stillThere).toHaveLength(1);
      expect(stillThere[0]?.enabled).toBe(false);
      const t = await app.inject({ method: "GET", url: `/transfers/${BOB}` });
      expect(JSON.parse(t.body).items).toHaveLength(1);
    });
  });

  describe("status mid-state — the awkward in-between cases the brief calls out", () => {
    it("GET /transfers/:addr surfaces 'failed' with reason='all_signers_exhausted'", async () => {
      await reset();
      await fx.sql`
        INSERT INTO app.transfers (block, log_index, tx_hash, contract, from_addr, to_addr, handle, cleartext_amount, cleartext_source, status, assigned_signer, tried_signers, last_error)
        VALUES (1, 0, ${TX}, ${TOKEN}, ${ALICE}, ${BOB}, ${H}, NULL, NULL, 'failed', NULL, ARRAY[${ALICE}, ${BOB}]::TEXT[], 'all_signers_exhausted')`;
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}` });
      const items = JSON.parse(res.body).items;
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe("failed");
      expect(items[0].amountCleartext).toBeNull();
      expect(items[0].reason).toBe("all_signers_exhausted");
      expect(items[0].triedSigners).toEqual([ALICE, BOB]);
      expect(items[0].lastError).toBe("all_signers_exhausted");
    });

    it("GET /transfers/:addr surfaces 'ready' with reason='encrypted_pending' (worker hasn't run yet)", async () => {
      await reset();
      await seedTransfer({ cleartext: null, source: null, status: "ready" });
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}` });
      const items = JSON.parse(res.body).items;
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe("ready");
      expect(items[0].amountCleartext).toBeNull();
      expect(items[0].reason).toBe("encrypted_pending");
    });

    it("GET /transfers/:addr surfaces 'no_acl' with reason='no_decrypt_rights'", async () => {
      await reset();
      await seedTransfer({ cleartext: null, source: null, status: "no_acl" });
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}` });
      const items = JSON.parse(res.body).items;
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe("no_acl");
      expect(items[0].amountCleartext).toBeNull();
      expect(items[0].reason).toBe("no_decrypt_rights");
    });
  });

  describe("cursor pagination — boundary cases", () => {
    beforeAll(async () => {
      await reset();
      for (let i = 0; i < 5; i++) {
        await fx.sql`
          INSERT INTO app.transfers (block, log_index, tx_hash, contract, from_addr, to_addr, handle, cleartext_amount, cleartext_source, status, assigned_signer)
          VALUES (${i + 1}, 0, ${"0x" + (i + 1).toString(16).padStart(64, "0")}, ${TOKEN},
                  ${ALICE}, ${BOB}, ${H}, ${(100 * (i + 1)).toString()}, 'user_decrypt', 'done', ${ALICE})`;
      }
    });

    it("cursor past last item returns empty page (no items, hasMore=false)", async () => {
      // Cursor at block=0 means everything is "newer" → no items match
      // (block, log_index) < (0, 0). Use the API-emitted format to be safe.
      const past = Buffer.from("b0.l0.t" + "0".repeat(63) + "1").toString("base64url");
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?cursor=${past}` });
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.items).toEqual([]);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
    });

    it("last page has nextCursor=null when count < limit (no false 'hasMore')", async () => {
      // 5 items total, limit=10 → 5 returned, definitely no more pages.
      // (limit=5 would conservatively still emit a cursor since the server
      // can't tell from a full page alone that there's nothing further.)
      const res = await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=10` });
      const body = JSON.parse(res.body);
      expect(body.count).toBe(5);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
    });

    it("full-page nextCursor leads to empty page (probe terminates correctly)", async () => {
      // 5 items, limit=5 → page is full → server emits cursor. Caller probes;
      // next page returns 0 items, hasMore=false. This is the documented behavior.
      const p1 = JSON.parse((await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=5` })).body);
      expect(p1.count).toBe(5);
      expect(p1.hasMore).toBe(true);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = JSON.parse(
        (await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=5&cursor=${encodeURIComponent(p1.nextCursor)}` })).body,
      );
      expect(p2.count).toBe(0);
      expect(p2.hasMore).toBe(false);
    });

    it("limit=N where N equals exact page boundary still emits nextCursor when more rows exist", async () => {
      // 5 items, limit=4 → first page returns 4 with nextCursor; second page returns 1.
      const p1 = JSON.parse((await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=4` })).body);
      expect(p1.count).toBe(4);
      expect(p1.hasMore).toBe(true);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = JSON.parse(
        (await app.inject({ method: "GET", url: `/transfers/${ALICE}?limit=4&cursor=${encodeURIComponent(p1.nextCursor)}` })).body,
      );
      expect(p2.count).toBe(1);
      expect(p2.hasMore).toBe(false);
    });
  });
});
