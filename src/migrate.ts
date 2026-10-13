import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });
dotenv.config();

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");

const { Client } = pg;
const client = new Client({ connectionString, application_name: "wp-voice-ping-migrations" });
const migrationsDirectory = path.resolve(process.cwd(), "migrations");

await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('wp_voice_ping_migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS wp_voice_ping");
  await client.query(`
    CREATE TABLE IF NOT EXISTS wp_voice_ping.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort();
  const appliedResult = await client.query<{ filename: string }>(
    "SELECT filename FROM wp_voice_ping.schema_migrations",
  );
  const applied = new Set(appliedResult.rows.map((row) => row.filename));
  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO wp_voice_ping.schema_migrations (filename) VALUES ($1)",
        [filename],
      );
      await client.query("COMMIT");
      process.stdout.write(`Applied migration ${filename}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('wp_voice_ping_migrations'))").catch(() => undefined);
  await client.end();
}
