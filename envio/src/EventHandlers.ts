/**
 * Envio's entity ORM lacks raw SQL access required for the pickSignerForTransfer
 * CTE, so canonical business state lives in app.* via a side-loaded postgres.js
 * client. NATS publishes happen after PG commit and are awaited so Envio's
 * at-least-once block retry covers transient NATS failures.
 */
import { indexer } from "envio";
import postgres from "postgres";
import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { getAddress } from "viem";

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

function normAddr(s: string): string {
  return getAddress(s);
}

function normHandle(s: string): string {
  if (!HEX32_RE.test(s)) throw new Error(`invalid hex32: ${s}`);
  return s.toLowerCase();
}

let _sql: postgres.Sql | null = null;
function sql(): postgres.Sql {
  if (_sql) return _sql;
  const url =
    process.env.DATABASE_URL ??
    `postgres://${process.env.ENVIO_PG_USER ?? "postgres"}:${process.env.ENVIO_PG_PASSWORD ?? "testing"}@${process.env.ENVIO_PG_HOST ?? "localhost"}:${process.env.ENVIO_PG_PORT ?? "5432"}/${process.env.ENVIO_PG_DATABASE ?? "envio-dev"}`;
  _sql = postgres(url, { max: 5, onnotice: () => {} });
  return _sql;
}

let _natsCtx: { js: ReturnType<typeof jetstream> } | null = null;
async function nats() {
  if (_natsCtx) return _natsCtx;
  const url = process.env.NATS_URL ?? "nats://localhost:4222";
  const nc = await connect({ servers: url });
  const js = jetstream(nc);
  _natsCtx = { js };
  return _natsCtx;
}

async function publishWork(signerAddr: string, rowId: number) {
  const { js } = await nats();
  const body = new TextEncoder().encode(JSON.stringify({ rowId }));
  await js.publish(`decrypt.${signerAddr}`, body);
}

async function pickSigner(args: {
  from: string;
  to: string;
  handle: string;
  contract: string;
}): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await sql()<{ addr: string }[]>`
    WITH eligible AS (
      SELECT ${args.from}::app.address AS addr
      UNION SELECT ${args.to}::app.address
      UNION SELECT account FROM app.handle_rights_current WHERE handle = ${args.handle}
      UNION SELECT delegatee FROM app.delegations_current
        WHERE delegator IN (${args.from}, ${args.to})
          AND target_contract = ${args.contract}
          AND expiration_ts > ${nowSec}
    )
    SELECT s.addr FROM eligible e
    JOIN app.signers s ON s.addr = e.addr
    WHERE s.enabled
    ORDER BY s.cost_rank ASC LIMIT 1
  `;
  return rows[0]?.addr ?? null;
}

async function backfillForNewSigner(account: string): Promise<{ id: number }[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  return sql()<{ id: number }[]>`
    UPDATE app.transfers t
    SET status='ready', assigned_signer=${account}, attempts=0, last_error=NULL,
        tried_signers=ARRAY[]::TEXT[], updated_at=now()
    WHERE t.status='no_acl'
      AND (
        t.from_addr=${account}
        OR t.to_addr=${account}
        OR EXISTS (SELECT 1 FROM app.handle_rights_current WHERE handle=t.handle AND account=${account})
        OR EXISTS (SELECT 1 FROM app.delegations_current
                   WHERE delegatee=${account} AND target_contract=t.contract
                     AND expiration_ts > ${nowSec}
                     AND delegator IN (t.from_addr, t.to_addr))
      )
    RETURNING id`;
}

async function markStale(addrs: string[]) {
  if (!addrs.length) return;
  await sql()`
    INSERT INTO app.balances (addr, stale)
    SELECT addr, TRUE FROM unnest(${addrs}::TEXT[]) AS t(addr)
    ON CONFLICT (addr) DO UPDATE SET stale=TRUE, updated_at=now()`;
}

// Envio's internal rollback callback: fires once per affected chain after Envio
// rolls back its entity store. We mirror the rollback into app.* so our
// cleartext/ACL/balance state stays consistent with the chain.
// API name has "~internalAndWillBeRemovedSoon_" — swap when stable equivalent
// ships; the body (rollbackAppSchema call) is unaffected.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(indexer as any)["~internalAndWillBeRemovedSoon_onRollbackCommit"](
  async ({ chainId, rollbackToBlock }: { chainId: number; rollbackToBlock: number }) => {
    const { rollbackAppSchema } = await import("../../src/db/rollback.js");
    const counts = await rollbackAppSchema(sql(), rollbackToBlock);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: "reorg_rollback", chainId, rollbackToBlock, ...counts }));
  },
);

indexer.onEvent(
  { contract: "ConfidentialToken", event: "ConfidentialTransfer" },
  async ({ event, context }) => {
    const from = normAddr(event.params.from);
    const to = normAddr(event.params.to);
    const handle = normHandle(event.params.amount);
    const contract = normAddr(event.srcAddress);
    const meta = {
      block: Number(event.block.number),
      log_index: event.logIndex,
      tx_hash: normHandle(event.transaction.hash),
    };

    context.log.debug(`ConfidentialTransfer ${from}→${to} handle=${handle}`);

    context.RawEvent.set({
      id: `${meta.tx_hash}-${meta.log_index}`,
      kind: "ConfidentialTransfer",
      block: BigInt(meta.block),
      txHash: meta.tx_hash,
      logIndex: meta.log_index,
      payload: JSON.stringify({ from, to, handle }),
    });

    if (context.isPreload) return;

    const s = sql();
    const disclosed = await s<{ amount: string }[]>`SELECT amount FROM app.disclosed_amounts WHERE handle = ${handle}`;
    if (disclosed.length) {
      await s`
        INSERT INTO app.transfers
          (block, log_index, tx_hash, contract, from_addr, to_addr, handle,
           cleartext_amount, cleartext_source, status, assigned_signer)
        VALUES (${meta.block}, ${meta.log_index}, ${meta.tx_hash}, ${contract},
                ${from}, ${to}, ${handle},
                ${disclosed[0]!.amount}, 'disclosed', 'done', NULL)
        ON CONFLICT (tx_hash, log_index) DO NOTHING`;
      await markStale([from, to]);
      return;
    }

    const chosen = await pickSigner({ from, to, handle, contract });
    if (!chosen) {
      await s`
        INSERT INTO app.transfers
          (block, log_index, tx_hash, contract, from_addr, to_addr, handle, status, assigned_signer)
        VALUES (${meta.block}, ${meta.log_index}, ${meta.tx_hash}, ${contract},
                ${from}, ${to}, ${handle}, 'no_acl', NULL)
        ON CONFLICT (tx_hash, log_index) DO NOTHING`;
      await markStale([from, to]);
      return;
    }

    const inserted = await s<{ id: number }[]>`
      INSERT INTO app.transfers
        (block, log_index, tx_hash, contract, from_addr, to_addr, handle, status, assigned_signer)
      VALUES (${meta.block}, ${meta.log_index}, ${meta.tx_hash}, ${contract},
              ${from}, ${to}, ${handle}, 'ready', ${chosen})
      ON CONFLICT (tx_hash, log_index) DO NOTHING
      RETURNING id`;
    const id = inserted[0]?.id;
    await markStale([from, to]);
    if (id != null) await publishWork(chosen, id);
  },
);

indexer.onEvent(
  { contract: "ConfidentialToken", event: "AmountDisclosed" },
  async ({ event, context }) => {
    if (context.isPreload) return;
    const handle = normHandle(event.params.encryptedAmount);
    const amount = String(event.params.amount);
    const meta = {
      block: Number(event.block.number),
      log_index: event.logIndex,
      tx_hash: normHandle(event.transaction.hash),
    };
    const s = sql();
    await s`
      INSERT INTO app.disclosed_amounts (handle, amount, block, tx_hash, log_index)
      VALUES (${handle}, ${amount}, ${meta.block}, ${meta.tx_hash}, ${meta.log_index})
      ON CONFLICT (handle) DO NOTHING`;
    const updated = await s<{ from_addr: string; to_addr: string }[]>`
      UPDATE app.transfers
      SET cleartext_amount=${amount}, cleartext_source='disclosed', status='done',
          updated_at=now()
      WHERE handle=${handle} AND cleartext_amount IS NULL
      RETURNING from_addr, to_addr`;
    const addrs = Array.from(new Set(updated.flatMap((r) => [r.from_addr, r.to_addr])));
    if (addrs.length) await markStale(addrs);
  },
);

indexer.onEvent(
  { contract: "ConfidentialToken", event: "OperatorSet" },
  async ({ event, context }) => {
    if (context.isPreload) return;
    const holder = normAddr(event.params.holder);
    const operator = normAddr(event.params.operator);
    const until = Number(event.params.until);
    await sql()`
      INSERT INTO app.operators (holder, operator, until_ts, set_at_block)
      VALUES (${holder}, ${operator}, ${until}, ${Number(event.block.number)})
      ON CONFLICT (holder, operator) DO UPDATE SET
        until_ts=EXCLUDED.until_ts, set_at_block=EXCLUDED.set_at_block`;
  },
);

indexer.onEvent(
  { contract: "ACL", event: "Allowed" },
  async ({ event, context }) => {
    if (context.isPreload) return;
    const account = normAddr(event.params.account);
    const handle = normHandle(event.params.handle);
    const block = Number(event.block.number);
    const logIndex = event.logIndex;
    const s = sql();
    await s`
      INSERT INTO app.acl_events (block, log_index, tx_hash, kind, caller, account, handle)
      VALUES (${block}, ${logIndex}, ${normHandle(event.transaction.hash)},
              'allow', ${normAddr(event.params.caller)}, ${account}, ${handle})
      ON CONFLICT (block, log_index) DO NOTHING`;
    await s`
      INSERT INTO app.handle_rights_current (handle, account, granted_at_block, granted_at_log_index)
      VALUES (${handle}, ${account}, ${block}, ${logIndex})
      ON CONFLICT (handle, account) DO UPDATE SET
        granted_at_block=EXCLUDED.granted_at_block,
        granted_at_log_index=EXCLUDED.granted_at_log_index`;

    const isOurs = await s`SELECT 1 FROM app.signers WHERE addr=${account} AND enabled LIMIT 1`;
    if (isOurs.length) {
      const updated = await backfillForNewSigner(account);
      for (const r of updated) await publishWork(account, r.id);
    }
  },
);

indexer.onEvent(
  { contract: "ACL", event: "DelegatedForUserDecryption" },
  async ({ event, context }) => {
    if (context.isPreload) return;
    const delegator = normAddr(event.params.delegator);
    const delegatee = normAddr(event.params.delegate);
    const contract = normAddr(event.params.contractAddress);
    const counter = Number(event.params.delegationCounter);
    const newExp = Number(event.params.newExpirationDate);
    const block = Number(event.block.number);
    const logIndex = event.logIndex;
    const s = sql();
    await s`
      INSERT INTO app.delegations_current
        (delegator, delegatee, target_contract, expiration_ts, delegation_counter,
         last_changed_block, last_changed_log_index)
      VALUES (${delegator}, ${delegatee}, ${contract}, ${newExp}, ${counter},
              ${block}, ${logIndex})
      ON CONFLICT (delegator, delegatee, target_contract) DO UPDATE SET
        expiration_ts=EXCLUDED.expiration_ts,
        delegation_counter=EXCLUDED.delegation_counter,
        last_changed_block=EXCLUDED.last_changed_block,
        last_changed_log_index=EXCLUDED.last_changed_log_index`;

    const isOurs = await s`SELECT 1 FROM app.signers WHERE addr=${delegatee} AND enabled LIMIT 1`;
    if (isOurs.length) {
      const updated = await backfillForNewSigner(delegatee);
      for (const r of updated) await publishWork(delegatee, r.id);
    }
  },
);

indexer.onEvent(
  { contract: "ACL", event: "RevokedDelegationForUserDecryption" },
  async ({ event, context }) => {
    if (context.isPreload) return;
    const delegator = normAddr(event.params.delegator);
    const delegatee = normAddr(event.params.delegate);
    const contract = normAddr(event.params.contractAddress);
    const counter = Number(event.params.delegationCounter);
    await sql()`
      UPDATE app.delegations_current
      SET expiration_ts=0, delegation_counter=${counter},
          last_changed_block=${Number(event.block.number)},
          last_changed_log_index=${event.logIndex}
      WHERE delegator=${delegator} AND delegatee=${delegatee} AND target_contract=${contract}`;
  },
);
