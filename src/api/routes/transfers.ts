import type { FastifyInstance } from "fastify";
import { getSql } from "../../db/client.js";
import { tryNormAddr } from "../../util/hex.js";
import { encodeCursor, decodeCursor } from "../cursor.js";
import {
  listTransfersByAddr,
  type TransferOutRow,
  type TransferDirection,
} from "../../repositories/queries.js";

interface TransfersQuery {
  limit?: number;
  cursor?: string;
  direction?: TransferDirection;
}

export function registerTransfers(app: FastifyInstance) {
  app.get<{ Params: { addr: string }; Querystring: TransfersQuery }>(
    "/transfers/:addr",
    {
      schema: {
        tags: ["transfers"],
        summary: "Transfer history for an address",
        description:
          "Returns transfers where the address is from or to (or both). `amountCleartext` is null for `no_acl` (we lack decrypt rights), `ready` (queued), or `failed` (all signers exhausted) — `status` and `reason` distinguish each. Pagination uses opaque cursors stable across reorgs; pass `nextCursor` from the previous response as `cursor` to fetch the next page.",
        params: { type: "object", properties: { addr: { type: "string" } }, required: ["addr"] },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            cursor: { type: "string", description: "Opaque pagination cursor from a previous response's nextCursor" },
            direction: { type: "string", enum: ["in", "out", "both"], default: "both", description: "Filter by transfer direction relative to :addr" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "limit", "count", "hasMore"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    block: { type: "integer" },
                    logIndex: { type: "integer" },
                    txHash: { type: "string" },
                    contract: { type: "string" },
                    from: { type: "string" },
                    to: { type: "string" },
                    handle: { type: "string", description: "bytes32 ciphertext pointer" },
                    amountCleartext: { type: ["string", "null"], description: "Decimal string (NUMERIC); null if not decrypted yet" },
                    source: { type: ["string", "null"], description: "user_decrypt | disclosed | null" },
                    status: { type: "string", enum: ["ready", "done", "no_acl", "failed"] },
                    assignedSigner: { type: ["string", "null"] },
                    triedSigners: { type: "array", items: { type: "string" } },
                    lastError: { type: ["string", "null"] },
                    updatedAt: { type: "string", format: "date-time" },
                    reason: { type: ["string", "null"], description: "no_decrypt_rights | encrypted_pending | all_signers_exhausted | null when amountCleartext present" },
                  },
                },
              },
              limit: { type: "integer" },
              count: { type: "integer" },
              nextCursor: { type: ["string", "null"] },
              hasMore: { type: "boolean" },
            },
          },
          400: {
            type: "object",
            properties: { error: { type: "string" }, message: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const addr = tryNormAddr(req.params.addr);
      if (!addr) return reply.code(400).send({ error: "invalid_address" });
      const limit: number = req.query.limit ?? 50;
      const direction: TransferDirection = req.query.direction ?? "both";
      const cursor = decodeCursor(req.query.cursor);

      const sql = getSql();
      const rows = await listTransfersByAddr(sql, { addr, direction, cursor, limit });

      const last = rows[rows.length - 1];
      const nextCursor = rows.length === limit && last
        ? encodeCursor({ block: Number(last.block), logIndex: Number(last.log_index), txHash: last.tx_hash })
        : null;

      return {
        items: rows.map(formatTransfer),
        limit,
        count: rows.length,
        nextCursor,
        hasMore: nextCursor !== null,
      };
    },
  );
}

function formatTransfer(r: TransferOutRow) {
  return {
    id: Number(r.id),
    block: Number(r.block),
    logIndex: Number(r.log_index),
    txHash: r.tx_hash,
    contract: r.contract,
    from: r.from_addr,
    to: r.to_addr,
    handle: r.handle,
    amountCleartext: r.cleartext_amount,
    source: r.cleartext_source,
    status: r.status,
    assignedSigner: r.assigned_signer,
    triedSigners: r.tried_signers,
    lastError: r.last_error,
    updatedAt: r.updated_at,
    reason: r.cleartext_amount !== null
      ? null
      : r.status === "no_acl"
        ? "no_decrypt_rights"
        : r.status === "ready"
          ? "encrypted_pending"
          : r.status === "failed"
            ? "all_signers_exhausted"
            : null,
  };
}
