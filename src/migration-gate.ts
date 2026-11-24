import { createHash } from "node:crypto";
import pg from "pg";

export type WebhookKind = "ghl" | "telegram";
export interface MigrationGate {
  // A lease keeps the migration barrier open until this request finishes.
  enter(kind?: WebhookKind, payload?: unknown): Promise<{ queued: boolean; release(): Promise<void> }>;
}

export class PgMigrationGate implements MigrationGate {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000, application_name: "wp-voice-ping-migration-gate" });
  }

  async enter(kind?: WebhookKind, payload?: unknown) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query<{ accepting: boolean }>(
        "SELECT accepting FROM wp_voice_ping.migration_state WHERE id = true FOR SHARE",
      );
      if (!state.rows[0]) throw new Error("Missing migration state");
      if (!state.rows[0].accepting) {
        if (kind) {
          const body = JSON.stringify(payload);
          const key = createHash("sha256").update(`${kind}:${body}`).digest("hex");
          await client.query(
            `INSERT INTO wp_voice_ping.migration_inbox (id, kind, payload)
             VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`, [key, kind, body],
          );
        }
        await client.query("COMMIT");
        client.release();
        return { queued: true, release: async () => undefined };
      }
      let released = false;
      return { queued: false, release: async () => {
        if (released) return;
        released = true;
        try { await client.query("COMMIT"); } finally { client.release(); }
      } };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}
