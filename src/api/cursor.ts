/**
 * Opaque cursor for /transfers pagination.
 *
 * Encodes (block, log_index, tx_hash). DESC ordering by (block, log_index) is
 * stable across reorgs because Envio re-applies events idempotently — the
 * cursor's lexicographic comparison still selects "rows older than this point"
 * in the new chain history. tx_hash is included for forensics + breaking ties
 * when the client wants to verify the boundary row.
 *
 * Format: base64url of `b<block>.l<logIndex>.t<txHash without 0x>`.
 * Compact, human-debuggable when base64-decoded, single line.
 */

export interface TransfersCursor {
  block: number;
  logIndex: number;
  txHash: string;        // 0x-prefixed lowercase hex32
}

const RE = /^b(\d+)\.l(\d+)\.t([0-9a-f]{64})$/;

export function encodeCursor(c: TransfersCursor): string {
  const raw = `b${c.block}.l${c.logIndex}.t${c.txHash.replace(/^0x/, "").toLowerCase()}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(s: string | undefined | null): TransfersCursor | null {
  if (!s) return null;
  let raw: string;
  try {
    raw = Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const m = RE.exec(raw);
  if (!m) return null;
  const block = Number(m[1]);
  const logIndex = Number(m[2]);
  if (!Number.isFinite(block) || !Number.isFinite(logIndex)) return null;
  return { block, logIndex, txHash: `0x${m[3]}` };
}
