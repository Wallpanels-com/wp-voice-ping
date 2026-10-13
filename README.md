# WP Voice Ping

WP Voice Ping receives completed Voice AI call events from a GoHighLevel Workflow and sends one Telegram notification to the contact's current Assigned User. It supports the WallPanels and Verona Home locations without mixing their credentials or mappings.

## Routing guarantee

The recipient is resolved in this order:

1. Validate the location and webhook secret.
2. Fetch the current contact from the matching GoHighLevel location.
3. Read `contact.assignedTo` from GoHighLevel.
4. Resolve the active database mapping `location_id + ghl_user_id`.
5. Require an active, one-time-code-verified Telegram binding.
6. Send only to that private chat.

There is no fallback to Opportunity Owner, another sales user, a shared group, or every sales user. Missing assignments and bindings are stored as waiting states.

## Architecture

```text
Voice AI call completed
  -> GoHighLevel Call Details workflow
  -> authenticated custom webhook
  -> Railway Fastify service
  -> Neon Postgres mapping and idempotency
  -> Telegram private chat of the exact Assigned User
```

## Local setup

Requirements: Node.js 22 or newer and a Neon PostgreSQL connection.

```bash
npm install
cp .env.example .env.local
npm run migrate
npm run dev
```

The supplied Word document and local `.env.local` are ignored by Git. Never copy real values into `.env.example`, README files, migrations, test fixtures, or commands shared in chat.

## Environment variables

Required variables are listed in `.env.example`. Application traffic uses `DATABASE_URL`; migrations use `DATABASE_URL_UNPOOLED` when available. Each CRM location has its own read-only GHL token.

The CRM button is deliberately omitted until a verified contact-page URL template is provided for each location. A template must use HTTPS and contain both `{locationId}` and `{contactId}`.

## HTTP endpoints

- `GET /health` checks the service and database.
- `POST /webhooks/ghl/voice-ai-call-completed` receives the authenticated GHL event.
- `POST /telegram/webhook` receives authenticated Telegram updates.
- `GET /admin/sales` lists mappings and connection state.
- `POST /admin/sales` adds a sales user and one or more location mappings.
- `PATCH /admin/sales/:salesUserId` enables or disables a sales user.
- `POST /admin/connection-codes` creates a one-time Telegram connection code.
- `POST /admin/test-message` sends a test message only to an active verified binding.

Admin endpoints require `Authorization: Bearer $ADMIN_API_TOKEN`.

### Create a connection code

```bash
curl -sS -X POST "$PUBLIC_BASE_URL/admin/connection-codes" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"salesUserId":"10000000-0000-4000-8000-000000000001","ttlMinutes":30}'
```

Give the returned deep link to that sales user. The user must open it in a private Telegram chat. Imported legacy chat IDs remain inactive until this verification succeeds.

## Telegram commands

- `/start CODE` verifies and connects a sales user.
- `/status` shows the current binding and location mappings.
- `/help` shows usage.

## Database

SQL migrations live in `migrations/`. The startup command applies unapplied migrations under an advisory lock before starting the server. The application uses the isolated `wp_voice_ping` schema.

Initial records include both locations, six known people, ten confirmed location/user mappings for five people, and four inactive legacy Telegram chat IDs awaiting re-verification. Dmitry is stored without a GHL mapping because the source data did not contain one.

## Verification

```bash
npm run security:scan
npm run check
```

The automated suite verifies exact recipient routing, two-location isolation, duplicate suppression, missing assignments and bindings, disabled users, optional fields, webhook authorization, and transient GHL and Telegram failures.

The live Voice AI call path cannot be declared complete until the GHL Workflow is created and one real call is tested. See `GHL_WORKFLOW_SETUP.md`.
