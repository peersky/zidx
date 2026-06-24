/**
 * Polls NATS server's HTTP monitoring endpoint (`/jsz`) to extract per-stream +
 * per-consumer stats — primarily `num_pending` for autoscaling and `/health`.
 * https://docs.nats.io/running-a-nats-service/nats_admin/monitoring
 */

export interface NatsStreamStats {
  stream: string;
  messages: number;
  bytes: number;
  consumers: NatsConsumerStats[];
}

export interface NatsConsumerStats {
  name: string;
  numPending: number;       // messages waiting to be delivered
  numAckPending: number;    // delivered but not yet ack'd
  numRedelivered: number;   // currently being redelivered
  numWaiting: number;       // pull-mode waiting consumers
  deliveredConsumerSeq: number;
  ackFloorConsumerSeq: number;
}

function monitoringUrl(): string {
  const explicit = process.env.NATS_MONITORING_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
  const u = new URL(natsUrl);
  const port = u.port === "4222" ? "8222" : u.port;
  return `http://${u.hostname}:${port}`;
}

export async function fetchJetStreamStats(streamName: string, timeoutMs = 1500): Promise<NatsStreamStats | null> {
  const url = `${monitoringUrl()}/jsz?streams=1&consumers=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { account_details?: AccountDetail[] };
    for (const acct of body.account_details ?? []) {
      for (const s of acct.stream_detail ?? []) {
        if (s.name !== streamName) continue;
        return {
          stream: s.name,
          messages: s.state?.messages ?? 0,
          bytes: s.state?.bytes ?? 0,
          consumers: (s.consumer_detail ?? []).map((c) => ({
            name: c.name,
            numPending: c.num_pending ?? 0,
            numAckPending: c.num_ack_pending ?? 0,
            numRedelivered: c.num_redelivered ?? 0,
            numWaiting: c.num_waiting ?? 0,
            deliveredConsumerSeq: c.delivered?.consumer_seq ?? 0,
            ackFloorConsumerSeq: c.ack_floor?.consumer_seq ?? 0,
          })),
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface AccountDetail {
  stream_detail?: StreamDetail[];
}
interface StreamDetail {
  name: string;
  state?: { messages?: number; bytes?: number };
  consumer_detail?: ConsumerDetail[];
}
interface ConsumerDetail {
  name: string;
  num_pending?: number;
  num_ack_pending?: number;
  num_redelivered?: number;
  num_waiting?: number;
  delivered?: { consumer_seq?: number };
  ack_floor?: { consumer_seq?: number };
}
