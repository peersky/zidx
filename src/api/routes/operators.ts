import type { FastifyInstance } from "fastify";
import { getSql } from "../../db/client.js";
import { tryNormAddr } from "../../util/hex.js";
import { listOperatorsByHolder } from "../../repositories/queries.js";

export function registerOperators(app: FastifyInstance) {
  app.get<{ Params: { holder: string } }>(
    "/operators/:holder",
    {
      schema: {
        tags: ["operators"],
        summary: "ERC-7984 operator approvals for a holder",
        description:
          "Lists current operator addresses approved to transfer the holder's confidential tokens. `until` is the approval expiration as a unix-seconds timestamp; operators with `until` in the past are technically expired on chain but kept here for audit (the spec lets clients filter).",
        params: { type: "object", properties: { holder: { type: "string" } }, required: ["holder"] },
        response: {
          200: {
            type: "object",
            required: ["holder", "operators"],
            properties: {
              holder: { type: "string" },
              operators: {
                type: "array",
                items: {
                  type: "object",
                  required: ["operator", "until", "setAtBlock"],
                  properties: {
                    operator: { type: "string" },
                    until: { type: "integer", description: "unix-seconds timestamp; 0 if never approved" },
                    setAtBlock: { type: "integer" },
                  },
                },
              },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const holder = tryNormAddr(req.params.holder);
      if (!holder) return reply.code(400).send({ error: "invalid_address" });
      const sql = getSql();
      const rows = await listOperatorsByHolder(sql, holder);
      return {
        holder,
        operators: rows.map((r) => ({
          operator: r.operator,
          until: Number(r.until_ts),
          setAtBlock: Number(r.set_at_block),
        })),
      };
    },
  );
}
