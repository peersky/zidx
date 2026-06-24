import type postgres from "postgres";
import type { Sql } from "../db/client.js";
import type { Address, Hex32 } from "../util/hex.js";

type AnySql = postgres.Sql | postgres.TransactionSql<Record<string, never>>;

export interface TransferRow {
  id: number;
  block: number;
  log_index: number;
  tx_hash: Hex32;
  contract: Address;
  from_addr: Address;
  to_addr: Address;
  handle: Hex32;
  cleartext_amount: string | null;
  cleartext_source: "disclosed" | "user_decrypt" | null;
  status: "ready" | "done" | "no_acl" | "failed";
  assigned_signer: Address | null;
  tried_signers: string[];
  attempts: number;
  last_error: string | null;
}

export async function pickSignerForTransfer(
  sql: AnySql,
  args: { from: Address; to: Address; handle: Hex32; contract: Address; excluded?: string[] },
): Promise<Address | null> {
  const excluded = args.excluded ?? [];
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await sql<{ addr: Address }[]>`
    WITH eligible AS (
      SELECT ${args.from}::app.address AS addr
      UNION SELECT ${args.to}::app.address
      UNION SELECT account FROM app.handle_rights_current
        WHERE handle = ${args.handle}
      UNION SELECT delegatee FROM app.delegations_current
        WHERE delegator IN (${args.from}, ${args.to})
          AND target_contract = ${args.contract}
          AND expiration_ts > ${nowSec}
    )
    SELECT s.addr FROM eligible e
    JOIN app.signers s ON s.addr = e.addr
    WHERE s.enabled
      AND s.addr <> ALL(${excluded}::TEXT[])
    ORDER BY s.cost_rank ASC
    LIMIT 1
  `;
  return rows[0]?.addr ?? null;
}

export async function backfillForNewSigner(sql: AnySql, newSigner: Address): Promise<{ id: number }[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  // Two recovery classes:
  //   - status='no_acl': never tried; new eligible signer turns it ready.
  //     tried_signers reset to [] (no real history to preserve).
  //   - status='failed' AND last_error='all_signers_exhausted': transient
  //     infra fail across every prior signer; new signer is exactly the cure.
  //     tried_signers PRESERVED so the escalator doesn't loop back to the
  //     previously-failed cohort if the new signer also fails.
  // status='failed' with last_error LIKE 'poison: %' stays terminal — same
  // handle fails identically for any signer by definition.
  const rows = await sql<{ id: number }[]>`
    UPDATE app.transfers t
    SET status = 'ready',
        assigned_signer = ${newSigner},
        attempts = 0,
        last_error = NULL,
        tried_signers = CASE
          WHEN t.status = 'no_acl' THEN ARRAY[]::TEXT[]
          ELSE t.tried_signers
        END,
        updated_at = now()
    WHERE (
      t.status = 'no_acl'
      OR (
        t.status = 'failed'
        AND t.last_error = 'all_signers_exhausted'
        AND NOT (${newSigner} = ANY(t.tried_signers))
      )
    )
      AND (
        t.from_addr = ${newSigner}
        OR t.to_addr = ${newSigner}
        OR EXISTS (
          SELECT 1 FROM app.handle_rights_current
          WHERE handle = t.handle AND account = ${newSigner}
        )
        OR EXISTS (
          SELECT 1 FROM app.delegations_current
          WHERE delegatee = ${newSigner}
            AND target_contract = t.contract
            AND expiration_ts > ${nowSec}
            AND delegator IN (t.from_addr, t.to_addr)
        )
      )
    RETURNING id
  `;
  return rows;
}

export async function insertTransfer(
  sql: AnySql,
  args: {
    block: number;
    log_index: number;
    tx_hash: Hex32;
    contract: Address;
    from_addr: Address;
    to_addr: Address;
    handle: Hex32;
    status: "ready" | "no_acl" | "done";
    assigned_signer: Address | null;
    cleartext_amount?: bigint | null;
    cleartext_source?: "disclosed" | "user_decrypt" | null;
  },
): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO app.transfers (
      block, log_index, tx_hash, contract, from_addr, to_addr, handle,
      status, assigned_signer, cleartext_amount, cleartext_source
    ) VALUES (
      ${args.block}, ${args.log_index}, ${args.tx_hash}, ${args.contract},
      ${args.from_addr}, ${args.to_addr}, ${args.handle},
      ${args.status}, ${args.assigned_signer},
      ${args.cleartext_amount?.toString() ?? null}, ${args.cleartext_source ?? null}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
    RETURNING id
  `;
  if (rows[0]) return rows[0].id;
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM app.transfers WHERE tx_hash=${args.tx_hash} AND log_index=${args.log_index}`;
  return existing[0]!.id;
}

export async function upsertHandleRight(
  sql: AnySql,
  args: { handle: Hex32; account: Address; block: number; log_index: number },
): Promise<void> {
  await sql`
    INSERT INTO app.handle_rights_current (handle, account, granted_at_block, granted_at_log_index)
    VALUES (${args.handle}, ${args.account}, ${args.block}, ${args.log_index})
    ON CONFLICT (handle, account) DO UPDATE
      SET granted_at_block = EXCLUDED.granted_at_block,
          granted_at_log_index = EXCLUDED.granted_at_log_index
  `;
}

export async function upsertDelegation(
  sql: AnySql,
  args: {
    delegator: Address;
    delegatee: Address;
    target_contract: Address;
    expiration_ts: number;
    delegation_counter: number;
    block: number;
    log_index: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO app.delegations_current
      (delegator, delegatee, target_contract, expiration_ts, delegation_counter,
       last_changed_block, last_changed_log_index)
    VALUES (
      ${args.delegator}, ${args.delegatee}, ${args.target_contract},
      ${args.expiration_ts}, ${args.delegation_counter},
      ${args.block}, ${args.log_index}
    )
    ON CONFLICT (delegator, delegatee, target_contract) DO UPDATE SET
      expiration_ts = EXCLUDED.expiration_ts,
      delegation_counter = EXCLUDED.delegation_counter,
      last_changed_block = EXCLUDED.last_changed_block,
      last_changed_log_index = EXCLUDED.last_changed_log_index
  `;
}

export async function revokeDelegation(
  sql: AnySql,
  args: {
    delegator: Address;
    delegatee: Address;
    target_contract: Address;
    delegation_counter: number;
    block: number;
    log_index: number;
  },
): Promise<void> {
  await sql`
    UPDATE app.delegations_current
    SET expiration_ts = 0,
        delegation_counter = ${args.delegation_counter},
        last_changed_block = ${args.block},
        last_changed_log_index = ${args.log_index}
    WHERE delegator = ${args.delegator}
      AND delegatee = ${args.delegatee}
      AND target_contract = ${args.target_contract}
  `;
}

export async function upsertDisclosed(
  sql: AnySql,
  args: { handle: Hex32; amount: bigint; block: number; tx_hash: Hex32; log_index: number },
): Promise<void> {
  await sql`
    INSERT INTO app.disclosed_amounts (handle, amount, block, tx_hash, log_index)
    VALUES (${args.handle}, ${args.amount.toString()}, ${args.block}, ${args.tx_hash}, ${args.log_index})
    ON CONFLICT (handle) DO NOTHING
  `;
}

export async function applyDisclosedToTransfers(
  sql: AnySql,
  handle: Hex32,
  amount: bigint,
): Promise<{ id: number; from_addr: Address; to_addr: Address }[]> {
  const rows = await sql<{ id: number; from_addr: Address; to_addr: Address }[]>`
    UPDATE app.transfers
    SET cleartext_amount = ${amount.toString()},
        cleartext_source = 'disclosed',
        status = 'done',
        updated_at = now()
    WHERE handle = ${handle} AND cleartext_amount IS NULL
    RETURNING id, from_addr, to_addr
  `;
  return rows;
}

export async function markBalanceStale(sql: AnySql, addrs: Address[]): Promise<void> {
  if (addrs.length === 0) return;
  await sql`
    INSERT INTO app.balances (addr, stale)
    SELECT addr, TRUE FROM unnest(${addrs}::TEXT[]) AS t(addr)
    ON CONFLICT (addr) DO UPDATE SET stale = TRUE, updated_at = now()
  `;
}

export async function getSignerAddresses(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ addr: Address }[]>`SELECT addr FROM app.signers WHERE enabled`;
  return new Set(rows.map((r) => r.addr));
}

export async function isOurSigner(sql: AnySql, addr: Address): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM app.signers WHERE addr=${addr} AND enabled LIMIT 1`;
  return rows.length > 0;
}

export async function getTransferById(sql: AnySql, id: number): Promise<TransferRow | null> {
  const rows = await sql<TransferRow[]>`SELECT * FROM app.transfers WHERE id=${id}`;
  return rows[0] ?? null;
}

export async function updateTransferDone(
  sql: AnySql,
  id: number,
  amount: bigint,
  source: "user_decrypt" | "disclosed",
): Promise<void> {
  await sql`
    UPDATE app.transfers
    SET status='done', cleartext_amount=${amount.toString()}, cleartext_source=${source},
        attempts=attempts+1, updated_at=now()
    WHERE id=${id}
  `;
}

export async function updateTransferFailedAcl(sql: AnySql, id: number): Promise<void> {
  await sql`
    UPDATE app.transfers SET status='no_acl', assigned_signer=NULL, last_error='ACL_MISMATCH',
        updated_at=now() WHERE id=${id}
  `;
}

export async function recordTransferAttempt(sql: AnySql, id: number, lastError: string): Promise<void> {
  await sql`
    UPDATE app.transfers SET attempts=attempts+1, last_error=${lastError}, updated_at=now()
    WHERE id=${id}
  `;
}

export async function markTransferReassigned(
  sql: AnySql,
  id: number,
  newSigner: Address,
  newTried: string[],
): Promise<void> {
  await sql`
    UPDATE app.transfers
    SET assigned_signer = ${newSigner},
        tried_signers = ${newTried}::TEXT[],
        attempts = 0,
        last_error = NULL,
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function markTransferTerminallyFailed(
  sql: AnySql,
  id: number,
  tried: string[],
  reason: string,
): Promise<void> {
  await sql`
    UPDATE app.transfers
    SET status = 'failed',
        tried_signers = ${tried}::TEXT[],
        last_error = ${reason},
        updated_at = now()
    WHERE id = ${id}
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────

export interface IndexerState {
  last_block: number;
  updated_at: string;
}

export async function getIndexerState(sql: Sql): Promise<IndexerState | null> {
  const [row] = await sql<IndexerState[]>`
    SELECT last_block, updated_at FROM app.indexer_state WHERE id=1`;
  return row ?? null;
}

export interface TransferStatusCounts {
  done: number;
  ready: number;
  no_acl: number;
  failed: number;
}

export async function getTransferStatusCounts(sql: Sql): Promise<TransferStatusCounts> {
  const [row] = await sql<{ done: string; ready: string; no_acl: string; failed: string }[]>`
    SELECT
      COUNT(*) FILTER (WHERE status='done')   AS done,
      COUNT(*) FILTER (WHERE status='ready')  AS ready,
      COUNT(*) FILTER (WHERE status='no_acl') AS no_acl,
      COUNT(*) FILTER (WHERE status='failed') AS failed
    FROM app.transfers`;
  return {
    done: Number(row?.done ?? 0),
    ready: Number(row?.ready ?? 0),
    no_acl: Number(row?.no_acl ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export interface SignerInput {
  addr: Address;
  kind: string;
  config: Record<string, unknown>;
  costRank: number;
}

export async function upsertSigner(sql: Sql, args: SignerInput): Promise<void> {
  // postgres.js .json() helper marshals to JSONB; cast through any to dodge
  // a noisy generic in @types/postgres.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
// TODO(slop): `as any` cast — discards the compiler's view of the value; narrow via `as unknown` + a real interface or fix the upstream type
  const cfg = (sql as any).json(args.config);
  await sql`
    INSERT INTO app.signers (addr, kind, config, cost_rank, enabled)
    VALUES (${args.addr}, ${args.kind}, ${cfg}, ${args.costRank}, TRUE)
    ON CONFLICT (addr) DO UPDATE SET
      kind = EXCLUDED.kind, config = EXCLUDED.config,
      cost_rank = EXCLUDED.cost_rank, enabled = TRUE`;
}

export async function disableSigner(sql: Sql, addr: Address): Promise<boolean> {
// TODO(slop): SQL built by f-string / `+` / `${...}` interpolation — classic injection vector; use bind parameters (`?`, `%s`, `$1`) instead
  const rows = await sql`UPDATE app.signers SET enabled=FALSE WHERE addr=${addr} RETURNING addr`;
  return rows.length > 0;
}

export interface BalanceRow {
  current_handle: string | null;
  cleartext_amount: string | null;
  source: string | null;
  updated_at_block: number | null;
  stale: boolean;
}

export async function getBalanceByAddr(sql: Sql, addr: Address): Promise<BalanceRow | null> {
  const [row] = await sql<BalanceRow[]>`
    SELECT current_handle, cleartext_amount, source, updated_at_block, stale
    FROM app.balances WHERE addr=${addr}`;
  return row ?? null;
}

export type TransferDirection = "in" | "out" | "both";

export interface ListTransfersArgs {
  addr: Address;
  direction: TransferDirection;
  cursor: { block: number; logIndex: number } | null;
  limit: number;
}

export interface TransferOutRow {
  id: number;
  block: number;
  log_index: number;
  tx_hash: string;
  contract: string;
  from_addr: string;
  to_addr: string;
  handle: string;
  cleartext_amount: string | null;
  cleartext_source: string | null;
  status: string;
  assigned_signer: string | null;
  tried_signers: string[];
  last_error: string | null;
  updated_at: string;
}

export async function listTransfersByAddr(
  sql: Sql,
  args: ListTransfersArgs,
): Promise<TransferOutRow[]> {
  const cursorFilter = args.cursor
    ? sql`AND (block, log_index) < (${args.cursor.block}, ${args.cursor.logIndex})`
    : sql``;
  const directionFilter =
    args.direction === "in"
      ? sql`to_addr = ${args.addr}`
      : args.direction === "out"
        ? sql`from_addr = ${args.addr}`
        : sql`(from_addr = ${args.addr} OR to_addr = ${args.addr})`;
  return sql<TransferOutRow[]>`
    SELECT id, block, log_index, tx_hash, contract, from_addr, to_addr, handle,
           cleartext_amount, cleartext_source, status, assigned_signer,
           tried_signers, last_error, updated_at
    FROM app.transfers
    WHERE ${directionFilter}
    ${cursorFilter}
    ORDER BY block DESC, log_index DESC
    LIMIT ${args.limit}
  `;
}

export interface OperatorRow {
  operator: string;
  until_ts: string;
  set_at_block: number;
}

export async function listOperatorsByHolder(sql: Sql, holder: Address): Promise<OperatorRow[]> {
  return sql<OperatorRow[]>`
    SELECT operator, until_ts, set_at_block
    FROM app.operators WHERE holder=${holder}
  `;
}
