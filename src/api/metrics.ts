import type { Sql } from "../db/client.js";
import { fetchJetStreamStats } from "../nats/monitoring.js";

const STREAM = "decrypt-work";

interface Counts {
  done: number; ready: number; no_acl: number; failed: number;
}

function metric(name: string, type: "counter" | "gauge", help: string, lines: string[]): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${lines.join("\n")}\n`;
}

export async function renderMetrics(sql: Sql): Promise<string> {
  const [counts] = await sql<Counts[]>`
    SELECT
      COUNT(*) FILTER (WHERE status='done')   AS done,
      COUNT(*) FILTER (WHERE status='ready')  AS ready,
      COUNT(*) FILTER (WHERE status='no_acl') AS no_acl,
      COUNT(*) FILTER (WHERE status='failed') AS failed
    FROM app.transfers`;
  const [signers] = await sql<{ enabled: string }[]>`SELECT COUNT(*) AS enabled FROM app.signers WHERE enabled`;
  const [state] = await sql<{ last_block: string }[]>`SELECT last_block FROM app.indexer_state WHERE id=1`;
  const nats = await fetchJetStreamStats(STREAM);

  const parts: string[] = [];

  parts.push(
    metric("confidential_indexer_transfers_total", "gauge", "Transfer rows per status", [
      `confidential_indexer_transfers_total{status="done"} ${Number(counts?.done ?? 0)}`,
      `confidential_indexer_transfers_total{status="ready"} ${Number(counts?.ready ?? 0)}`,
      `confidential_indexer_transfers_total{status="no_acl"} ${Number(counts?.no_acl ?? 0)}`,
      `confidential_indexer_transfers_total{status="failed"} ${Number(counts?.failed ?? 0)}`,
    ]),
  );

  parts.push(
    metric("confidential_indexer_signers_enabled", "gauge", "Enabled signer count", [
      `confidential_indexer_signers_enabled ${Number(signers?.enabled ?? 0)}`,
    ]),
  );

  parts.push(
    metric("confidential_indexer_last_block", "gauge", "Last processed block from app.indexer_state", [
      `confidential_indexer_last_block ${Number(state?.last_block ?? 0)}`,
    ]),
  );

  if (nats) {
    parts.push(
      metric("nats_stream_messages", "gauge", "Messages currently in the NATS stream", [
        `nats_stream_messages{stream="${nats.stream}"} ${nats.messages}`,
      ]),
    );
    parts.push(
      metric("nats_stream_bytes", "gauge", "Bytes currently stored in the NATS stream", [
        `nats_stream_bytes{stream="${nats.stream}"} ${nats.bytes}`,
      ]),
    );
    const pendingLines = nats.consumers.map(
      (c) => `nats_consumer_num_pending{stream="${nats.stream}",consumer="${c.name}"} ${c.numPending}`,
    );
    if (pendingLines.length) {
      parts.push(metric("nats_consumer_num_pending", "gauge", "Pending messages per consumer (autoscale signal)", pendingLines));
    }
    const ackPendingLines = nats.consumers.map(
      (c) => `nats_consumer_num_ack_pending{stream="${nats.stream}",consumer="${c.name}"} ${c.numAckPending}`,
    );
    if (ackPendingLines.length) {
      parts.push(metric("nats_consumer_num_ack_pending", "gauge", "Delivered-but-unacked messages per consumer", ackPendingLines));
    }
    const redeliveredLines = nats.consumers.map(
      (c) => `nats_consumer_num_redelivered{stream="${nats.stream}",consumer="${c.name}"} ${c.numRedelivered}`,
    );
    if (redeliveredLines.length) {
      parts.push(metric("nats_consumer_num_redelivered", "counter", "Currently being redelivered per consumer", redeliveredLines));
    }
  }

  return parts.join("");
}
