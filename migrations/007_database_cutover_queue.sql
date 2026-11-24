-- The migration barrier waits for active handlers before freezing business data.
-- Authenticated webhooks arriving during a cutover are acknowledged only after
-- durable storage. Normal operation does not put events in this inbox.
CREATE TABLE IF NOT EXISTS wp_voice_ping.migration_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  accepting boolean NOT NULL DEFAULT true
);
INSERT INTO wp_voice_ping.migration_state (id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS wp_voice_ping.migration_inbox (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ghl', 'telegram')),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  forwarded_at timestamptz
);
CREATE INDEX IF NOT EXISTS migration_inbox_pending_idx
  ON wp_voice_ping.migration_inbox (received_at) WHERE forwarded_at IS NULL;

ALTER TABLE wp_voice_ping.migration_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE wp_voice_ping.migration_inbox ENABLE ROW LEVEL SECURITY;
