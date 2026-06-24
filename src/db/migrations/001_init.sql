-- ============================================================================
-- Confidential Indexer schema (app.*)
-- Lives alongside Envio's own schema (typically public.*). Envio drops its
-- own tables on reindex but does not touch other schemas.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS app;

-- ── Hex domain types ────────────────────────────────────────────────────────
-- Addresses: EIP-55 checksum at boundary via viem.getAddress(). Mixed case allowed.
-- Hex32 (handles, tx hashes): lowercase. No checksum semantics.

DO $$ BEGIN
  CREATE DOMAIN app.address AS VARCHAR(42)
    CHECK (VALUE ~ '^0x[0-9a-fA-F]{40}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE DOMAIN app.hex32 AS VARCHAR(66)
    CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Append-only ACL event log ───────────────────────────────────────────────
-- Replayable source of truth. handle_rights_current and delegations_current
-- are materialised projections.

CREATE TABLE IF NOT EXISTS app.acl_events (
  block            BIGINT     NOT NULL,
  log_index        INT        NOT NULL,
  tx_hash          app.hex32  NOT NULL,
  kind             TEXT       NOT NULL CHECK (kind IN ('allow','allow_for_decryption','delegate','revoke_delegate','block','unblock')),
  contract         app.address,                       -- ACL contract address
  caller           app.address,                       -- msg.sender of the on-chain call
  handle           app.hex32,                         -- per-handle events (allow)
  account          app.address,                       -- per-handle events (allow)
  delegator        app.address,                       -- delegation events
  delegatee        app.address,                       -- delegation events
  target_contract  app.address,                       -- contract scope of delegation
  delegation_counter   BIGINT,
  old_expiration   BIGINT,
  new_expiration   BIGINT,
  PRIMARY KEY (block, log_index)
);

-- ── Materialised current state ──────────────────────────────────────────────
-- fhevm ACL has no per-handle revoke event: once Allowed, it stays. So this
-- table is upsert-only; no `active` flag needed. Row exists ⇒ active.

CREATE TABLE IF NOT EXISTS app.handle_rights_current (
  handle     app.hex32     NOT NULL,
  account    app.address   NOT NULL,
  granted_at_block  BIGINT NOT NULL,
  granted_at_log_index INT NOT NULL,
  PRIMARY KEY (handle, account)
);
CREATE INDEX IF NOT EXISTS handle_rights_account_idx
  ON app.handle_rights_current (account);

-- Delegations have expiration. Active iff expiration_ts > now() (unix seconds).
-- delegationCounter from on-chain disambiguates re-delegations.

CREATE TABLE IF NOT EXISTS app.delegations_current (
  delegator         app.address NOT NULL,
  delegatee         app.address NOT NULL,
  target_contract   app.address NOT NULL,
  expiration_ts     BIGINT      NOT NULL,
  delegation_counter BIGINT     NOT NULL,
  last_changed_block BIGINT     NOT NULL,
  last_changed_log_index INT    NOT NULL,
  PRIMARY KEY (delegator, delegatee, target_contract)
);
CREATE INDEX IF NOT EXISTS delegations_delegatee_contract_idx
  ON app.delegations_current (delegatee, target_contract);
CREATE INDEX IF NOT EXISTS delegations_delegator_contract_idx
  ON app.delegations_current (delegator, target_contract);

-- ── Transfers (main indexer output) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app.transfers (
  id                  BIGSERIAL PRIMARY KEY,
  block               BIGINT       NOT NULL,
  log_index           INT          NOT NULL,
  tx_hash             app.hex32    NOT NULL,
  contract            app.address  NOT NULL,
  from_addr           app.address  NOT NULL,
  to_addr             app.address  NOT NULL,
  handle              app.hex32    NOT NULL,
  cleartext_amount    NUMERIC,
  cleartext_source    TEXT CHECK (cleartext_source IN ('disclosed','user_decrypt')),
  status              TEXT NOT NULL CHECK (status IN ('ready','done','no_acl','failed')),
  assigned_signer     app.address,
  tried_signers       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_from_idx ON app.transfers (from_addr);
CREATE INDEX IF NOT EXISTS transfers_to_idx ON app.transfers (to_addr);
CREATE INDEX IF NOT EXISTS transfers_handle_idx ON app.transfers (handle);
CREATE INDEX IF NOT EXISTS transfers_status_idx ON app.transfers (status)
  WHERE status IN ('ready','no_acl');
CREATE INDEX IF NOT EXISTS transfers_block_idx ON app.transfers (block DESC, log_index DESC);

-- ── Disclosed amounts (free cleartext path) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS app.disclosed_amounts (
  handle      app.hex32 PRIMARY KEY,
  amount      NUMERIC   NOT NULL,
  block       BIGINT    NOT NULL,
  tx_hash     app.hex32 NOT NULL,
  log_index   INT       NOT NULL
);

-- ── Operators (plaintext metadata) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app.operators (
  holder       app.address NOT NULL,
  operator     app.address NOT NULL,
  until_ts     BIGINT      NOT NULL,
  set_at_block BIGINT      NOT NULL,
  PRIMARY KEY (holder, operator)
);
CREATE INDEX IF NOT EXISTS operators_holder_idx ON app.operators (holder);

-- ── Per-address balance projection ──────────────────────────────────────────
-- Refreshed via handle-read RPC, not sum-of-transfers. Source distinguishes
-- the three "null" cases at API level (never_shielded vs no_decrypt_rights vs zero).

CREATE TABLE IF NOT EXISTS app.balances (
  addr             app.address PRIMARY KEY,
  current_handle   app.hex32,
  cleartext_amount NUMERIC,
  source           TEXT CHECK (source IN ('decrypted','disclosed','never_shielded','no_decrypt_rights')),
  stale            BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at_block BIGINT,
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS balances_stale_idx ON app.balances (stale) WHERE stale;

-- ── Signer config (operator-managed) ────────────────────────────────────────
-- One row per signing identity the indexer can use. The address is the join
-- key against on-chain ACL state.

CREATE TABLE IF NOT EXISTS app.signers (
  addr       app.address PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('local_eoa','fireblocks','aws_kms','silence_labs','turnkey')),
  config     JSONB NOT NULL,
  cost_rank  INT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  added_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signers_cost_rank_idx ON app.signers (cost_rank) WHERE enabled;

-- ── Indexer head (for /health) ──────────────────────────────────────────────
-- Single-row table updated by Envio handler or external poller. Records the
-- last processed (block, log_index) so /health can report behindBlocks.

CREATE TABLE IF NOT EXISTS app.indexer_state (
  id              INT PRIMARY KEY DEFAULT 1,
  last_block      BIGINT NOT NULL DEFAULT 0,
  last_log_index  INT    NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CHECK (id = 1)
);
INSERT INTO app.indexer_state (id) VALUES (1) ON CONFLICT DO NOTHING;
