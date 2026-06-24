import type { FastifyInstance } from "fastify";
import { getSql } from "../../db/client.js";
import { fetchJetStreamStats } from "../../nats/monitoring.js";
import { STREAM_NAME } from "../../nats/stream.js";
import { getIndexerState, getTransferStatusCounts } from "../../repositories/queries.js";

export function registerHealth(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness + indexer state + NATS stream stats",
        description:
          "Single endpoint for ops dashboards: indexer head block, transfer-status counts, and live NATS consumer stats polled from the /jsz monitoring port. `nats` is null when /jsz is unreachable so /health stays healthy under partial outage (alert on null for ops). Configure NATS_MONITORING_URL to override the auto-derived monitoring URL.",
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              indexer: {
                type: "object",
                properties: {
                  lastBlock: { type: "integer" },
                  updatedAt: { type: "string" },
                },
              },
              counts: {
                type: "object",
                properties: {
                  done: { type: "integer" },
                  ready: { type: "integer" },
                  noAcl: { type: "integer" },
                  failed: { type: "integer" },
                },
              },
              nats: {
                type: ["object", "null"],
                properties: {
                  stream: { type: "string" },
                  messages: { type: "integer" },
                  bytes: { type: "integer" },
                  consumers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        numPending: { type: "integer" },
                        numAckPending: { type: "integer" },
                        numRedelivered: { type: "integer" },
                        numWaiting: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      const sql = getSql();
      const state = await getIndexerState(sql);
      const counts = await getTransferStatusCounts(sql);
      const natsStats = await fetchJetStreamStats(STREAM_NAME);
      return {
        ok: true,
        indexer: {
          lastBlock: state?.last_block != null ? Number(state.last_block) : 0,
          updatedAt: state?.updated_at ?? new Date(0).toISOString(),
        },
        counts: {
          done: counts.done,
          ready: counts.ready,
          noAcl: counts.no_acl,
          failed: counts.failed,
        },
        nats: natsStats,
      };
    },
  );
}
