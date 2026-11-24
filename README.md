# WP Voice Ping

WP Voice Ping receives completed Voice AI call events from a GoHighLevel Workflow. It notifies the contact's current Assigned User and every active all-call recipient. It supports WallPanels and Verona Home without mixing their credentials or mappings.

## Routing guarantee

The recipient is resolved in this order:

1. Validate the location and webhook secret.
2. Fetch the current contact from the matching GoHighLevel location.
3. Read `contact.assignedTo` from GoHighLevel.
4. Resolve the active database mapping `location_id + ghl_user_id`.
5. Require an active Telegram binding verified by trusted numeric Telegram ID or administrator approval.
6. Resolve the contact's HighLevel `conversationId` and include a direct **Open Conversation** button.
7. Send to the assigned sales chat plus active all-call recipients, deduplicated by employee.

There is no fallback to Opportunity Owner, another sales user, a shared group, or unapproved Telegram users. Administrators still receive calls with a routing warning when the assigned sales route is missing.

## Architecture

```text
Voice AI call completed
  -> GoHighLevel Call Details workflow
  -> authenticated custom webhook
  -> Railway Fastify service
  -> Supabase Postgres mapping and idempotency (private wp_voice_ping schema)
  -> Telegram private chat of the Assigned User and active all-call recipients
```

## Local setup

Requirements: Node.js 22 or newer and a PostgreSQL connection.

```bash
npm install
cp .env.example .env.local
npm run migrate
npm run dev
```

The supplied Word document and local `.env.local` are ignored by Git. Never copy real values into `.env.example`, README files, migrations, test fixtures, or commands shared in chat.

## Environment variables

Required variables are listed in `.env.example`. Application traffic uses `DATABASE_URL`; migrations use `DATABASE_URL_UNPOOLED` when available. Each CRM location has its own read-only GHL token.

Production uses the existing Supabase project `wpvh-sales-control` (`jqzhvnswwvbsqwwhcewn`),
session pooler on port 5432, and the dedicated `wp_voice_ping_app` database role.
Both database URL variables point to Supabase. TLS verifies the server certificate
and hostname using `sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt`.
For local commands, use the absolute local path to `certs/supabase-ca.crt` instead.
The bundled public CA is published by Supabase at
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt.
Do not use transaction-pooler port 6543: startup migrations use a session advisory lock.

The service resolves `conversationId` through HighLevel Conversations Search and uses the verified HighLevel UI route `/v2/location/{locationId}/conversations/conversations/{conversationId}`.

## HTTP endpoints

- `GET /health` checks the service and database.
- `POST /webhooks/ghl/voice-ai-call-completed` receives the authenticated GHL event.
- `POST /telegram/webhook` receives authenticated Telegram updates.
- `GET /admin/sales` lists mappings and connection state.
- `POST /admin/sales` adds a sales user and one or more location mappings.
- `PATCH /admin/sales/:salesUserId` enables or disables a sales user.
- `POST /admin/test-message` sends a test message only to an active verified binding.

Admin endpoints require `Authorization: Bearer $ADMIN_API_TOKEN`.

## Telegram commands

- `/start` connects a pre-confirmed numeric Telegram ID or creates an administrator approval request.
- `/status` shows the current binding and location mappings.
- `/help` shows usage.
- `/admin` is authorized by the manager's numeric Telegram ID and opens employee statuses, pending approvals, enable/disable controls, live GHL user selection, and a test notification.

Telegram usernames are display metadata only and never grant access by themselves.

## Database

SQL migrations live in `migrations/`. The startup command applies unapplied migrations under an advisory lock before starting the server. The application uses the isolated `wp_voice_ping` schema.

The bot role owns only this schema, has no access to sales-control's `public` tables,
and has no database creation, role management, superuser, or RLS-bypass privileges.
All bot tables have RLS enabled and no `anon`/`authenticated` grants. No Data API
exposure or Supabase Auth integration is needed. The existing sales-control schema
and credentials are unchanged.

The database was moved from Neon on 2026-11-24, preserving every staff profile,
binding, permission, event and delivery. Users do not need to reconnect. The old
database is retained as a backup, with its migration barrier closed; it is not used
by the running service. Do not roll back to an old Neon-configured deployment.

`migration_state` normally stays open. Closing it waits for in-flight webhook
handlers to finish, then authenticated valid webhooks are stored in
`migration_inbox` before acknowledgment. Admin mutations return 503 while closed.
Only events in that cutover inbox may be forwarded after a move; never replay the
historical call table. `scripts/export-database.mjs` creates a private snapshot;
`scripts/import-database.mjs` refuses to overwrite non-empty destination tables
and verifies every copied table by checksum. These are manual operations tools,
not background workers.

Initial records include both locations and twelve known people. Dmitry is the only bot manager. Dmitry, Katherina, and Foxion CEO are all-call recipients; Katherina and Foxion cannot manage onboarding. Iryna Zienina and Tetiana Mushyn are mapped only to WallPanels, while Daria Inozemtseva, Shafag Ibragimova, and Jenny Cartner are mapped to both locations, matching the live GHL Users API. Numeric Telegram IDs are never inferred from usernames, names, or phone numbers.

## Verification

```bash
npm run security:scan
npm run check
```

The automated suite verifies exact recipient routing, administrator broadcast and deduplication, two-location isolation, onboarding without codes, approval requests, duplicate suppression, required conversation links, webhook authorization, and transient GHL and Telegram failures.

The database cutover was checked without sending test Telegram messages. A real
post-cutover AI call is still needed to verify the full path on Supabase. See
`GHL_WORKFLOW_SETUP.md` for the existing webhook contract.
