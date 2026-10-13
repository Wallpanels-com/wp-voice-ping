ALTER TABLE wp_voice_ping.sales_users
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

ALTER TABLE wp_voice_ping.telegram_bindings
  ADD COLUMN IF NOT EXISTS auto_link_allowed boolean NOT NULL DEFAULT false;

UPDATE wp_voice_ping.sales_users
SET is_admin = telegram_username IN ('dimaqim', 'katherina_ostroglo'),
    updated_at = now()
WHERE telegram_username IN ('dimaqim', 'katherina_ostroglo');

-- These numeric Telegram IDs came from the existing, confirmed staff source.
-- Username is metadata only; automatic access is granted only on an exact ID match.
UPDATE wp_voice_ping.telegram_bindings
SET auto_link_allowed = true,
    updated_at = now()
WHERE verification_method = 'legacy_import_unverified'
  AND telegram_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wp_voice_ping.telegram_access_requests (
  id uuid PRIMARY KEY,
  telegram_user_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  telegram_username text,
  first_name text,
  last_name text,
  status text NOT NULL DEFAULT 'pending',
  linked_sales_user_id uuid REFERENCES wp_voice_ping.sales_users(id) ON DELETE SET NULL,
  resolved_by_admin_user_id uuid REFERENCES wp_voice_ping.sales_users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_access_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_access_requests_pending_user_unique
  ON wp_voice_ping.telegram_access_requests (telegram_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS telegram_access_requests_status_idx
  ON wp_voice_ping.telegram_access_requests (status, requested_at DESC);

ALTER TABLE wp_voice_ping.notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_call_event_id_key;

ALTER TABLE wp_voice_ping.notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_event_sales_unique;

ALTER TABLE wp_voice_ping.notification_deliveries
  ADD CONSTRAINT notification_deliveries_event_sales_unique UNIQUE (call_event_id, sales_user_id);
