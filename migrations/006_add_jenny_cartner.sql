-- Jenny Cartner is a regular sales user in both CRM locations.
-- Telegram access is pre-approved only for the exact numeric Telegram ID.
INSERT INTO wp_voice_ping.sales_users (
  id,
  name,
  telegram_username,
  active,
  is_admin,
  can_manage_bot,
  notes
)
VALUES (
  '10000000-0000-4000-8000-000000000012',
  'Jenny Cartner',
  'jenajens',
  true,
  false,
  false,
  'Jenny@wallpanels.com, verified in both GHL locations on 2026-10-26'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  telegram_username = EXCLUDED.telegram_username,
  active = true,
  is_admin = false,
  can_manage_bot = false,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO wp_voice_ping.sales_location_users (
  id,
  sales_user_id,
  location_id,
  ghl_user_id,
  active,
  source
)
VALUES
  (
    '20000000-0000-4000-8000-000000000017',
    '10000000-0000-4000-8000-000000000012',
    'Iwpfx8zGzpsZszcnGovT',
    'SVt7RBmPqRbrBseWfI5r',
    true,
    'GHL Users API verified 2026-10-26'
  ),
  (
    '20000000-0000-4000-8000-000000000018',
    '10000000-0000-4000-8000-000000000012',
    'pSsHdL8pyBsLeIci1Py0',
    'SVt7RBmPqRbrBseWfI5r',
    true,
    'GHL Users API verified 2026-10-26'
  )
ON CONFLICT (location_id, ghl_user_id) DO UPDATE SET
  sales_user_id = EXCLUDED.sales_user_id,
  active = true,
  source = EXCLUDED.source,
  updated_at = now();

-- A private Telegram chat ID normally equals the Telegram user ID, but the
-- binding stays inactive until Jenny presses Start and the bot receives it.
INSERT INTO wp_voice_ping.telegram_bindings (
  id,
  sales_user_id,
  chat_id,
  telegram_user_id,
  telegram_username,
  active,
  verification_method,
  verified_at,
  auto_link_allowed
)
VALUES (
  '30000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000012',
  5428978176,
  5428978176,
  'jenajens',
  false,
  'preapproved_numeric_id',
  NULL,
  true
)
ON CONFLICT (sales_user_id) DO UPDATE SET
  telegram_user_id = EXCLUDED.telegram_user_id,
  telegram_username = EXCLUDED.telegram_username,
  auto_link_allowed = true,
  updated_at = now();
