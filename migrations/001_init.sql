CREATE SCHEMA IF NOT EXISTS wp_voice_ping;

CREATE TABLE IF NOT EXISTS wp_voice_ping.crm_locations (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  api_token_env_name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wp_voice_ping.sales_users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  telegram_username text,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wp_voice_ping.sales_location_users (
  id uuid PRIMARY KEY,
  sales_user_id uuid NOT NULL REFERENCES wp_voice_ping.sales_users(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES wp_voice_ping.crm_locations(id) ON DELETE RESTRICT,
  ghl_user_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_location_users_location_ghl_unique UNIQUE (location_id, ghl_user_id),
  CONSTRAINT sales_location_users_sales_location_unique UNIQUE (sales_user_id, location_id)
);

CREATE TABLE IF NOT EXISTS wp_voice_ping.telegram_bindings (
  id uuid PRIMARY KEY,
  sales_user_id uuid NOT NULL UNIQUE REFERENCES wp_voice_ping.sales_users(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL UNIQUE,
  telegram_user_id bigint,
  telegram_username text,
  active boolean NOT NULL DEFAULT false,
  verification_method text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_bindings_verified_active CHECK (NOT active OR verified_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS wp_voice_ping.call_events (
  id uuid PRIMARY KEY,
  location_id text NOT NULL REFERENCES wp_voice_ping.crm_locations(id) ON DELETE RESTRICT,
  external_event_id text NOT NULL,
  call_id text,
  contact_id text NOT NULL,
  assigned_ghl_user_id text,
  event_type text NOT NULL,
  call_status text NOT NULL,
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  reason text,
  attempt_count integer NOT NULL DEFAULT 1,
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT call_events_location_event_unique UNIQUE (location_id, external_event_id),
  CONSTRAINT call_events_status_check CHECK (status IN (
    'processing',
    'delivered',
    'waiting_assignee',
    'waiting_binding',
    'unsupported_event',
    'failed_retryable',
    'failed_permanent'
  ))
);

CREATE INDEX IF NOT EXISTS call_events_status_created_idx
  ON wp_voice_ping.call_events (status, created_at DESC);
CREATE INDEX IF NOT EXISTS call_events_contact_idx
  ON wp_voice_ping.call_events (location_id, contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wp_voice_ping.notification_deliveries (
  id uuid PRIMARY KEY,
  call_event_id uuid NOT NULL UNIQUE REFERENCES wp_voice_ping.call_events(id) ON DELETE CASCADE,
  sales_user_id uuid NOT NULL REFERENCES wp_voice_ping.sales_users(id) ON DELETE RESTRICT,
  telegram_chat_id bigint NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  telegram_message_id bigint,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT notification_deliveries_status_check CHECK (status IN (
    'pending',
    'sent',
    'retryable_failure',
    'permanent_failure'
  ))
);

CREATE INDEX IF NOT EXISTS notification_deliveries_status_idx
  ON wp_voice_ping.notification_deliveries (status, created_at DESC);

CREATE TABLE IF NOT EXISTS wp_voice_ping.connection_codes (
  id uuid PRIMARY KEY,
  sales_user_id uuid NOT NULL REFERENCES wp_voice_ping.sales_users(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_chat_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_codes_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS connection_codes_sales_expiry_idx
  ON wp_voice_ping.connection_codes (sales_user_id, expires_at DESC);
