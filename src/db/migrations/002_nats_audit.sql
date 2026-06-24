CREATE TABLE IF NOT EXISTS app.nats_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL CHECK (kind IN ('msg_terminated','msg_naked','consumer_created','consumer_deleted')),
  subject     TEXT NOT NULL,
  stream      TEXT,
  consumer    TEXT,
  stream_seq  BIGINT,
  deliveries  INT,
  payload     JSONB
);

CREATE INDEX IF NOT EXISTS nats_events_ts_idx ON app.nats_events (ts DESC);
CREATE INDEX IF NOT EXISTS nats_events_consumer_idx ON app.nats_events (consumer, ts DESC);
CREATE INDEX IF NOT EXISTS nats_events_kind_idx ON app.nats_events (kind, ts DESC);
