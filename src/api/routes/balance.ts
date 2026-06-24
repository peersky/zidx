import type { FastifyInstance } from "fastify";
import { getSql } from "../../db/client.js";
import { tryNormAddr } from "../../util/hex.js";
import { getBalanceByAddr } from "../../repositories/queries.js";

export function registerBalance(app: FastifyInstance) {
  app.get<{ Params: { addr: string } }>(
    "/balance/:addr",
    {
      schema: {
        tags: ["balances"],
        summary: "Current cleartext balance for an address",
        description:
          "Three distinct null cases: `never_shielded` (no encrypted balance handle exists), `no_decrypt_rights` (handle exists, no signer in this indexer can decrypt), and `encrypted_pending` (handle exists, decrypt queued or in progress). When `amount` is present, `source` distinguishes whether it came from a userDecrypt call or an on-chain AmountDisclosed event.",
        params: {
          type: "object",
          properties: { addr: { type: "string" } },
          required: ["addr"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              addr: { type: "string" },
              amount: { type: ["string", "null"] },
              source: { type: ["string", "null"] },
              reason: { type: ["string", "null"] },
              currentHandle: { type: ["string", "null"] },
              updatedAtBlock: { type: ["integer", "null"] },
              stale: { type: "boolean" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const addr = tryNormAddr(req.params.addr);
      if (!addr) return reply.code(400).send({ error: "invalid_address", message: `bad address: ${req.params.addr}` });
      const sql = getSql();
      const row = await getBalanceByAddr(sql, addr);

      if (!row) {
        return {
          addr,
          amount: null,
          source: null,
          reason: "not_observed",
          currentHandle: null,
          updatedAtBlock: null,
          stale: false,
        };
      }
      const reason =
        row.cleartext_amount === null
          ? row.source === "never_shielded"
            ? "never_shielded"
            : row.source === "no_decrypt_rights"
              ? "no_decrypt_rights"
              : "encrypted_pending"
          : null;
      return {
        addr,
        amount: row.cleartext_amount,
        source: row.cleartext_amount !== null ? (row.source ?? "decrypted") : row.source,
        reason,
        currentHandle: row.current_handle,
        updatedAtBlock: row.updated_at_block != null ? Number(row.updated_at_block) : null,
        stale: row.stale,
      };
    },
  );
}
