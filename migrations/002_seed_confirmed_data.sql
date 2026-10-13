INSERT INTO wp_voice_ping.crm_locations (id, code, name, api_token_env_name)
VALUES
  ('Iwpfx8zGzpsZszcnGovT', 'wallpanels', 'WallPanels', 'GHL_WALLPANELS_TOKEN'),
  ('pSsHdL8pyBsLeIci1Py0', 'verona_home', 'Verona Home', 'GHL_VERONA_TOKEN')
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  api_token_env_name = EXCLUDED.api_token_env_name,
  updated_at = now();

INSERT INTO wp_voice_ping.sales_users (id, name, telegram_username, notes)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'Mary Razumna', 'mariarayme', 'Also listed as Maria Razumna'),
  ('10000000-0000-4000-8000-000000000002', 'Anthony Kosariev', 'tonykosarev', NULL),
  ('10000000-0000-4000-8000-000000000003', 'Katherina', 'katherina_ostroglo', 'Surname not present in the source document'),
  ('10000000-0000-4000-8000-000000000004', 'Kate Lukovych', 'lukovychk', 'Telegram chat ID pending /start'),
  ('10000000-0000-4000-8000-000000000005', 'Kit Pavano / Irakli', 'irakli_kit', 'Telegram chat ID pending /start'),
  ('10000000-0000-4000-8000-000000000006', 'Dmitry', 'dimaqim', 'GHL User ID and approved sales status pending')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  telegram_username = EXCLUDED.telegram_username,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO wp_voice_ping.sales_location_users (id, sales_user_id, location_id, ghl_user_id, source)
VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Iwpfx8zGzpsZszcnGovT', 'Gs25dBGG2DSUf2qA88gZ', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'pSsHdL8pyBsLeIci1Py0', 'Gs25dBGG2DSUf2qA88gZ', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'Iwpfx8zGzpsZszcnGovT', 'ea35fI6kkxWgpwgErBN1', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'pSsHdL8pyBsLeIci1Py0', 'ea35fI6kkxWgpwgErBN1', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000003', 'Iwpfx8zGzpsZszcnGovT', 'EYCtZOPQ1VBWBRoK4ac7', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000003', 'pSsHdL8pyBsLeIci1Py0', 'EYCtZOPQ1VBWBRoK4ac7', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000004', 'Iwpfx8zGzpsZszcnGovT', 'fSZbcPanLt7blSy229yj', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000004', 'pSsHdL8pyBsLeIci1Py0', 'fSZbcPanLt7blSy229yj', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000005', 'Iwpfx8zGzpsZszcnGovT', '9Od5CWbsOGd2W2TtG2FX', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map'),
  ('20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000005', 'pSsHdL8pyBsLeIci1Py0', '9Od5CWbsOGd2W2TtG2FX', 'WPVH_TELEGRAM_BOT_REUSE staff_ghl_map')
ON CONFLICT (id) DO UPDATE SET
  ghl_user_id = EXCLUDED.ghl_user_id,
  source = EXCLUDED.source,
  updated_at = now();

-- Legacy chat IDs are preserved but deliberately inactive. Each person must
-- confirm ownership through /start and a one-time code in the new bot.
INSERT INTO wp_voice_ping.telegram_bindings (
  id,
  sales_user_id,
  chat_id,
  telegram_user_id,
  telegram_username,
  active,
  verification_method,
  verified_at
)
VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 592334621, 592334621, 'mariarayme', false, 'legacy_import_unverified', NULL),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 342790056, 342790056, 'tonykosarev', false, 'legacy_import_unverified', NULL),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 304489296, 304489296, 'katherina_ostroglo', false, 'legacy_import_unverified', NULL),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000006', 364830430, 364830430, 'dimaqim', false, 'legacy_import_unverified', NULL)
ON CONFLICT (sales_user_id) DO UPDATE SET
  chat_id = EXCLUDED.chat_id,
  telegram_user_id = EXCLUDED.telegram_user_id,
  telegram_username = EXCLUDED.telegram_username,
  active = false,
  verification_method = 'legacy_import_unverified',
  verified_at = NULL,
  updated_at = now();
