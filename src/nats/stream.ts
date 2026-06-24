import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { Address } from "../util/hex.js";

const STREAM_NAME = "decrypt-work";
const SUBJECT_PREFIX_WORK = "decrypt.";
const SUBJECT_WILDCARD_WORK = `${SUBJECT_PREFIX_WORK}>`;
const DURABLE_PREFIX = "worker-";
const ADVISORY_SUBJECT = `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${STREAM_NAME}.>`;

export function consumerToSignerAddr(consumerName: string): string {
  return consumerName.startsWith(DURABLE_PREFIX) ? consumerName.slice(DURABLE_PREFIX.length) : consumerName;
}

export interface NatsCtx {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export async function connectNats(url = process.env.NATS_URL ?? "nats://localhost:4222"): Promise<NatsCtx> {
  const nc = await connect({ servers: url });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  return { nc, js, jsm };
}

export async function ensureStream(jsm: JetStreamManager): Promise<void> {
  const subjects = [SUBJECT_WILDCARD_WORK];
  const replicas = parseInt(process.env.NATS_REPLICAS ?? "1", 10);
  const dupWindowNs = 5 * 60 * 1_000_000_000;
  const cfg = {
    name: STREAM_NAME,
    subjects,
    retention: "workqueue",
    storage: "file",
    num_replicas: replicas,
    duplicate_window: dupWindowNs,
  } as const;
  try {
    await jsm.streams.info(STREAM_NAME);
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await jsm.streams.add(cfg as any);
  }
}

export async function ensureConsumerForSigner(jsm: JetStreamManager, addr: Address): Promise<void> {
  const ackWaitSec = parseInt(process.env.NATS_ACK_WAIT_SECONDS ?? "30", 10);
  const maxDeliver = parseInt(process.env.NATS_MAX_DELIVER ?? "3", 10);
  const consumerCfg = {
    durable_name: durableName(addr),
    filter_subject: `${SUBJECT_PREFIX_WORK}${addr}`,
    ack_policy: "explicit",
    ack_wait: ackWaitSec * 1_000_000_000,
    max_deliver: maxDeliver,
    backoff: [1, 5, 30].map((s) => s * 1_000_000_000),
    max_ack_pending: 32,
  } as const;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (jsm as any).consumers.info(STREAM_NAME, durableName(addr));
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (jsm as any).consumers.add(STREAM_NAME, consumerCfg);
  }
}

export function durableName(addr: Address): string {
  return `${DURABLE_PREFIX}${addr.toLowerCase()}`;
}

export function workSubject(addr: Address): string {
  return `${SUBJECT_PREFIX_WORK}${addr}`;
}

export async function publishWork(js: JetStreamClient, signer: Address, payload: { rowId: number }): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (js as any).publish(workSubject(signer), body);
}

export { STREAM_NAME, ADVISORY_SUBJECT };
