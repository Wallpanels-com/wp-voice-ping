import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });
dotenv.config();

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");

const { Client } = pg;
const client = new Client({ connectionString, application_name: "wp-voice-ping-verification" });
await client.connect();
try {
  const counts = await client.query<{
    locations: string;
    sales: string;
    mappings: string;
    bindings: string;
    active_bindings: string;
    call_events: string;
  }>(`
    SELECT
      (SELECT count(*) FROM wp_voice_ping.crm_locations)::text AS locations,
      (SELECT count(*) FROM wp_voice_ping.sales_users)::text AS sales,
      (SELECT count(*) FROM wp_voice_ping.sales_location_users)::text AS mappings,
      (SELECT count(*) FROM wp_voice_ping.telegram_bindings)::text AS bindings,
      (SELECT count(*) FROM wp_voice_ping.telegram_bindings WHERE active)::text AS active_bindings,
      (SELECT count(*) FROM wp_voice_ping.call_events)::text AS call_events
  `);
  const constraints = await client.query<{ constraint_name: string }>(`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'wp_voice_ping'
      AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK')
    ORDER BY constraint_name
  `);
  const row = counts.rows[0];
  if (!row) throw new Error("Database verification query returned no rows");
  process.stdout.write(`${JSON.stringify({
    counts: {
      locations: Number(row.locations),
      sales: Number(row.sales),
      mappings: Number(row.mappings),
      bindings: Number(row.bindings),
      activeBindings: Number(row.active_bindings),
      callEvents: Number(row.call_events),
    },
    constraintCount: constraints.rowCount ?? 0,
  })}\n`);
  if (Number(row.locations) !== 2 || Number(row.sales) !== 6 || Number(row.mappings) !== 10) {
    throw new Error("Seed verification failed");
  }
} finally {
  await client.end();
}
