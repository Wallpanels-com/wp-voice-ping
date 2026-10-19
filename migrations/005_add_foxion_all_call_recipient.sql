-- Keep Katherina as an all-call recipient without bot-management access.
UPDATE wp_voice_ping.sales_users
SET active = true,
    is_admin = true,
    can_manage_bot = false,
    telegram_username = 'katherina_ostroglo',
    updated_at = now()
WHERE id = '10000000-0000-4000-8000-000000000003';

UPDATE wp_voice_ping.telegram_bindings
SET telegram_user_id = 304489296,
    telegram_username = 'katherina_ostroglo',
    auto_link_allowed = true,
    updated_at = now()
WHERE sales_user_id = '10000000-0000-4000-8000-000000000003';

-- Foxion is a global call recipient, matching Dmitry and Katherina for
-- notification routing, but does not receive bot-management permissions.
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
  '10000000-0000-4000-8000-000000000011',
  'Foxion CEO',
  'FoxionCEO',
  true,
  true,
  false,
  'Pre-approved all-call recipient by verified numeric Telegram ID'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  telegram_username = EXCLUDED.telegram_username,
  active = true,
  is_admin = true,
  can_manage_bot = false,
  notes = EXCLUDED.notes,
  updated_at = now();

-- If /start was already pressed, activate immediately from that trusted
-- request. Otherwise the exact numeric ID auto-activates on the first /start.
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
SELECT
  '30000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000011',
  COALESCE(p.chat_id, 468460468),
  468460468,
  COALESCE(p.telegram_username, 'FoxionCEO'),
  p.id IS NOT NULL,
  CASE WHEN p.id IS NOT NULL THEN 'trusted_numeric_id' ELSE 'preapproved_numeric_id' END,
  CASE WHEN p.id IS NOT NULL THEN now() ELSE NULL END,
  true
FROM (VALUES (1)) AS seed(dummy)
LEFT JOIN LATERAL (
  SELECT id, chat_id, telegram_username
  FROM wp_voice_ping.telegram_access_requests
  WHERE telegram_user_id = 468460468
    AND status = 'pending'
  ORDER BY requested_at DESC
  LIMIT 1
) AS p ON true
ON CONFLICT (sales_user_id) DO UPDATE SET
  chat_id = CASE
    WHEN wp_voice_ping.telegram_bindings.active THEN wp_voice_ping.telegram_bindings.chat_id
    ELSE EXCLUDED.chat_id
  END,
  telegram_user_id = EXCLUDED.telegram_user_id,
  telegram_username = COALESCE(EXCLUDED.telegram_username, wp_voice_ping.telegram_bindings.telegram_username),
  active = wp_voice_ping.telegram_bindings.active OR EXCLUDED.active,
  verification_method = CASE
    WHEN wp_voice_ping.telegram_bindings.active THEN wp_voice_ping.telegram_bindings.verification_method
    ELSE EXCLUDED.verification_method
  END,
  verified_at = COALESCE(wp_voice_ping.telegram_bindings.verified_at, EXCLUDED.verified_at),
  auto_link_allowed = true,
  updated_at = now();

UPDATE wp_voice_ping.telegram_access_requests
SET status = 'approved',
    linked_sales_user_id = '10000000-0000-4000-8000-000000000011',
    resolved_by_admin_user_id = '10000000-0000-4000-8000-000000000006',
    resolved_at = now(),
    updated_at = now()
WHERE telegram_user_id = 468460468
  AND status = 'pending';
