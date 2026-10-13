ALTER TABLE wp_voice_ping.sales_users
  ADD COLUMN IF NOT EXISTS can_manage_bot boolean NOT NULL DEFAULT false;

-- Global call recipients remain controlled by is_admin. Bot management is
-- intentionally restricted to Dmitry's profile and verified Telegram ID.
UPDATE wp_voice_ping.sales_users
SET can_manage_bot = (id = '10000000-0000-4000-8000-000000000006'),
    updated_at = now()
WHERE can_manage_bot IS DISTINCT FROM (id = '10000000-0000-4000-8000-000000000006');

-- A numeric Telegram account can never be attached to two sales profiles.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bindings_telegram_user_unique
  ON wp_voice_ping.telegram_bindings (telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;

INSERT INTO wp_voice_ping.sales_users (id, name, telegram_username, notes)
VALUES
  ('10000000-0000-4000-8000-000000000007', 'Iryna Zienina', 'iryna_dzen', 'Verified in GHL API on 2026-10-14'),
  ('10000000-0000-4000-8000-000000000008', 'Daria Inozemtseva', 'iamdariaria', 'Verified in GHL API on 2026-10-14'),
  ('10000000-0000-4000-8000-000000000009', 'Shafag Ibragimova', NULL, 'Reference phone +380990331599; never use for Telegram identity'),
  ('10000000-0000-4000-8000-000000000010', 'Tetiana Mushyn', 'tania_mushyn', 'Verified in GHL API on 2026-10-14')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  telegram_username = COALESCE(wp_voice_ping.sales_users.telegram_username, EXCLUDED.telegram_username),
  notes = COALESCE(wp_voice_ping.sales_users.notes, EXCLUDED.notes),
  updated_at = now();

-- WallPanels: all four users were returned by the live GHL Users API.
INSERT INTO wp_voice_ping.sales_location_users (id, sales_user_id, location_id, ghl_user_id, source)
VALUES
  ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000007', 'Iwpfx8zGzpsZszcnGovT', 'gJdzhMufQAdwvqxhXRKC', 'GHL Users API verified 2026-10-14'),
  ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000008', 'Iwpfx8zGzpsZszcnGovT', 'csnjXlwT7zhYT0aB3wlu', 'GHL Users API verified 2026-10-14'),
  ('20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000009', 'Iwpfx8zGzpsZszcnGovT', 'uDSeYlJ8yX62HJrk3yV0', 'GHL Users API verified 2026-10-14'),
  ('20000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000010', 'Iwpfx8zGzpsZszcnGovT', 'azNjk6NEfj1Joox6Z8r8', 'GHL Users API verified 2026-10-14')
ON CONFLICT (location_id, ghl_user_id) DO UPDATE SET
  active = true,
  updated_at = now();

-- Verona Home: only Daria and Shafag were returned by the live GHL Users API.
INSERT INTO wp_voice_ping.sales_location_users (id, sales_user_id, location_id, ghl_user_id, source)
VALUES
  ('20000000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000008', 'pSsHdL8pyBsLeIci1Py0', 'csnjXlwT7zhYT0aB3wlu', 'GHL Users API verified 2026-10-14'),
  ('20000000-0000-4000-8000-000000000016', '10000000-0000-4000-8000-000000000009', 'pSsHdL8pyBsLeIci1Py0', 'uDSeYlJ8yX62HJrk3yV0', 'GHL Users API verified 2026-10-14')
ON CONFLICT (location_id, ghl_user_id) DO UPDATE SET
  active = true,
  updated_at = now();
