import { randomUUID } from "node:crypto";
import pg from "pg";

import type {
  CallEventStatus,
  EventClaim,
  RouteResolution,
  VoiceCallWebhook,
} from "./domain.js";

const { Pool } = pg;

export interface SalesLocationInput {
  locationId: string;
  ghlUserId: string;
}

export interface SalesAdminRecord {
  id: string;
  name: string;
  telegramUsername?: string;
  active: boolean;
  binding: {
    chatId: string;
    username?: string;
    active: boolean;
    verificationMethod: string;
  } | null;
  locations: Array<{
    locationId: string;
    locationName: string;
    ghlUserId: string;
    active: boolean;
  }>;
}

export interface BindingStatus {
  salesUserId: string;
  salesName: string;
  active: boolean;
  locations: Array<{ locationName: string; ghlUserId: string }>;
}

export interface TestRecipient {
  salesUserId: string;
  salesName: string;
  chatId: string;
}

export type RedeemCodeResult =
  | { kind: "linked"; salesName: string }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "sales_disabled" }
  | { kind: "chat_already_linked" };

export interface Store {
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  claimCallEvent(payload: VoiceCallWebhook): Promise<EventClaim>;
  markEvent(
    eventId: string,
    status: CallEventStatus,
    reason?: string,
    assignedGhlUserId?: string,
  ): Promise<void>;
  resolveRoute(locationId: string, ghlUserId: string): Promise<RouteResolution>;
  prepareDelivery(eventId: string, salesUserId: string, chatId: string): Promise<string>;
  markDelivery(
    deliveryId: string,
    status: "sent" | "retryable_failure" | "permanent_failure",
    details?: { telegramMessageId?: number; errorCode?: string },
  ): Promise<void>;
  listSales(): Promise<SalesAdminRecord[]>;
  createSales(input: {
    name: string;
    telegramUsername?: string;
    locations: SalesLocationInput[];
  }): Promise<string>;
  setSalesActive(salesUserId: string, active: boolean): Promise<boolean>;
  createConnectionCode(input: {
    salesUserId: string;
    codeHash: string;
    expiresAt: Date;
  }): Promise<boolean>;
  redeemConnectionCode(input: {
    codeHash: string;
    chatId: string;
    telegramUserId?: string;
    telegramUsername?: string;
  }): Promise<RedeemCodeResult>;
  getBindingStatus(chatId: string): Promise<BindingStatus | null>;
  getTestRecipient(salesUserId: string): Promise<TestRecipient | null>;
}

interface PgStoreOptions {
  connectionString: string;
  maxConnections?: number;
}

export class PgStore implements Store {
  readonly pool: pg.Pool;

  constructor(options: PgStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
      application_name: "wp-voice-ping",
    });
  }

  async healthCheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async claimCallEvent(payload: VoiceCallWebhook): Promise<EventClaim> {
    const id = randomUUID();
    const safePayload = {
      eventId: payload.eventId,
      eventType: payload.eventType,
      locationId: payload.locationId,
      contactId: payload.contactId,
      callId: payload.callId ?? null,
      callStatus: payload.callStatus,
      direction: payload.direction ?? null,
      occurredAt: payload.occurredAt ?? null,
    };
    const inserted = await this.pool.query<{ id: string; status: CallEventStatus }>(
      `INSERT INTO wp_voice_ping.call_events (
         id, location_id, external_event_id, call_id, contact_id, event_type,
         call_status, safe_payload, status, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'processing', $9)
       ON CONFLICT (location_id, external_event_id) DO NOTHING
       RETURNING id, status`,
      [
        id,
        payload.locationId,
        payload.eventId,
        payload.callId ?? null,
        payload.contactId,
        payload.eventType,
        payload.callStatus,
        JSON.stringify(safePayload),
        payload.occurredAt ?? null,
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) return { eventId: insertedRow.id, claimed: true };

    const retry = await this.pool.query<{ id: string; status: CallEventStatus }>(
      `UPDATE wp_voice_ping.call_events
       SET status = 'processing', reason = NULL, attempt_count = attempt_count + 1, updated_at = now()
       WHERE location_id = $1 AND external_event_id = $2 AND status = 'failed_retryable'
       RETURNING id, status`,
      [payload.locationId, payload.eventId],
    );
    const retryRow = retry.rows[0];
    if (retryRow) return { eventId: retryRow.id, claimed: true };

    const existing = await this.pool.query<{ id: string; status: CallEventStatus }>(
      `SELECT id, status
       FROM wp_voice_ping.call_events
       WHERE location_id = $1 AND external_event_id = $2`,
      [payload.locationId, payload.eventId],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) throw new Error("Call event conflict could not be resolved");
    return { eventId: existingRow.id, claimed: false, existingStatus: existingRow.status };
  }

  async markEvent(
    eventId: string,
    status: CallEventStatus,
    reason?: string,
    assignedGhlUserId?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE wp_voice_ping.call_events
       SET status = $2,
           reason = $3,
           assigned_ghl_user_id = COALESCE($4, assigned_ghl_user_id),
           processed_at = CASE WHEN $2 = 'processing' THEN processed_at ELSE now() END,
           updated_at = now()
       WHERE id = $1`,
      [eventId, status, reason ?? null, assignedGhlUserId ?? null],
    );
  }

  async resolveRoute(locationId: string, ghlUserId: string): Promise<RouteResolution> {
    const result = await this.pool.query<{
      sales_user_id: string;
      sales_name: string;
      sales_active: boolean;
      mapping_active: boolean;
      chat_id: string | null;
      binding_active: boolean | null;
    }>(
      `SELECT
         su.id AS sales_user_id,
         su.name AS sales_name,
         su.active AS sales_active,
         slu.active AS mapping_active,
         tb.chat_id::text AS chat_id,
         tb.active AS binding_active
       FROM wp_voice_ping.sales_location_users slu
       JOIN wp_voice_ping.sales_users su ON su.id = slu.sales_user_id
       LEFT JOIN wp_voice_ping.telegram_bindings tb ON tb.sales_user_id = su.id
       WHERE slu.location_id = $1 AND slu.ghl_user_id = $2`,
      [locationId, ghlUserId],
    );
    const row = result.rows[0];
    if (!row) return { kind: "unavailable", reason: "mapping_not_found" };
    if (!row.sales_active || !row.mapping_active) {
      return {
        kind: "unavailable",
        reason: "sales_disabled",
        salesUserId: row.sales_user_id,
        salesName: row.sales_name,
      };
    }
    if (!row.chat_id || !row.binding_active) {
      return {
        kind: "unavailable",
        reason: "telegram_not_connected",
        salesUserId: row.sales_user_id,
        salesName: row.sales_name,
      };
    }
    return {
      kind: "ready",
      salesUserId: row.sales_user_id,
      salesName: row.sales_name,
      chatId: row.chat_id,
    };
  }

  async prepareDelivery(eventId: string, salesUserId: string, chatId: string): Promise<string> {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO wp_voice_ping.notification_deliveries (
         id, call_event_id, sales_user_id, telegram_chat_id, status
       ) VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (call_event_id) DO UPDATE SET
         sales_user_id = EXCLUDED.sales_user_id,
         telegram_chat_id = EXCLUDED.telegram_chat_id,
         status = 'pending',
         attempt_count = wp_voice_ping.notification_deliveries.attempt_count + 1,
         error_code = NULL,
         updated_at = now()
       RETURNING id`,
      [id, eventId, salesUserId, chatId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to prepare notification delivery");
    return row.id;
  }

  async markDelivery(
    deliveryId: string,
    status: "sent" | "retryable_failure" | "permanent_failure",
    details: { telegramMessageId?: number; errorCode?: string } = {},
  ): Promise<void> {
    await this.pool.query(
      `UPDATE wp_voice_ping.notification_deliveries
       SET status = $2,
           telegram_message_id = $3,
           error_code = $4,
           sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
           updated_at = now()
       WHERE id = $1`,
      [deliveryId, status, details.telegramMessageId ?? null, details.errorCode ?? null],
    );
  }

  async listSales(): Promise<SalesAdminRecord[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      telegram_username: string | null;
      active: boolean;
      chat_id: string | null;
      binding_username: string | null;
      binding_active: boolean | null;
      verification_method: string | null;
      location_id: string | null;
      location_name: string | null;
      ghl_user_id: string | null;
      mapping_active: boolean | null;
    }>(
      `SELECT
         su.id,
         su.name,
         su.telegram_username,
         su.active,
         tb.chat_id::text AS chat_id,
         tb.telegram_username AS binding_username,
         tb.active AS binding_active,
         tb.verification_method,
         slu.location_id,
         cl.name AS location_name,
         slu.ghl_user_id,
         slu.active AS mapping_active
       FROM wp_voice_ping.sales_users su
       LEFT JOIN wp_voice_ping.telegram_bindings tb ON tb.sales_user_id = su.id
       LEFT JOIN wp_voice_ping.sales_location_users slu ON slu.sales_user_id = su.id
       LEFT JOIN wp_voice_ping.crm_locations cl ON cl.id = slu.location_id
       ORDER BY su.name, cl.name`,
    );
    const grouped = new Map<string, SalesAdminRecord>();
    for (const row of result.rows) {
      let record = grouped.get(row.id);
      if (!record) {
        record = {
          id: row.id,
          name: row.name,
          active: row.active,
          binding: row.chat_id && row.verification_method
            ? {
                chatId: row.chat_id,
                active: Boolean(row.binding_active),
                verificationMethod: row.verification_method,
                ...(row.binding_username ? { username: row.binding_username } : {}),
              }
            : null,
          locations: [],
          ...(row.telegram_username ? { telegramUsername: row.telegram_username } : {}),
        };
        grouped.set(row.id, record);
      }
      if (row.location_id && row.location_name && row.ghl_user_id) {
        record.locations.push({
          locationId: row.location_id,
          locationName: row.location_name,
          ghlUserId: row.ghl_user_id,
          active: Boolean(row.mapping_active),
        });
      }
    }
    return [...grouped.values()];
  }

  async createSales(input: {
    name: string;
    telegramUsername?: string;
    locations: SalesLocationInput[];
  }): Promise<string> {
    const client = await this.pool.connect();
    const salesUserId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO wp_voice_ping.sales_users (id, name, telegram_username)
         VALUES ($1, $2, $3)`,
        [salesUserId, input.name, input.telegramUsername ?? null],
      );
      for (const location of input.locations) {
        await client.query(
          `INSERT INTO wp_voice_ping.sales_location_users (
             id, sales_user_id, location_id, ghl_user_id, source
           ) VALUES ($1, $2, $3, $4, 'admin_api')`,
          [randomUUID(), salesUserId, location.locationId, location.ghlUserId],
        );
      }
      await client.query("COMMIT");
      return salesUserId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setSalesActive(salesUserId: string, active: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE wp_voice_ping.sales_users
       SET active = $2, updated_at = now()
       WHERE id = $1`,
      [salesUserId, active],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createConnectionCode(input: {
    salesUserId: string;
    codeHash: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const activeSales = await this.pool.query<{ id: string }>(
      `SELECT id FROM wp_voice_ping.sales_users WHERE id = $1 AND active = true`,
      [input.salesUserId],
    );
    if (!activeSales.rows[0]) return false;
    await this.pool.query(
      `UPDATE wp_voice_ping.connection_codes
       SET used_at = COALESCE(used_at, now())
       WHERE sales_user_id = $1 AND used_at IS NULL`,
      [input.salesUserId],
    );
    await this.pool.query(
      `INSERT INTO wp_voice_ping.connection_codes (id, sales_user_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), input.salesUserId, input.codeHash, input.expiresAt],
    );
    return true;
  }

  async redeemConnectionCode(input: {
    codeHash: string;
    chatId: string;
    telegramUserId?: string;
    telegramUsername?: string;
  }): Promise<RedeemCodeResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const codeResult = await client.query<{
        id: string;
        sales_user_id: string;
        sales_name: string;
        sales_active: boolean;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `SELECT
           cc.id,
           cc.sales_user_id,
           su.name AS sales_name,
           su.active AS sales_active,
           cc.expires_at,
           cc.used_at
         FROM wp_voice_ping.connection_codes cc
         JOIN wp_voice_ping.sales_users su ON su.id = cc.sales_user_id
         WHERE cc.code_hash = $1
         FOR UPDATE OF cc`,
        [input.codeHash],
      );
      const code = codeResult.rows[0];
      if (!code) {
        await client.query("ROLLBACK");
        return { kind: "invalid" };
      }
      if (code.used_at) {
        await client.query("ROLLBACK");
        return { kind: "used" };
      }
      if (code.expires_at.getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return { kind: "expired" };
      }
      if (!code.sales_active) {
        await client.query("ROLLBACK");
        return { kind: "sales_disabled" };
      }
      const conflict = await client.query<{ sales_user_id: string }>(
        `SELECT sales_user_id
         FROM wp_voice_ping.telegram_bindings
         WHERE chat_id = $1 AND sales_user_id <> $2`,
        [input.chatId, code.sales_user_id],
      );
      if (conflict.rows[0]) {
        await client.query("ROLLBACK");
        return { kind: "chat_already_linked" };
      }
      await client.query(
        `INSERT INTO wp_voice_ping.telegram_bindings (
           id, sales_user_id, chat_id, telegram_user_id, telegram_username,
           active, verification_method, verified_at
         ) VALUES ($1, $2, $3, $4, $5, true, 'one_time_code', now())
         ON CONFLICT (sales_user_id) DO UPDATE SET
           chat_id = EXCLUDED.chat_id,
           telegram_user_id = EXCLUDED.telegram_user_id,
           telegram_username = EXCLUDED.telegram_username,
           active = true,
           verification_method = 'one_time_code',
           verified_at = now(),
           updated_at = now()`,
        [
          randomUUID(),
          code.sales_user_id,
          input.chatId,
          input.telegramUserId ?? null,
          input.telegramUsername ?? null,
        ],
      );
      await client.query(
        `UPDATE wp_voice_ping.connection_codes
         SET used_at = now(), used_by_chat_id = $2
         WHERE id = $1`,
        [code.id, input.chatId],
      );
      await client.query("COMMIT");
      return { kind: "linked", salesName: code.sales_name };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBindingStatus(chatId: string): Promise<BindingStatus | null> {
    const result = await this.pool.query<{
      sales_user_id: string;
      sales_name: string;
      active: boolean;
      location_name: string | null;
      ghl_user_id: string | null;
    }>(
      `SELECT
         su.id AS sales_user_id,
         su.name AS sales_name,
         (su.active AND tb.active) AS active,
         cl.name AS location_name,
         slu.ghl_user_id
       FROM wp_voice_ping.telegram_bindings tb
       JOIN wp_voice_ping.sales_users su ON su.id = tb.sales_user_id
       LEFT JOIN wp_voice_ping.sales_location_users slu
         ON slu.sales_user_id = su.id AND slu.active = true
       LEFT JOIN wp_voice_ping.crm_locations cl
         ON cl.id = slu.location_id AND cl.active = true
       WHERE tb.chat_id = $1
       ORDER BY cl.name`,
      [chatId],
    );
    const first = result.rows[0];
    if (!first) return null;
    return {
      salesUserId: first.sales_user_id,
      salesName: first.sales_name,
      active: first.active,
      locations: result.rows.flatMap((row) =>
        row.location_name && row.ghl_user_id
          ? [{ locationName: row.location_name, ghlUserId: row.ghl_user_id }]
          : [],
      ),
    };
  }

  async getTestRecipient(salesUserId: string): Promise<TestRecipient | null> {
    const result = await this.pool.query<{
      sales_user_id: string;
      sales_name: string;
      chat_id: string;
    }>(
      `SELECT su.id AS sales_user_id, su.name AS sales_name, tb.chat_id::text AS chat_id
       FROM wp_voice_ping.sales_users su
       JOIN wp_voice_ping.telegram_bindings tb ON tb.sales_user_id = su.id
       WHERE su.id = $1 AND su.active = true AND tb.active = true`,
      [salesUserId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { salesUserId: row.sales_user_id, salesName: row.sales_name, chatId: row.chat_id };
  }
}
