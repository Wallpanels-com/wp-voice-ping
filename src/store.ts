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
  isAdmin: boolean;
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
  isAdmin: boolean;
  locations: Array<{ locationName: string; ghlUserId: string }>;
}

export interface NotificationRecipient {
  salesUserId: string;
  salesName: string;
  chatId: string;
  isAdmin: boolean;
}

export interface DeliveryPreparation {
  id: string;
  alreadySent: boolean;
}

export interface AccessRequestRecord {
  id: string;
  telegramUserId: string;
  chatId: string;
  telegramUsername?: string;
  displayName: string;
  requestedAt: Date;
}

export type TelegramStartResult =
  | { kind: "connected"; salesName: string; isAdmin: boolean }
  | { kind: "pending"; requestId: string; created: boolean }
  | { kind: "disabled"; salesName: string };

export type ApprovalResult =
  | { kind: "approved"; salesName: string; chatId: string }
  | { kind: "not_admin" | "request_not_found" | "sales_not_found" | "telegram_conflict" };

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
  listActiveAdminRecipients(): Promise<NotificationRecipient[]>;
  prepareDelivery(eventId: string, salesUserId: string, chatId: string): Promise<DeliveryPreparation>;
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
  startTelegramUser(input: {
    telegramUserId: string;
    chatId: string;
    telegramUsername?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<TelegramStartResult>;
  listPendingAccessRequests(): Promise<AccessRequestRecord[]>;
  approveAccessRequest(input: {
    requestId: string;
    salesUserId: string;
    adminTelegramUserId: string;
  }): Promise<ApprovalResult>;
  rejectAccessRequest(requestId: string, adminTelegramUserId: string): Promise<boolean>;
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

  async listActiveAdminRecipients(): Promise<NotificationRecipient[]> {
    const result = await this.pool.query<{
      sales_user_id: string;
      sales_name: string;
      chat_id: string;
    }>(
      `SELECT su.id AS sales_user_id, su.name AS sales_name, tb.chat_id::text AS chat_id
       FROM wp_voice_ping.sales_users su
       JOIN wp_voice_ping.telegram_bindings tb ON tb.sales_user_id = su.id
       WHERE su.is_admin = true AND su.active = true AND tb.active = true
       ORDER BY su.name`,
    );
    return result.rows.map((row) => ({
      salesUserId: row.sales_user_id,
      salesName: row.sales_name,
      chatId: row.chat_id,
      isAdmin: true,
    }));
  }

  async prepareDelivery(eventId: string, salesUserId: string, chatId: string): Promise<DeliveryPreparation> {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string; already_sent: boolean }>(
      `INSERT INTO wp_voice_ping.notification_deliveries (
         id, call_event_id, sales_user_id, telegram_chat_id, status
       ) VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (call_event_id, sales_user_id) DO UPDATE SET
         telegram_chat_id = EXCLUDED.telegram_chat_id,
         status = CASE
           WHEN wp_voice_ping.notification_deliveries.status = 'sent' THEN 'sent'
           ELSE 'pending'
         END,
         attempt_count = wp_voice_ping.notification_deliveries.attempt_count + 1,
         error_code = CASE
           WHEN wp_voice_ping.notification_deliveries.status = 'sent'
             THEN wp_voice_ping.notification_deliveries.error_code
           ELSE NULL
         END,
         updated_at = now()
       RETURNING id, status = 'sent' AS already_sent`,
      [id, eventId, salesUserId, chatId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to prepare notification delivery");
    return { id: row.id, alreadySent: row.already_sent };
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
      is_admin: boolean;
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
         su.is_admin,
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
          isAdmin: row.is_admin,
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
      is_admin: boolean;
      location_name: string | null;
      ghl_user_id: string | null;
    }>(
      `SELECT
         su.id AS sales_user_id,
         su.name AS sales_name,
         (su.active AND tb.active) AS active,
         su.is_admin,
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
      isAdmin: first.is_admin,
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

  async startTelegramUser(input: {
    telegramUserId: string;
    chatId: string;
    telegramUsername?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<TelegramStartResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const bindingResult = await client.query<{
        sales_user_id: string;
        sales_name: string;
        sales_active: boolean;
        is_admin: boolean;
        binding_active: boolean;
        auto_link_allowed: boolean;
      }>(
        `SELECT su.id AS sales_user_id, su.name AS sales_name, su.active AS sales_active,
                su.is_admin, tb.active AS binding_active, tb.auto_link_allowed
         FROM wp_voice_ping.telegram_bindings tb
         JOIN wp_voice_ping.sales_users su ON su.id = tb.sales_user_id
         WHERE tb.telegram_user_id = $1
         FOR UPDATE OF tb`,
        [input.telegramUserId],
      );
      const binding = bindingResult.rows[0];
      if (binding) {
        if (!binding.sales_active) {
          await client.query("ROLLBACK");
          return { kind: "disabled", salesName: binding.sales_name };
        }
        if (binding.binding_active || binding.auto_link_allowed) {
          const conflict = await client.query<{ sales_user_id: string }>(
            `SELECT sales_user_id FROM wp_voice_ping.telegram_bindings
             WHERE chat_id = $1 AND sales_user_id <> $2`,
            [input.chatId, binding.sales_user_id],
          );
          if (!conflict.rows[0]) {
            await client.query(
              `UPDATE wp_voice_ping.telegram_bindings
               SET chat_id = $2, telegram_username = $3, active = true,
                   verification_method = CASE WHEN active THEN verification_method ELSE 'trusted_numeric_id' END,
                   verified_at = COALESCE(verified_at, now()), updated_at = now()
               WHERE sales_user_id = $1`,
              [binding.sales_user_id, input.chatId, input.telegramUsername ?? null],
            );
            await client.query("COMMIT");
            return { kind: "connected", salesName: binding.sales_name, isAdmin: binding.is_admin };
          }
        }
      }

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM wp_voice_ping.telegram_access_requests
         WHERE telegram_user_id = $1 AND status = 'pending'
         FOR UPDATE`,
        [input.telegramUserId],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        await client.query(
          `UPDATE wp_voice_ping.telegram_access_requests
           SET chat_id = $2, telegram_username = $3, first_name = $4, last_name = $5, updated_at = now()
           WHERE id = $1`,
          [
            existingRow.id,
            input.chatId,
            input.telegramUsername ?? null,
            input.firstName ?? null,
            input.lastName ?? null,
          ],
        );
        await client.query("COMMIT");
        return { kind: "pending", requestId: existingRow.id, created: false };
      }

      const requestId = randomUUID();
      await client.query(
        `INSERT INTO wp_voice_ping.telegram_access_requests (
           id, telegram_user_id, chat_id, telegram_username, first_name, last_name
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          requestId,
          input.telegramUserId,
          input.chatId,
          input.telegramUsername ?? null,
          input.firstName ?? null,
          input.lastName ?? null,
        ],
      );
      await client.query("COMMIT");
      return { kind: "pending", requestId, created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listPendingAccessRequests(): Promise<AccessRequestRecord[]> {
    const result = await this.pool.query<{
      id: string;
      telegram_user_id: string;
      chat_id: string;
      telegram_username: string | null;
      first_name: string | null;
      last_name: string | null;
      requested_at: Date;
    }>(
      `SELECT id, telegram_user_id::text, chat_id::text, telegram_username,
              first_name, last_name, requested_at
       FROM wp_voice_ping.telegram_access_requests
       WHERE status = 'pending'
       ORDER BY requested_at`,
    );
    return result.rows.map((row) => {
      const displayName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim()
        || (row.telegram_username ? `@${row.telegram_username}` : `Telegram ${row.telegram_user_id}`);
      return {
        id: row.id,
        telegramUserId: row.telegram_user_id,
        chatId: row.chat_id,
        displayName,
        requestedAt: row.requested_at,
        ...(row.telegram_username ? { telegramUsername: row.telegram_username } : {}),
      };
    });
  }

  async approveAccessRequest(input: {
    requestId: string;
    salesUserId: string;
    adminTelegramUserId: string;
  }): Promise<ApprovalResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const admin = await client.query<{ id: string }>(
        `SELECT su.id FROM wp_voice_ping.sales_users su
         JOIN wp_voice_ping.telegram_bindings tb ON tb.sales_user_id = su.id
         WHERE tb.telegram_user_id = $1 AND tb.active = true
           AND su.active = true AND su.is_admin = true`,
        [input.adminTelegramUserId],
      );
      if (!admin.rows[0]) {
        await client.query("ROLLBACK");
        return { kind: "not_admin" };
      }
      const request = await client.query<{
        telegram_user_id: string;
        chat_id: string;
        telegram_username: string | null;
      }>(
        `SELECT telegram_user_id::text, chat_id::text, telegram_username
         FROM wp_voice_ping.telegram_access_requests
         WHERE id = $1 AND status = 'pending'
         FOR UPDATE`,
        [input.requestId],
      );
      const pending = request.rows[0];
      if (!pending) {
        await client.query("ROLLBACK");
        return { kind: "request_not_found" };
      }
      const sales = await client.query<{ name: string }>(
        `SELECT name FROM wp_voice_ping.sales_users WHERE id = $1 AND active = true`,
        [input.salesUserId],
      );
      const salesRow = sales.rows[0];
      if (!salesRow) {
        await client.query("ROLLBACK");
        return { kind: "sales_not_found" };
      }
      const conflict = await client.query<{ sales_user_id: string }>(
        `SELECT sales_user_id FROM wp_voice_ping.telegram_bindings
         WHERE (telegram_user_id = $1 OR chat_id = $2) AND sales_user_id <> $3`,
        [pending.telegram_user_id, pending.chat_id, input.salesUserId],
      );
      if (conflict.rows[0]) {
        await client.query("ROLLBACK");
        return { kind: "telegram_conflict" };
      }
      await client.query(
        `INSERT INTO wp_voice_ping.telegram_bindings (
           id, sales_user_id, chat_id, telegram_user_id, telegram_username,
           active, verification_method, verified_at, auto_link_allowed
         ) VALUES ($1, $2, $3, $4, $5, true, 'admin_approved', now(), true)
         ON CONFLICT (sales_user_id) DO UPDATE SET
           chat_id = EXCLUDED.chat_id,
           telegram_user_id = EXCLUDED.telegram_user_id,
           telegram_username = EXCLUDED.telegram_username,
           active = true,
           verification_method = 'admin_approved',
           verified_at = now(),
           auto_link_allowed = true,
           updated_at = now()`,
        [randomUUID(), input.salesUserId, pending.chat_id, pending.telegram_user_id, pending.telegram_username],
      );
      await client.query(
        `UPDATE wp_voice_ping.telegram_access_requests
         SET status = 'approved', linked_sales_user_id = $2,
             resolved_by_admin_user_id = $3, resolved_at = now(), updated_at = now()
         WHERE id = $1`,
        [input.requestId, input.salesUserId, admin.rows[0].id],
      );
      await client.query("COMMIT");
      return { kind: "approved", salesName: salesRow.name, chatId: pending.chat_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectAccessRequest(requestId: string, adminTelegramUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE wp_voice_ping.telegram_access_requests req
       SET status = 'rejected', resolved_at = now(), updated_at = now(),
           resolved_by_admin_user_id = admin.id
       FROM (
         SELECT su.id FROM wp_voice_ping.sales_users su
         JOIN wp_voice_ping.telegram_bindings tb ON tb.sales_user_id = su.id
         WHERE tb.telegram_user_id = $2 AND tb.active = true
           AND su.active = true AND su.is_admin = true
       ) admin
       WHERE req.id = $1 AND req.status = 'pending'`,
      [requestId, adminTelegramUserId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
