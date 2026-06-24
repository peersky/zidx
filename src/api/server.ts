/* eslint-disable @typescript-eslint/no-explicit-any */
import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import pino from "pino";
import { registerHealth } from "./routes/health.js";
import { registerMetrics } from "./routes/metrics.js";
import { registerBalance } from "./routes/balance.js";
import { registerTransfers } from "./routes/transfers.js";
import { registerOperators } from "./routes/operators.js";
import { registerAdmin } from "./routes/admin.js";

const log = pino({ name: "api" });

export async function buildServer() {
  const app = Fastify({ loggerInstance: log as any });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Confidential Indexer API",
        version: "0.1.0",
        description:
          "Read-only HTTP API surfacing cleartext balances and transfer history for ERC-7984 confidential tokens. Designed for wallet partners — three distinct null balance reasons (never_shielded / no_decrypt_rights / encrypted_pending) are exposed explicitly so partner UI can render each honestly without conflating them.",
      },
      tags: [
        { name: "transfers", description: "Indexed transfers with cleartext amounts and null-reason taxonomy" },
        { name: "balances", description: "Per-address cleartext balances with three null-reason variants" },
        { name: "operators", description: "ERC-7984 operator approvals (plaintext metadata)" },
        { name: "health", description: "Liveness, indexer lag, NATS stream stats, Prometheus scrape" },
        { name: "admin", description: "Operator-facing signer management (deploy behind partner gateway)" },
      ],
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list" } });

  app.setErrorHandler((err: any, _req, reply) => {
    log.error({ err: err?.message }, "request error");
    if (err?.statusCode) {
      return reply.code(err.statusCode).send({ error: err.name, message: err.message });
    }
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  registerHealth(app);
  registerMetrics(app);
  registerBalance(app);
  registerTransfers(app);
  registerOperators(app);
  registerAdmin(app);

  return app;
}

export async function start(): Promise<void> {
  const app = await buildServer();
  const port = parseInt(process.env.API_PORT ?? "3000", 10);
  const host = process.env.API_HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  log.info({ port, host, docs: `http://${host}:${port}/docs` }, "API ready");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    log.error({ err: err.message }, "API failed to start");
    process.exit(1);
  });
}
