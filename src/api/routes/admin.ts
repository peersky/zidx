/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from "fastify";
import { getSql } from "../../db/client.js";
import { tryNormAddr } from "../../util/hex.js";
import { disableSigner } from "../../repositories/queries.js";
import { registerOrUpdateSigner } from "../../services/signer-admin.js";

export function registerAdmin(app: FastifyInstance) {
  app.post(
    "/admin/signers",
    {
      schema: {
        tags: ["admin"],
        summary: "Register or update a signer; backfill no_acl rows now decryptable by it",
        description:
          "Upserts the signer row (insert or update existing). Runs `backfillForNewSigner` unconditionally — even if NATS is unreachable, PG state stays correct and the worker picks up rows on next message. NATS publishes are best-effort; failure is surfaced as `natsError` in the response, not as a 5xx (PG-only success is still success). The `config` object's shape is backend-specific: `{ privateKeyEnv: 'NAME' }` for `local_eoa`, `{ vaultAccountId, assetId, apiKey, secretPath }` for `fireblocks`, `{ keyId, region }` for `aws_kms`.",
        body: {
          type: "object",
          required: ["addr", "kind", "costRank"],
          properties: {
            addr: { type: "string", description: "EIP-55 checksummed Ethereum address; the universal join key" },
            kind: { type: "string", enum: ["local_eoa", "fireblocks", "aws_kms", "silence_labs", "turnkey"] },
            costRank: { type: "integer", minimum: 0, description: "Lower = preferred. Used by pickSignerForTransfer ORDER BY." },
            config: { type: "object", additionalProperties: true, default: {}, description: "Provider-specific opaque config" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["addr", "backfilled"],
            properties: {
              addr: { type: "string" },
              backfilled: { type: "integer", description: "Number of no_acl rows flipped to ready by this signer becoming eligible" },
              natsError: { type: ["string", "null"], description: "Non-null if NATS publish of wake-ups failed; PG state is still correct" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } },
        },
      },
    },
// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
    async (req: any, reply: any) => {
      const addr = tryNormAddr(req.body.addr);
      if (!addr) return reply.code(400).send({ error: "invalid_address" });
// TODO(slop): placeholder identifier — pick a name that says what this is
      const result = await registerOrUpdateSigner(getSql(), {
        addr,
        kind: req.body.kind,
        config: req.body.config ?? {},
        costRank: req.body.costRank,
      });
      return result;
    },
  );

  app.delete<{ Params: { addr: string } }>(
    "/admin/signers/:addr",
    {
      schema: {
        tags: ["admin"],
        summary: "Disable a signer; pending rows naturally reassigned via escalator on next failure",
        description:
          "Sets `enabled=FALSE` on the row. The signer is kept in `app.signers` for audit trail (so future `tried_signers` entries remain resolvable). Rows currently in `status='ready'` with `assigned_signer = this` are NOT eagerly reassigned — the next decrypt attempt's `max_deliver` exhaustion triggers MAX_DELIVERIES, the escalator re-picks via `pickSignerForTransfer` with the disabled signer excluded, and the row moves on. Returns 404 if the signer doesn't exist.",
        params: { type: "object", required: ["addr"], properties: { addr: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["addr", "enabled"],
            properties: {
              addr: { type: "string" },
              enabled: { type: "boolean", const: false },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
// TODO(slop): `: any` annotation opts out of the type system — use `unknown` and narrow, or define the real type
    async (req: any, reply: any) => {
      const addr = tryNormAddr(req.params.addr);
      if (!addr) return reply.code(400).send({ error: "invalid_address" });
      const ok = await disableSigner(getSql(), addr);
      if (!ok) return reply.code(404).send({ error: "not_found" });
      return { addr, enabled: false };
    },
  );
}
