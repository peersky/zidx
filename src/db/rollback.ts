import type postgres from "postgres";

/**
 * Reorg cleanup for the app.* schema. Called from Envio's rollback callback
 * after Envio has rolled back its own entity store to `rollbackToBlock`.
 *
 * Deletes per-event rows landed above the rollback boundary; marks balance
 * rows stale so the balance-refresh worker re-fetches `confidentialBalanceOf`
 * for any address that may have been affected.
 *
 * Idempotent: running with the same `rollbackToBlock` twice is a no-op.
 *
 * Tables NOT touched (intentional):
 *   - app.signers           — operator config, not chain-derived
 *   - app.nats_events       — append-only audit log keyed on wall-clock ts
 *   - app.indexer_state     — single-row, overwritten by next event
 *
 * Returns row counts per table so callers can log + alert on large rollbacks.
 */
export interface RollbackCounts {
  transfers: number;
  acl_events: number;
  handle_rights_current: number;
  delegations_current: number;
  disclosed_amounts: number;
  operators: number;
  balances_marked_stale: number;
}

export async function rollbackAppSchema(
  sql: postgres.Sql,
  rollbackToBlock: number,
): Promise<RollbackCounts> {
  return sql.begin(async (tx): Promise<RollbackCounts> => {
    const transfers = await tx`DELETE FROM app.transfers WHERE block > ${rollbackToBlock}`;
    const aclEvents = await tx`DELETE FROM app.acl_events WHERE block > ${rollbackToBlock}`;
    const handleRights = await tx`DELETE FROM app.handle_rights_current WHERE granted_at_block > ${rollbackToBlock}`;
    const delegations = await tx`DELETE FROM app.delegations_current WHERE last_changed_block > ${rollbackToBlock}`;
    const disclosed = await tx`DELETE FROM app.disclosed_amounts WHERE block > ${rollbackToBlock}`;
    const operators = await tx`DELETE FROM app.operators WHERE set_at_block > ${rollbackToBlock}`;
    // Balances last-updated above the rollback boundary — or never refreshed
    // since indexer start — get marked stale so balance-refresh re-fetches.
    const balances = await tx`
      UPDATE app.balances
      SET stale = TRUE, updated_at = now()
      WHERE updated_at_block IS NULL OR updated_at_block > ${rollbackToBlock}
    `;
    return {
      transfers: transfers.count,
      acl_events: aclEvents.count,
      handle_rights_current: handleRights.count,
      delegations_current: delegations.count,
      disclosed_amounts: disclosed.count,
      operators: operators.count,
      balances_marked_stale: balances.count,
    };
  });
}
