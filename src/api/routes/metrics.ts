import type { FastifyInstance } from "fastify";
import { getSql } from "../../db/client.js";
import { renderMetrics } from "../metrics.js";

export function registerMetrics(app: FastifyInstance) {
  app.get(
    "/metrics",
    {
      schema: {
        tags: ["health"],
        summary: "Prometheus scrape endpoint",
        description:
          "Text format (`# HELP / # TYPE` lines + gauges). PG-side gauges always present: confidential_indexer_transfers_total{status}, signers_enabled, last_block. NATS-side gauges (nats_stream_messages, nats_consumer_num_pending, etc.) present only when /jsz reachable. Primary HPA signal is `nats_consumer_num_pending{stream='decrypt-work',consumer='worker-<addr>'}`.",
        produces: ["text/plain"],
      },
    },
    async (_req, reply) => {
      const text = await renderMetrics(getSql());
      reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      return text;
    },
  );
}
