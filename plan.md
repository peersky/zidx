# Confidential Indexer — Plan

ERC-7984 confidential token indexer. Watches one contract, decrypts amounts the indexer's signers have ACL on, exposes cleartext via REST. Backfills when partners grant decrypt rights later. Built to be small, sharp, defensible in DECISIONS.md.

---

## 1. Stack

| Layer | Pick | Why |
|---|---|---|
| Language | TypeScript / Node | Brief mandates; Zama SDK is TS; avoids subprocess gymnastics |
| Indexer | Envio HyperIndex | Off-the-shelf, generates typed handlers, Postgres backend, free Hasura GQL |
| Bus | NATS JetStream | Native ack/redeliver/backoff/DLQ; predicate-shaped consume via subject filter + `DeliverPolicy: all`; per-signer sharding |
| DB | Postgres (Envio brings it) | Canonical business state. Separate `app.*` schema from Envio's `public.*` — **fallback budget: 30 min**. If schema interop fights, drop to plan B (see §16). |
| HTTP | Fastify + `@fastify/swagger` + `@fastify/swagger-ui` | Fast, schema-validated, JSON-first; auto-generated OpenAPI 3 + Swagger UI at `/docs` |
| FHE SDK | `@zama-fhe/sdk@alpha` (prerelease docs) | Required |
| Test contracts | **forge-fhevm sample contracts** | Built specifically to match SDK protocol state; do NOT port OpenZeppelin in 4hr |
| Chain | forge-fhevm local **only** | Sepolia documented in README, never run in this submission |
| Test runner | Vitest | Light, TS-native, watch mode |
| Package manager | pnpm | Standard in Web3, fast, deterministic |
| Delivery | Docker Compose end-to-end | `docker compose up` → indexer + worker + api + postgres + nats + forge-fhevm node, all ready |

**Single TypeScript repo**, pnpm. Docker Compose brings Postgres + NATS + forge-fhevm + the indexer/worker/api containers.

---

## 2. Architecture

```
                       ┌──────────────────────────┐
                       │       forge-fhevm        │
                       │  (ERC-7984 + FHEVM ACL)  │
                       └────────────┬─────────────┘
                                    │ logs
                                    ▼
                         ┌──────────────────┐
                         │  Envio HyperIndex│   handlers in TS
                         │   (reads chain)  │
                         └────────┬─────────┘
                                  │ writes app.* + publishes 'decrypt.work'
                                  ▼
                 ┌────────────────────────────────┐
                 │   Postgres (canonical state)   │
                 │  app.transfers                 │
                 │  app.acl_events (log)          │
                 │  app.handle_rights_current     │
                 │  app.delegations_current       │
                 │  app.disclosed_amounts         │
                 │  app.operators                 │
                 │  app.balances                  │
                 │  app.signers (config)          │
                 └────────┬───────────────────────┘
                          │ (one publish per ready row)
                          ▼
                 ┌────────────────────────────────┐
                 │       NATS JetStream           │
                 │  stream "decrypt-work"         │
                 │  subjects: decrypt.<addr>      │
                 │  retention: workqueue          │
                 │  replicas: 1 dev / 3 prod      │
                 │  one consumer per signer       │
                 └────────┬───────────────────────┘
                          │ pre-assigned: 1 msg → exactly 1 signer's worker
                          ▼
                 ┌────────────────────────────────┐
                 │  Worker per signer (1 loop ea) │
                 │  • own NATS consumer           │
                 │  • own Signer instance         │
                 │  • own rate limit / backoff    │
                 │  • own DLQ                     │
                 │  1. row = SELECT WHERE         │
                 │     status='ready' &&          │
                 │     assigned_signer=me         │
                 │  2. decryptor.decrypt          │
                 │  3. UPDATE done, ack           │
                 └────────┬───────────────────────┘
                          │
                          ▼
                 ┌────────────────────────────────┐
                 │   Fastify REST + Swagger UI    │
                 │   /balance/:addr               │
                 │   /transfers/:addr             │
                 │   /operators/:holder           │
                 │   /health                      │
                 │   /docs (OpenAPI 3 UI)         │
                 └────────────────────────────────┘
```

**Source-of-truth split:**
- **Postgres**: business state (transfers, ACL, balances, cleartext, signer config). Authoritative.
- **NATS**: dispatch + retry layer. Stateless w.r.t. business correctness.
- **Recovery script**: `tools/rebuild-stream.ts` republishes from PG `transfers` table if NATS volume lost.

---

## 3. Event surface

ERC-7984 contract:
- `ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)` — `amount` is the handle.
- `OperatorSet(address indexed holder, address indexed operator, uint48 until)` — plaintext.
- `AmountDisclosed(bytes32 indexed handle, uint256 amount)` — **fast path to cleartext, no decrypt needed.**

FHEVM ACL system contract (separate subscription):
- `Allowed(bytes32 handle, address account)` (or impl-specific name; resolve from actual ABI)
- `Disallowed(bytes32 handle, address account)` (revocation)
- `NewDelegation(address delegator, address delegatee, address[] contracts)`
- `DelegationRevoked(address delegator, address delegatee, address contract)` (or similar)

Wrapper contract (if ERC-20 ↔ ERC-7984 shield/unshield is in scope):
- `Shield(address account, uint256 amount)` — plaintext public side.
- `Unshield(address account, uint256 amount)` — plaintext public side.
- These pair with `ConfidentialTransfer` + likely `AmountDisclosed` on the confidential side, joined by `tx_hash`.

---

## 4. Schema (`app.*` namespace)

```sql
CREATE SCHEMA app;

-- Hex domain types.
-- Addresses: EIP-55 checksummed at boundary via viem.getAddress(s). Mixed case permitted
--   (CHECK regex allows A-F + a-f); strict checksum verification is application-side.
-- Hex32 (handles, tx hashes): lowercase. No checksum semantics.
CREATE DOMAIN app.address AS VARCHAR(42)
  CHECK (VALUE ~ '^0x[0-9a-fA-F]{40}$');
CREATE DOMAIN app.hex32 AS VARCHAR(66)
  CHECK (VALUE ~ '^0x[0-9a-f]{64}$');

-- Append-only event log: source of truth for ACL state, replayable
CREATE TABLE app.acl_events (
  block BIGINT NOT NULL,
  log_index INT NOT NULL,
  tx_hash app.hex32 NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('allow','disallow','delegate','revoke_delegate')),
  contract app.address NOT NULL,
  handle app.hex32,           -- per-handle events
  account app.address,        -- per-handle events
  delegator app.address,      -- delegation events
  delegatee app.address,      -- delegation events
  PRIMARY KEY (block, log_index)
);

-- Materialized current state (rebuildable from acl_events)
CREATE TABLE app.handle_rights_current (
  handle TEXT NOT NULL,
  account TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  last_changed_block BIGINT NOT NULL,
  last_changed_log_index INT NOT NULL,
  PRIMARY KEY (handle, account)
);
CREATE INDEX ON app.handle_rights_current (account) WHERE active;

CREATE TABLE app.delegations_current (
  delegator TEXT NOT NULL,
  delegatee TEXT NOT NULL,
  contract TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  last_changed_block BIGINT NOT NULL,
  last_changed_log_index INT NOT NULL,
  PRIMARY KEY (delegator, delegatee, contract)
);
CREATE INDEX ON app.delegations_current (delegatee, contract) WHERE active;
CREATE INDEX ON app.delegations_current (delegator, contract) WHERE active;

-- Transfers (the indexer's main output)
CREATE TABLE app.transfers (
  id BIGSERIAL PRIMARY KEY,
  block BIGINT NOT NULL,
  log_index INT NOT NULL,
  tx_hash TEXT NOT NULL,
  contract TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  handle TEXT NOT NULL,
  cleartext_amount NUMERIC,
  cleartext_source TEXT CHECK (cleartext_source IN ('disclosed','user_decrypt')),
  -- 'ready' = enqueued in NATS work queue, worker will pick up
  -- 'done' = cleartext written
  -- 'no_acl' = no eligible signer; awaiting Allowed/NewDelegation event or new signer config
  -- 'failed' = poison after max_deliver exhausted, lives in DLQ
  status TEXT NOT NULL CHECK (status IN ('ready','done','no_acl','failed')),
  assigned_signer TEXT,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX ON app.transfers (from_addr);
CREATE INDEX ON app.transfers (to_addr);
CREATE INDEX ON app.transfers (handle);
CREATE INDEX ON app.transfers (status) WHERE status IN ('pending','no_acl');

-- Free-cleartext path
CREATE TABLE app.disclosed_amounts (
  handle TEXT PRIMARY KEY,
  amount NUMERIC NOT NULL,
  block BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INT NOT NULL
);

-- Operators (plaintext metadata)
CREATE TABLE app.operators (
  holder TEXT NOT NULL,
  operator TEXT NOT NULL,
  until_ts BIGINT NOT NULL,
  set_at_block BIGINT NOT NULL,
  PRIMARY KEY (holder, operator)
);

-- Per-address balance projection (refreshed via handle-read, not sum-of-transfers)
CREATE TABLE app.balances (
  addr TEXT PRIMARY KEY,
  current_handle TEXT,
  cleartext_amount NUMERIC,
  source TEXT CHECK (source IN ('decrypted','disclosed','never_shielded','no_decrypt_rights')),
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at_block BIGINT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Signer config (loaded at startup, mutable via /admin/signers)
CREATE TABLE app.signers (
  addr TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local_eoa','fireblocks','aws_kms','silence_labs','turnkey')),
  config JSONB NOT NULL,    -- provider-specific opaque blob
  cost_rank INT NOT NULL,   -- lower = preferred at signer-selection time
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  added_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON app.signers (cost_rank) WHERE enabled;   -- used by pickSignerForTransfer ORDER BY
```

---

## 4b. Reusable SQL: signer selection (forward + inverse + escalation)

Two indexed SQL queries cover every signer-selection path in the system: initial pick at handler time, re-election after primary fails (one or more times), backfill when new rights/signers appear.

**Forward (unified): `pickSignerForTransfer(from, to, handle, contract, excluded[])` — returns cheapest UNTRIED qualified signer, or null.**

Schema addition for tracking cycle progress:
```sql
ALTER TABLE app.transfers ADD COLUMN tried_signers TEXT[] NOT NULL DEFAULT ARRAY[]::bytea[];
```

```sql
WITH eligible AS (
  SELECT $1::bytea AS addr                                          -- from
  UNION SELECT $2::bytea                                            -- to
  UNION SELECT account FROM app.handle_rights_current
    WHERE handle = $3 AND active                                    -- explicit grants
  UNION SELECT delegatee FROM app.delegations_current
    WHERE delegator IN ($1, $2) AND contract = $4 AND active        -- delegation
)
SELECT s.addr FROM eligible e
JOIN app.signers s ON s.addr = e.addr
WHERE s.enabled
  AND s.addr <> ALL($5::bytea[])              -- exclude already-tried signers
ORDER BY s.cost_rank ASC
LIMIT 1;                                       -- early exit on cheapest untried match
```

**Call sites for the forward query — same SQL, varying `$5`:**

| Caller | `$5` (excluded) | Outcome |
|---|---|---|
| `ConfidentialTransfer.handler` — initial insert | `ARRAY[]::bytea[]` | first cheapest qualified signer |
| MAX_DELIVERIES advisory escalator | `tried_signers ‖ [failedSigner]` | next cheapest untried signer |
| Subsequent escalations | grows monotonically | eventually null → status=`failed` |

**Inverse: `backfillForNewSigner($1 := newSignerAddr)` — flip `no_acl` rows where the just-granted signer qualifies. Returns ids to publish.**
```sql
UPDATE app.transfers t
SET status='ready', assigned_signer=$1, attempts=0, last_error=NULL,
    tried_signers=ARRAY[]::bytea[],            -- reset cycle history; this is a fresh chance
    updated_at=now()
WHERE t.status = 'no_acl'
  AND (
    t.from_addr = $1
    OR t.to_addr = $1
    OR EXISTS (SELECT 1 FROM app.handle_rights_current
               WHERE handle = t.handle AND account = $1 AND active)
    OR EXISTS (SELECT 1 FROM app.delegations_current
               WHERE delegatee = $1 AND active AND contract = t.contract
                 AND delegator IN (t.from_addr, t.to_addr))
  )
RETURNING id;
```

**Three call sites share the inverse query:**
- `POST /admin/signers` — operator adds a new signer.
- `ACL.Allowed.handler` — when granted account is one of our signers.
- `ACL.NewDelegation.handler` — when delegatee is one of our signers.

**Indexes** (added to §4):
```sql
CREATE INDEX ON app.signers (cost_rank) WHERE enabled;
-- handle_rights_current and delegations_current partial indexes declared in §4
```

**Properties:**

1. **One SQL, all signer-selection cases.** Initial pick = empty exclusion; escalation = grow exclusion. No special-case re-election code.
2. **Strict cost-rank ordering preserved across the entire cycle.** Each step picks the next cheapest untried.
3. **No infinite loop.** Exclusion array grows monotonically; when it covers all eligible held signers, query returns null → row marked `failed`.
4. **Audit trail.** `tried_signers` array preserves the cycle history. API exposes `{ status: 'failed', tried_signers: [...], last_error: '...' }` so partner sees what was attempted and why.
5. **Reset on new rights.** When `Allowed`/`NewDelegation` opens a new signer for a row, `tried_signers` resets — the new option deserves a fresh shot, including the previously-failed ones (revoke-then-regrant edge case may have restored their viability). Documented behavior.

**Consistency property for the inverse query's assignment:**
If a row is `no_acl`, no held signer qualified at insert time. When new signer X becomes eligible later, X is the *only* held signer to qualify (otherwise the row wouldn't be `no_acl`). So unconditionally setting `assigned_signer = X` and resetting `tried_signers = []` is correct.

---

## 5. Decryption interface

Signer-shaped, not decryptor-shaped. Address is the universal join key.

```ts
// src/providers/signer.ts
export interface IndexerSigner {
  readonly kind: SignerKind;
  getAddress(): Promise<Address>;
  signTypedData(args: {
    domain: TypedDataDomain;
    types: Record<string, TypedDataField[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

// Concrete impls
export class LocalEoaSigner implements IndexerSigner { /* PRIVATE_KEY env */ }
// Stubs with throw "not implemented":
export class FireblocksSigner implements IndexerSigner {}
export class KmsSigner implements IndexerSigner {}
```

`ZamaDecryptor` built once on top:

```ts
// src/providers/decryptor.ts
export class ZamaDecryptor {
  constructor(private signer: IndexerSigner, private sdk: ZamaSDK) {}
  async decrypt(handles: { handle: Hex; contractAddress: Address }[]): Promise<Map<Hex, bigint>> {
    // 1. build EIP-712 typed data via SDK helper
    // 2. signer.signTypedData(...)
    // 3. sdk.userDecrypt(handles, signature, ...)
    // 4. return cleartext map
  }
}
```

Signers loaded at startup from `app.signers`. Indexed by `addr` for O(1) lookup at enqueue time.

---

## 6. Envio handlers (sketch)

```ts
// envio/src/EventHandlers.ts (HyperIndex generates the registration boilerplate)

ERC7984Contract.ConfidentialTransfer.handler(async ({ event, context }) => {
  const { from, to, amount: handle } = event.params;
  const meta = { block: event.block.number, logIndex: event.logIndex, txHash: event.transaction.hash, contract: event.srcAddress };

  // Disclosed shortcut — free cleartext path
  const disclosed = await context.sql`SELECT amount FROM app.disclosed_amounts WHERE handle = ${handle}`;
  if (disclosed.length) {
    await insertTransferDone(context, { from, to, handle, ...meta, cleartext: disclosed[0].amount, source: 'disclosed' });
    await markBalanceStale(context, [from, to]);
    return;
  }

  // Pre-assign cheapest qualified signer in ONE SQL — no JS-side set ops, no full eligible set materialised
  const [picked] = await context.sql`
    WITH eligible AS (
      SELECT ${from}::bytea AS addr
      UNION SELECT ${to}::bytea
      UNION SELECT account FROM app.handle_rights_current WHERE handle = ${handle} AND active
      UNION SELECT delegatee FROM app.delegations_current
        WHERE delegator IN (${from}, ${to}) AND contract = ${meta.contract} AND active
    )
    SELECT s.addr FROM eligible e
    JOIN app.signers s ON s.addr = e.addr
    WHERE s.enabled
    ORDER BY s.cost_rank ASC
    LIMIT 1`;

  if (!picked) {
    await insertPendingTransfer(context, { from, to, handle, ...meta, status: 'no_acl', assigned_signer: null });
  } else {
    const rowId = await insertPendingTransfer(context, { from, to, handle, ...meta, status: 'ready', assigned_signer: picked.addr });
    await nats.publish(`decrypt.${picked.addr}`, JSON.stringify({ rowId }), { ackWait: 5_000 });
  }
  await markBalanceStale(context, [from, to]);
});

ERC7984Contract.AmountDisclosed.handler(async ({ event, context }) => {
  const { handle, amount } = event.params;
  await context.sql`INSERT INTO app.disclosed_amounts (...) VALUES (...) ON CONFLICT (handle) DO NOTHING`;
  // Backfill: any pending row referencing this handle
  const updated = await context.sql`
    UPDATE app.transfers SET cleartext_amount=${amount}, cleartext_source='disclosed', status='done'
    WHERE handle=${handle} AND cleartext_amount IS NULL RETURNING from_addr, to_addr`;
  await markBalanceStaleBatch(context, updated);
});

ERC7984Contract.OperatorSet.handler(async ({ event, context }) => {
  const { holder, operator, until } = event.params;
  await context.sql`INSERT INTO app.operators (...) ON CONFLICT (holder, operator) DO UPDATE SET until_ts=${until}`;
});

ACLContract.Allowed.handler(async ({ event, context }) => {
  const { handle, account } = event.params;
  await context.sql`INSERT INTO app.acl_events ...`;
  await context.sql`
    INSERT INTO app.handle_rights_current (handle, account, active, last_changed_block, last_changed_log_index)
    VALUES (...) ON CONFLICT (handle, account) DO UPDATE SET active=TRUE, ...`;

  // Backfill: if account is one of our signers, flip matching no_acl rows → ready and publish
  // Reused query: backfillForNewSigner (also used by NewDelegation handler + admin signer-add)
  if (await isOurSigner(context, account)) {
    const rows = await runBackfillForNewSigner(context, account);     // see §4b for SQL
    await Promise.all(rows.map((r) =>
      nats.publish(`decrypt.${account}`, JSON.stringify({ rowId: r.id }), { ackWait: 5_000 })
    ));
  }
});

ACLContract.Disallowed.handler(async ({ event, context }) => { /* set active=false */ });
ACLContract.NewDelegation.handler(...);
ACLContract.DelegationRevoked.handler(...);
```

`computeParties()` returns:

```ts
async function computeParties(ctx, { from, to, handle, contract }) {
  const explicit = await ctx.sql`
    SELECT account FROM app.handle_rights_current WHERE handle=${handle} AND active`;
  const delegates = await ctx.sql`
    SELECT delegatee FROM app.delegations_current
    WHERE active AND contract=${contract} AND delegator IN (${from}, ${to})`;
  return uniq([from, to, ...explicit.map(r => r.account), ...delegates.map(r => r.delegatee)]);
}
```

---

## 7. NATS JetStream config (per-signer subjects, pre-assigned at publish)

```ts
// src/nats/stream.ts
await js.streams.add({
  name: 'decrypt-work',
  subjects: ['decrypt.>'],            // one subject per signer: decrypt.<addr>, decrypt.dlq.<addr>
  retention: 'workqueue',             // ack removes msg
  storage: 'file',
  num_replicas: parseInt(process.env.NATS_REPLICAS ?? '1'),
  duplicate_window: 5 * 60 * 1_000_000_000,
});

// One consumer per signer, created when signer is added to app.signers
async function ensureConsumerForSigner(addr: string) {
  await js.consumers.add('decrypt-work', {
    durable_name: `worker-${addr}`,
    filter_subject: `decrypt.${addr}`,
    ack_policy: 'explicit',
    ack_wait: 30 * 1_000_000_000,
    max_deliver: 5,
    backoff: [1, 5, 30, 300, 3600].map((s) => s * 1_000_000_000),
    max_ack_pending: 32,              // per-signer backpressure
  });
}
```

**Single intended recipient per message — no fan-out:**

Handler pre-assigns signer at publish:
```ts
const eligible = await computeEligibleParties(ctx, { from, to, handle, contract });
const mySigners = await getActiveSignerAddresses(ctx);
const intersect = eligible.filter((a) => mySigners.has(a));

if (intersect.length === 0) {
  await insertTransfer(ctx, { ..., status: 'no_acl' });   // no publish
} else {
  const chosen = pickCheapest(intersect, await getSignerCostRanks(ctx));
  const rowId = await insertTransfer(ctx, { ..., status: 'ready', assigned_signer: chosen });
  await js.publish(`decrypt.${chosen}`, JSON.stringify({ rowId }), { ackWait: 5_000 });
}
```

Each message has exactly one intended consumer (the chosen signer's worker). No N-way duplicate consume. No row-lock dance.

**ACL/delegation backfill: pre-assign at backfill time, publish to chosen subject:**

```ts
ACL.Allowed.handler:
  upsert acl_events + handle_rights_current
  if event.account in my_signers:
    UPDATE transfers SET status='ready', assigned_signer=${event.account}
    WHERE handle=$1 AND status='no_acl' RETURNING id
    Promise.all(ids.map(id =>
      js.publish(`decrypt.${event.account}`, JSON.stringify({ rowId: id }), { ackWait: 5_000 })))
```

**`POST /admin/signers` adds a new signer X:**

1. `INSERT INTO app.signers`.
2. `ensureConsumerForSigner(X)` — creates NATS consumer.
3. Start worker async loop for X.
4. SQL backfill — find no_acl rows where X is now eligible, UPDATE ready + assigned_signer=X, publish to `decrypt.${X}`.

**`DELETE /admin/signers/:addr`:**

1. Drain consumer: stop pulling new messages, wait for in-flight to ack or fail.
2. Reassign any `assigned_signer=removedAddr` `ready` rows: recompute eligible set, pick another signer if available, else status=no_acl.
3. Delete consumer.
4. Remove from `app.signers`.

**Cross-signer escalation via native JetStream advisory event (no manual DLQ publish):**

Worker only emits ack / nak / term. NATS auto-publishes a `MAX_DELIVERIES` advisory when retries exhaust. Escalation listener subscribes to that advisory subject and uses the unified `pickSignerForTransfer` query with growing exclusion array.

```ts
// Worker (signer X) — no DLQ publish, no manual escalation
} catch (err) {
  if (isAclMismatch(err) || isPoison(err)) {
    msg.term();                         // terminal → triggers advisory immediately
  } else {
    msg.nak(backoffFor(msg.info.redeliveryCount));   // retryable; max_deliver eventually triggers advisory
  }
}
```

```ts
// src/worker/escalator.ts — subscribes to native advisory, uses unified picker
const ADV_SUBJECT = '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.decrypt-work.*';

nc.subscribe(ADV_SUBJECT, async (advMsg) => {
  const adv = advMsg.json();              // { stream, consumer, stream_seq, deliveries, ... }
  const failedSigner = adv.consumer.replace('worker-', '');

  const original = await js.streams.getMessage('decrypt-work', { seq: adv.stream_seq });
  const { rowId } = JSON.parse(original.data);

  const [row] = await sql`
    SELECT id, from_addr, to_addr, handle, contract, tried_signers, status
    FROM app.transfers WHERE id=${rowId}`;
  if (!row || row.status === 'done') return;

  const excluded = [...row.tried_signers, failedSigner];

  // Same SQL as handler-time pick, with extended exclusion array
  const [next] = await sql`
    WITH eligible AS (
      SELECT ${row.from_addr}::bytea AS addr
      UNION SELECT ${row.to_addr}::bytea
      UNION SELECT account FROM app.handle_rights_current
        WHERE handle = ${row.handle} AND active
      UNION SELECT delegatee FROM app.delegations_current
        WHERE delegator IN (${row.from_addr}, ${row.to_addr})
          AND contract = ${row.contract} AND active
    )
    SELECT s.addr FROM eligible e
    JOIN app.signers s ON s.addr = e.addr
    WHERE s.enabled AND s.addr <> ALL(${excluded}::bytea[])
    ORDER BY s.cost_rank ASC
    LIMIT 1`;

  if (!next) {
    await sql`UPDATE app.transfers
              SET status='failed', tried_signers=${excluded},
                  last_error='all_signers_exhausted'
              WHERE id=${rowId}`;
    return;
  }
  await sql`UPDATE app.transfers
            SET assigned_signer=${next.addr}, tried_signers=${excluded},
                attempts=0, last_error=NULL, updated_at=now()
            WHERE id=${rowId}`;
  await js.publish(`decrypt.${next.addr}`, JSON.stringify({ rowId }), { ackWait: 5_000 });
});
```

**The three concerns map directly to native NATS:**

| Concern | Mechanism | Code burden |
|---|---|---|
| Worker crash / hang mid-decrypt | `ack_wait` + multiple replicas on same durable consumer (queue group semantics) | bump replicas, zero code |
| Retryable app error within signer | `max_deliver` + `backoff` + `msg.nak()` | one `nak` call |
| Cross-signer re-election after primary is hopeless | `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>` subscriber | one subscriber process |

**Latency:**
- Retryable errors → `max_deliver=3` × backoff `[1s, 5s, 30s]` = ~36s before advisory fires → escalator re-elects sub-second.
- Terminal errors (`ACL_MISMATCH`, poison) → `msg.term()` emits advisory immediately → escalator re-elects ~50ms.

**Within-signer HA = run K worker replicas attached to the same `worker-${X}` durable consumer.** NATS queue-group dispatches messages across replicas. AckWait covers crash recovery natively. Zero polling, zero claim logic.

Zero custom DLQ tables, zero polling components anywhere in the system.

---

## 7b. Events with NO eligible signer at all

These are `status='no_acl'` rows. **Never published to NATS** — they sit in PG awaiting a state change.

```ts
// Handler logic (recap)
if (intersect.length === 0) {
  await insertPendingTransfer(ctx, { ..., status: 'no_acl', assigned_signer: null });
  // NO publish. PG holds the row.
}
```

Three triggers wake a `no_acl` row:

| Trigger | Source | What it does |
|---|---|---|
| (A) `Allowed(handle, account)` | Chain via ACL contract | If `account` ∈ my_signers → UPDATE rows WHERE handle=$1 AND status='no_acl' → status='ready', assigned_signer=$account → publish to `decrypt.${account}` |
| (B) `NewDelegation(delegator, delegatee, contracts)` | Chain via ACL contract | If `delegatee` ∈ my_signers → UPDATE rows where delegator was a party / had explicit grant on the handle → status='ready', assigned_signer=$delegatee → publish |
| (C) `POST /admin/signers` (new signer added) | Operator config | Backfill query finds no_acl rows where new signer X is now in eligible set → UPDATE → publish to `decrypt.${X}` |

Until one of these fires, the row stays `no_acl`. **This satisfies "events not currently entitled to decrypt must not be silently dropped"** — they're durably parked in PG, visible via the API, and eligible for backfill at any future point.

API exposure:

```
GET /transfers/:addr
→ 200 {
    items: [
      { ..., amountCleartext: "100", status: "done", source: "user_decrypt" },
      { ..., amountCleartext: null,  status: "no_acl",  reason: "no_decrypt_rights_yet" },
      { ..., amountCleartext: null,  status: "failed",  reason: "all_signers_exhausted" }
    ]
  }
```

Partner UI can render: "encrypted (no rights yet)" vs "100 USDC" vs "decrypt failed". Three distinct, honest states. No silent drop.

---

## 7c. State lifecycle (durable in PG, dispatched via NATS)

```
ConfidentialTransfer event
    │
    ▼
disclosed_amounts[handle] exists?
    ├─ YES → INSERT status='done', source='disclosed', cleartext from event. FIN.
    └─ NO
        ▼
    intersect = eligible(handle) ∩ my_signers
        ├─ EMPTY → INSERT status='no_acl'. PARKED in PG, no NATS publish.
        │              │
        │              │ (later: Allowed | NewDelegation | new signer config)
        │              ▼
        │           UPDATE status='ready', assigned_signer=X, publish decrypt.${X}
        │              │
        └─ NON-EMPTY → INSERT status='ready', assigned_signer=X, publish decrypt.${X}
                       │
                       ▼
                 Worker for X consumes
                       │
              ┌────────┼──────────┬───────────────┐
              ▼        ▼          ▼               ▼
          SUCCESS  RETRYABLE  ACL_MISMATCH    POISON
              │     (5xx/net)  (chain rights   (invalid handle,
              │        │        gone)           type mismatch)
              │        ▼          │                │
              │     nak +         │                │
              │     backoff       │                │
              │        │          │                │
              │        ▼          │                │
              │   max_deliver=3   │                │
              │   exhausted       │                │
              │        │          │                │
              ▼        ▼          ▼                ▼
          UPDATE   → DLQ      msg.term()      msg.term()
          done    decrypt.dlq.X  → DLQ          → DLQ
                       │                          │
                       ▼ rescuer (5 min cron)     ▼
                  alternative      no rescue (poison stays terminal,
                  signer exists?   `failed` status; ops can inspect)
                       ├─ YES → UPDATE assigned_signer=Y, publish decrypt.${Y}
                       └─ NO  → UPDATE status='failed', last_error
```

Every transition durable in PG. NATS handles wakeup + retry semantics. No silent drops at any state.

---

## 8. Worker

One async loop per signer. Each owns one Signer instance and one NATS consumer. Independent rate limit, independent backoff, independent failure domain. Memory per loop ≈ one Signer impl.

```ts
// src/worker/main.ts
const signers = await loadSignersFromDb();
await Promise.all(signers.map((s) => runWorkerForSigner(s)));    // independent async loops

async function runWorkerForSigner(s: { address: Address; signer: IndexerSigner }) {
  const consumer = await js.consumers.get('decrypt-work', `worker-${s.address}`);
  const messages = await consumer.consume();
  const decryptor = new ZamaDecryptor(s.signer, sdk);

  for await (const msg of messages) {
    const { rowId } = msg.json();

    // Row was pre-assigned to us by the publisher. Re-fetch to handle reassign/done races.
    const [row] = await sql`
      SELECT id, handle, contract, from_addr, to_addr, status, assigned_signer
      FROM app.transfers WHERE id = ${rowId}`;

    if (!row || row.status !== 'ready' || row.assigned_signer !== s.address) {
      msg.ack();                          // done, reassigned, or transitioned to no_acl
      continue;
    }

    // Long decrypts: heartbeat ack_wait so it doesn't expire mid-work
    const keepalive = setInterval(() => msg.working(), 15_000);
    try {
      const cleartext = await decryptor.decrypt([
        { handle: row.handle, contractAddress: row.contract },
      ]);
      const amount = cleartext.get(row.handle);
      await sql.begin(async (tx) => {
        await tx`UPDATE app.transfers SET status='done', cleartext_amount=${amount},
                 cleartext_source='user_decrypt', attempts=attempts+1, updated_at=now()
                 WHERE id=${rowId}`;
        await markBalanceStale(tx, [row.from_addr, row.to_addr]);
      });
      msg.ack();        // ack ONLY after decrypt + PG commit — ack IS the completion signal
    } catch (err) {
      await sql`UPDATE app.transfers SET attempts=attempts+1, last_error=${String(err)},
                updated_at=now() WHERE id=${rowId}`;

      if (isAclMismatch(err)) {
        // Chain truth says our index is stale. Drop to no_acl; backfill if rights change later.
        await sql`UPDATE app.transfers SET status='no_acl', assigned_signer=NULL WHERE id=${rowId}`;
        msg.ack();
      } else if (isPoison(err)) {
        msg.term();                       // immediate MAX_DELIVERIES advisory → escalator re-elects
      } else {
        msg.nak(backoffFor(msg.info.redeliveryCount));   // relayer 5xx / network
      }
    } finally {
      clearInterval(keepalive);
    }
  }
}

// The two NATS mechanisms cover distinct failure modes:
//
//   • ack_wait expires (with msg.working() heartbeats extending it):
//       worker stuck/crashed mid-decrypt → NATS redelivers to SAME consumer (signer X's queue group).
//       Same signer retries; could be A's replica or A's respawn.
//
//   • max_deliver exhausted (or msg.term()):
//       this signer is hopeless → MAX_DELIVERIES advisory → escalator re-elects to NEXT signer Y.
//
// Both use ack-when-work-done as the canonical "task complete" signal. No separate complete-event
// channel — that would duplicate state the ack already encodes and add distributed-timer fragility.
```

**Properties:**
- **Single intended consumer per message** — message published to `decrypt.${chosen}` is consumed only by that signer's worker. Zero duplicate decrypts.
- **Per-signer isolation** — rate limit, backoff, DLQ all scoped per signer. Fireblocks slow does not block LocalEoa.
- **No `in_progress` status, no row-lock, no sweeper** — NATS ack_wait + max_deliver handles stuck/crashed worker. If worker crashes mid-decrypt, NATS redelivers to same signer's consumer (which may be a fresh process). Re-fetch + check assigned_signer guards against staleness.
- **Cycling ACL handled** — relayer is the arbiter; ACL_MISMATCH error drops to no_acl, future grant re-elects.
- **Cold start scales with signer count linearly** — but each init is independent and concurrent (Promise.all).
- **Memory scales O(1) per signer** — only its own signer impl + one NATS consumer.

**Scaling levers:**
- N signers → N consumers → N async loops in one process. Hundreds is fine on a single Node host.
- For ultra-scale: shard signers across worker processes by hash(address) % K. Each worker process runs ~N/K async loops.
- Per-signer max_ack_pending tunes per-signer throughput / memory tradeoff independent of other signers.

Balance refresh worker (periodic, separate from decrypt worker):

```ts
// every 10s
const stale = await db.balances.find({ stale: true, where_we_have_signer: true });
for (const addr of stale) {
  try {
    const handle = await rpc.confidentialBalanceOf(TOKEN, addr);
    if (isZeroHandle(handle)) {
      await db.balances.upsert({ addr, source: 'never_shielded', cleartext_amount: null, stale: false });
      continue;
    }
    const amount = await decryptor.decrypt([{ handle, contractAddress: TOKEN }]);
    await db.balances.upsert({ addr, current_handle: handle, cleartext_amount: amount.get(handle), source: 'decrypted', stale: false });
  } catch (e) {
    if (e instanceof NoCiphertextError) {
      await db.balances.upsert({ addr, source: 'never_shielded', stale: false });
    } else {
      // log; leave stale=true; retry next cycle
    }
  }
}
```

---

## 9. HTTP API (Fastify, REST + OpenAPI / Swagger)

All routes register Fastify JSON schemas → `@fastify/swagger` auto-builds OpenAPI 3 spec → `@fastify/swagger-ui` serves `/docs` interactive UI. Spec also dumped to `openapi.json` at boot for offline tooling.

```
GET /health
  → 200 {
      indexer: { lastBlock, chainHead, behindBlocks, syncedAt },
      worker:  { pending, no_acl, failed, dlqDepth },
      nats:    { connected, streamMsgs },
      db:      { connected }
    }
  → 503 if behindBlocks > THRESHOLD or nats disconnected

GET /balance/:addr
  → 200 { addr, amount: "1234", source: "decrypted", updatedAtBlock, stale: false }
  → 200 { addr, amount: "0", source: "decrypted", updatedAtBlock, stale: false }
  → 200 { addr, amount: null, reason: "never_shielded" }
  → 200 { addr, amount: null, reason: "no_decrypt_rights", lastHandle }
  → 400 { error: "invalid_address" }
  → 503 if indexer too far behind

GET /transfers/:addr?cursor=...&limit=50&direction=in|out|both
  → 200 {
      items: [
        { id, block, txHash, logIndex, from, to, amountCleartext: "100", source: "user_decrypt", decryptedAt },
        { id, block, txHash, logIndex, from, to, amountCleartext: null, status: "no_acl" },
        ...
      ],
      nextCursor: "<opaque>",
      hasMore: true
    }

GET /operators/:holder
  → 200 { holder, operators: [{ operator, until }] }

POST /admin/signers   (out of scope for take-home demo, schema designed for it)
DELETE /admin/signers/:addr
```

**Error taxonomy** (uniform JSON shape):
```json
{ "error": "code_in_snake", "message": "human readable", "details": {...} }
```
Codes: `invalid_address`, `invalid_cursor`, `indexer_lagging`, `signer_unavailable`, `internal`.

**Pagination:** opaque cursor = base64(block, log_index). Deterministic, stable across re-runs. Cleartext-aware queries don't change order.

---

## 10. Tests

```
test/
  happy.test.ts          # event in → cleartext out
  no_acl_negative.test.ts # event without rights → row sits as no_acl, API exposes null with reason
  acl_grant_backfill.test.ts (stretch)
  disclosed_amount.test.ts (stretch)
```

**Happy path (the must-have):**
1. Boot forge-fhevm + Postgres + NATS via docker compose.
2. Deploy ERC-7984 sample contract.
3. Mint + confidentialTransfer from A → B, where A's key is configured signer.
4. Wait for Envio to process block.
5. Assert `GET /transfers/A?direction=both` returns row with cleartext.
6. Assert `GET /balance/B` returns expected cleartext within timeout.

**Negative (the must-have, justified):** *relayer-unavailable retry semantics.*
- Mock `userDecrypt` to return 503 first 3 times, success on 4th.
- Emit transfer.
- Assert worker retries with backoff, eventually succeeds.
- Assert no duplicate inserts in `transfers`.
- Assert indexer head keeps advancing during retries (decrypt failure doesn't stall sync).

Picked because it directly tests the lifecycle judgment the brief asks about: **decrypt failure must not poison the indexer; events must not be silently dropped**. Single test exercises the queue's whole reason for existing.

---

## 11. Repo layout

```
sdk-triage/
├── envio/
│   ├── config.yaml                  # network, contract addresses, ABI references
│   ├── schema.graphql               # Envio entities (public.*)
│   └── src/EventHandlers.ts         # event → PG (app.*) + NATS publish
├── src/
│   ├── util/
│   │   └── hex.ts                   # normAddr (viem.getAddress), normHandle (lowercase + validate)
│   ├── api/
│   │   ├── server.ts                # Fastify app
│   │   ├── routes/balance.ts
│   │   ├── routes/transfers.ts
│   │   └── routes/health.ts
│   ├── worker/
│   │   ├── decrypt.ts               # per-signer NATS consumer loop
│   │   └── balance-refresh.ts       # periodic stale balance read+decrypt
│   ├── nats/
│   │   ├── stream.ts                # stream + consumer mgmt
│   │   └── publish.ts
│   ├── providers/
│   │   ├── signer.ts                # IndexerSigner interface
│   │   ├── local-eoa.ts             # LocalEoaSigner impl
│   │   ├── fireblocks.ts            # stub
│   │   ├── kms.ts                   # stub
│   │   └── decryptor.ts             # ZamaDecryptor (signer + sdk)
│   ├── db/
│   │   ├── migrate.ts               # raw SQL migrations for app.* schema
│   │   ├── client.ts                # pg pool
│   │   └── queries.ts
│   └── config.ts                    # env var parsing
├── test/
│   ├── sql/
│   │   └── pick_signer.sql.test.ts  # step 0: validate routing SQL with testcontainers
│   ├── happy.test.ts
│   ├── no_acl_negative.test.ts
│   └── helpers/                     # forge-fhevm setup, NATS test util, hex normalization helpers
├── tools/
│   └── rebuild-stream.ts            # re-fan-out from PG if NATS data lost
├── docker-compose.yml               # postgres + nats + forge-fhevm + indexer + worker + api
├── Dockerfile                       # app containers (multi-stage: build + slim runtime)
├── .env.example
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── DECISIONS.md
└── README.md
```

---

## 12. Setup (target README experience)

```bash
git clone <repo> && cd sdk-triage
cp .env.example .env             # fill defaults work for local
docker compose up -d             # everything: postgres + nats + forge-fhevm + indexer + worker + api
# Wait ~15s for forge-fhevm to deploy sample contracts (logged)
open http://localhost:3000/docs  # Swagger UI
pnpm test                        # happy + negative against the running stack
```

For local dev (faster than full container build):
```bash
docker compose up -d postgres nats forge-fhevm
pnpm install
pnpm db:migrate
pnpm envio:codegen
pnpm dev                         # parallel: envio + worker + api
```

Sepolia (documented, not run in this submission):
```bash
# Set RPC_URL, ZAMA_RELAYER_URL, TOKEN_ADDRESS, ACL_CONTRACT_ADDRESS in .env
# All other commands identical.
```

`.env.example`:
```
DATABASE_URL=postgres://...
NATS_URL=nats://localhost:4222
NATS_REPLICAS=1
RPC_URL=http://localhost:8545
TOKEN_ADDRESS=0x...
ACL_CONTRACT_ADDRESS=0x...
PRIVATE_KEY=0x...           # LocalEoaSigner key
ZAMA_RELAYER_URL=...
INDEXER_BEHIND_THRESHOLD=20
```

---

## 13. What's cut (call out in DECISIONS.md)

- **Fireblocks/AWS KMS/Silence Labs adapters** — only `LocalEoaSigner` ships. Interface defined, stubs throw. Adapters are 30–80 LOC each, mechanical given the interface.
- **GraphQL endpoint** — Hasura comes free with Envio on `public.*`; mention in README that `app.*` can be exposed via Hasura too with one config step. Don't ship the config.
- **Sepolia end-to-end run** — documented in README; not executed in this submission per scoping guidance.
- **Multi-contract support** — single `TOKEN_ADDRESS` env var. Schema supports multi but config doesn't.
- **Auth on API** — README says "deploy behind partner gateway." No JWT, no API keys.
- **Reorg handling beyond Envio defaults** — Envio rolls back on reorg; idempotent upserts make this safe; not separately tested.
- **Cursor pagination** — offset+limit is the placeholder; opaque-cursor sketched in design but stub `?offset=&limit=` in impl. Documented.
- **Operator-as-decrypt-party** — spec doesn't grant decrypt rights to operators; we don't add them to `eligible` set. Operators surface as plaintext metadata only.
- **Shield/unshield wrapper** — supported only if contract has `Shield`/`Unshield` events; otherwise stubbed. ERC-7984 spec itself doesn't define them.
- **Prometheus / OpenTelemetry** — `/health` JSON only.

---

## 14. DECISIONS.md outline

1. **Stack choices** — Envio, NATS, Postgres, Fastify, TS. Why each, 1 paragraph.
2. **Source-of-truth split** — PG canonical, NATS dispatch. The 3 events that flip a pending row to ready. The free `AmountDisclosed` cleartext path.
3. **ACL state as event log + materialized current** — handles cycling revocations cleanly; race with chain state handled at worker via `ACL_MISMATCH` recovery.
4. **Decryption interface = thin signer** — address is the universal join key; provider-specific identifiers (vault ID, KMS ARN, MPC party) collapse onto one address. Delegation widens the address→handle relation, indexed separately.
5. **Per-signer JetStream consumer with `DeliverPolicy: all`** — replaces SQL backfill UPDATE with stream replay. Per-signer retry/backoff/DLQ free. Fan-out at publish accepted (no positional set-membership on subjects; ~3× publish cost is trivial).
6. **Balance via handle-read, not sum-of-transfers** — sum is wrong whenever any historical transfer is `no_acl`; handle-read is authoritative per `confidentialBalanceOf`.
7. **Three distinct `null` balance reasons in API** — never_shielded vs no_decrypt_rights vs zero. Mirrors SDK's `NoCiphertextError` vs `0n` distinction.
8. **Reflection: what breaks under partner load** — the per-signer decrypt worker. Failure modes: relayer rate-limits, NATS ack lost mid-call → duplicate decrypt attempt (idempotent on PG side), ACL revoked between enqueue and decrypt. How to prove: k6 against worker with mocked relayer that 503s 20%, measure throughput, monotonic indexer head, zero duplicates.
9. **What got cut and what 4 more hours buys** — Fireblocks adapter, Sepolia-end-to-end run, balance refresh worker hardening, cursor pagination, mTLS on NATS.
10. **SDK feedback** (pick 2–3 concrete; write while building, not retrofitted):
    - candidate: error taxonomy on `userDecrypt` — distinct codes for `ACL_MISMATCH`, `RELAYER_5XX`, `INVALID_HANDLE`, `TYPE_MISMATCH`. Currently distinguishing requires string-matching error messages.
    - candidate: server-side `IndexerSigner` reference impl — every backend integration re-writes the same EIP-712 → relayer wrapper. Ship one in `@zama-fhe/sdk/server`.
    - candidate: doc gap on `confidentialBalanceOf` returning zero-handle vs revert vs non-existent state — distinction matters for indexer "never shielded" semantics.
11. **AI assistance** — Claude Code for design discussion (this plan), code completion via Cursor. One example where it gave subtly wrong info: TBD during build (truthful one, not retrofitted).

---

## 14b. Concurrency notes (Q on `await` patterns + N-way fan-out)

**Parallel awaits where genuinely independent:**
```ts
// Handler — these are independent, so Promise.all where it actually parallelizes
const [parties, signers] = await Promise.all([computeParties(...), getActiveSigners(...)]);
// ... compute eligible/assigned synchronously
const rowId = await insertPendingTransfer(...);    // needs to come first; rowId used in publish
await Promise.all([
  markBalanceStale([from, to]),
  ...parties.map(p => js.publish(`involved.${p}`, { rowId, handle }, { ackWait: 5_000 })),
]);
```

PG operations within an Envio handler usually share a transaction/connection → wire-serialized regardless of `Promise.all`. NATS publishes use a separate connection → genuinely parallel; this is where Promise.all earns its keep.

**`await` vs `.then().catch()` style choice:**
- Semantically identical, same microtask continuation, no perf delta.
- `await` chosen for: readability of sequential/conditional flow, preserved stack traces, debugger ergonomics.
- `.then().catch()` reserved for: fire-and-forget (`metricsClient.send(...).catch(noop)`), promise composition pipelines where transformations chain naturally.

In the indexer hot path, we never want fire-and-forget on a write that affects business state — every PG/NATS call is awaited so its failure surfaces to Envio's at-least-once block retry.

---

## 15. Handler design notes (Q9 + Q10 from review)

**Why we compute parties pre-NATS in the transfer handler (vs decomposing or routing):**

Considered three shapes:
- **A. Decompose fan-out across handlers**: `ConfidentialTransfer` publishes only to `involved.<from>` and `involved.<to>`. `Allowed` handler publishes to `involved.<account>`. `NewDelegation` handler queries historical events for delegator and fans out per-handle. Pro: handler is dumb-fast, no PG read. Con: same total work, three publish sites must stay consistent on ACL semantics; more bug surface.
- **B. Router consumer**: handler publishes once to `events.raw.<txhash>.<logindex>`; downstream JetStream consumer computes parties and re-fans out. Pro: handler is single-publish. Con: extra hop, double stream volume, router checkpoint, more code.
- **C. (Picked) Compute in handler**: 2 PG queries (handle_rights_current, delegations_current) + N publishes. Sub-ms PG reads on indexed columns. Envio block cadence is the bottleneck anyway. One component to reason about during review.

DECISIONS.md flags Alt A as the right partner-load refactor (decouples hot path from delegation backfill). Alt B is over-engineered for this scope.

**Why `await Promise.all` and not `.then` fire-and-forget on publishes:**

The "no outbox needed" claim hangs on awaited publish-ack:
- `await Promise.all(parties.map(p => js.publish(...)))` → concurrent publishes, all ack'd before handler resolves. If NATS down → handler throws → Envio re-runs the block. Recovery free via `ON CONFLICT DO NOTHING` (`UNIQUE(tx_hash, log_index)`) on transfers + JetStream `duplicate_window` on stream.
- `.then(...)` fire-and-forget → handler returns before ack. If NATS down → unhandled rejection, PG row exists, NATS doesn't, worker never wakes. **DATA LOSS**. Adding outbox to compensate adds 100+ LOC of new infra.

Latency reality: JetStream publish-ack ~5ms local. Promise.all wall-clock = slowest single publish, not sum. Per-block handler cost <100ms; Envio block cadence (1s local) is the cap. Not a hot-path concern.

---

## 16. Plan B for Envio schema (30-min escape hatch)

If Envio's codegen fights the custom `app.*` schema (TS types not resolving, Postgres permission errors on schema cross-references, Envio drops `app.*` tables on reindex), bail in this priority order:

1. **Same DB, all in `public`** — let Envio own the entities for ACL events + transfers + balances by adding them to `schema.graphql`. Custom logic (NATS publish, signer matching) moves into Envio handler. Lose: clean separation. Gain: no fight.
2. **Two DBs** — Envio owns its `envio_db` Postgres. App owns separate `app_db` Postgres. Envio handler writes to `app_db` directly via pg client; reads its own state from `envio_db`. Lose: extra Postgres instance in compose. Gain: zero schema conflict, clear ownership.

Document the choice in DECISIONS.md. Either fallback is honest; the brief explicitly invites this kind of trade-off.

---

## 17. Confirmations (all received)

- Token: forge-fhevm sample contracts ✓
- pnpm ✓
- Vitest ✓
- forge-fhevm CLI as dev dep ✓
- Sepolia: documented only, not run ✓
- Docker delivery end-to-end ✓
- Swagger / OpenAPI docs ✓
- 30-min budget on `app.*` schema interop ✓

Scaffolding next. Order:

0. **Validate routing SQL standalone** — testcontainers Postgres + app.* migrations + 8 SQL test cases against `pickSignerForTransfer` and `backfillForNewSigner`. Catches UNION/JOIN/exclusion-array bugs before they hide under three layers. ~80 LOC.
1. Repo skeleton + tsconfig + pnpm + hex normalization helpers (`normAddr` via viem, `normHandle`)
2. Docker compose (postgres, nats, forge-fhevm, app containers)
3. DB migrations (`app.*` schema with `app.address`/`app.hex32` domains; Plan B branch ready)
4. Envio config + handlers (ConfidentialTransfer + AmountDisclosed + OperatorSet + ACL events) — all inserts go through `normAddr`/`normHandle`
5. Signer interface + LocalEoaSigner + ZamaDecryptor wrapper
6. NATS stream/consumer mgmt + decrypt worker + escalator (advisory subscriber)
7. Fastify API + Swagger
8. Balance refresh worker
9. Happy + negative tests (full-stack)
10. README + DECISIONS.md

**Why step 0 first:** the unified `pickSignerForTransfer` SQL is the heart of the routing logic. Every dispatch funnels through it. If UNION semantics or exclusion-array casting is wrong, the system silently mis-routes — no full-stack test will surface the cause; debugging from end-to-end will eat hours. Eight fixture-based assertions running in seconds gives high confidence before any NATS/HTTP wiring.

Target: step 0 in ~30 min, scaffold (1–8) in ~2 hr, tests + docs (9–10) in ~1.5 hr.
