import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig, LocationConfig } from "../src/config.js";
import type {
  CallEventStatus,
  EventClaim,
  GhlContact,
  RouteResolution,
  VoiceCallWebhook,
} from "../src/domain.js";
import { ExternalServiceError } from "../src/external-error.js";
import type { HighLevelClient } from "../src/highlevel.js";
import { CallProcessor } from "../src/processor.js";
import type {
  BindingStatus,
  RedeemCodeResult,
  SalesAdminRecord,
  SalesLocationInput,
  Store,
  TestRecipient,
} from "../src/store.js";
import type { TelegramClient, TelegramMessageOptions } from "../src/telegram.js";

const wallpanels: LocationConfig = {
  id: "Iwpfx8zGzpsZszcnGovT",
  code: "wallpanels",
  displayName: "WALLPANELS",
  ghlToken: "test-wallpanels-token",
};
const verona: LocationConfig = {
  id: "pSsHdL8pyBsLeIci1Py0",
  code: "verona_home",
  displayName: "VERONA HOME",
  ghlToken: "test-verona-token",
};

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  logLevel: "silent",
  databaseUrl: "postgresql://test",
  telegramBotToken: "test-telegram-token",
  telegramBotUsername: "WPVoicePingBot",
  telegramWebhookSecret: "telegram-webhook-secret-value",
  ghlWebhookSecret: "ghl-webhook-secret-value-1234",
  adminApiToken: "admin-api-token-value-123456",
  linkCodePepper: "link-code-pepper-value-123456",
  adminTelegramChatIds: new Set(),
  locations: new Map([
    [wallpanels.id, wallpanels],
    [verona.id, verona],
  ]),
};

function webhook(overrides: Partial<VoiceCallWebhook> = {}): VoiceCallWebhook {
  return {
    eventId: "call-event-1",
    eventType: "voice_ai_call.completed",
    locationId: wallpanels.id,
    contactId: "contact-1",
    callStatus: "completed",
    ...overrides,
  };
}

class MemoryStore implements Store {
  readonly events = new Map<string, { id: string; status: CallEventStatus; reason?: string }>();
  readonly routes = new Map<string, RouteResolution>();
  readonly deliveries: Array<{ eventId: string; salesUserId: string; chatId: string; status?: string }> = [];
  claimCount = 0;

  async healthCheck(): Promise<void> {}
  async close(): Promise<void> {}

  async claimCallEvent(payload: VoiceCallWebhook): Promise<EventClaim> {
    this.claimCount += 1;
    const key = `${payload.locationId}:${payload.eventId}`;
    const existing = this.events.get(key);
    if (existing) return { eventId: existing.id, claimed: false, existingStatus: existing.status };
    const id = `stored-${payload.eventId}`;
    this.events.set(key, { id, status: "processing" });
    return { eventId: id, claimed: true };
  }

  async markEvent(
    eventId: string,
    status: CallEventStatus,
    reason?: string,
    _assignedGhlUserId?: string,
  ): Promise<void> {
    for (const [key, value] of this.events) {
      if (value.id === eventId) this.events.set(key, { id: eventId, status, ...(reason ? { reason } : {}) });
    }
  }

  async resolveRoute(locationId: string, ghlUserId: string): Promise<RouteResolution> {
    return this.routes.get(`${locationId}:${ghlUserId}`) ?? { kind: "unavailable", reason: "mapping_not_found" };
  }

  async prepareDelivery(eventId: string, salesUserId: string, chatId: string): Promise<string> {
    this.deliveries.push({ eventId, salesUserId, chatId });
    return `delivery-${eventId}`;
  }

  async markDelivery(
    deliveryId: string,
    status: "sent" | "retryable_failure" | "permanent_failure",
    _details?: { telegramMessageId?: number; errorCode?: string },
  ): Promise<void> {
    const delivery = this.deliveries.find((item) => `delivery-${item.eventId}` === deliveryId);
    if (delivery) delivery.status = status;
  }

  async listSales(): Promise<SalesAdminRecord[]> { return []; }
  async createSales(_input: { name: string; telegramUsername?: string; locations: SalesLocationInput[] }): Promise<string> {
    return "sales-new";
  }
  async setSalesActive(_salesUserId: string, _active: boolean): Promise<boolean> { return true; }
  async createConnectionCode(_input: { salesUserId: string; codeHash: string; expiresAt: Date }): Promise<boolean> {
    return true;
  }
  async redeemConnectionCode(_input: {
    codeHash: string;
    chatId: string;
    telegramUserId?: string;
    telegramUsername?: string;
  }): Promise<RedeemCodeResult> { return { kind: "invalid" }; }
  async getBindingStatus(_chatId: string): Promise<BindingStatus | null> { return null; }
  async getTestRecipient(_salesUserId: string): Promise<TestRecipient | null> { return null; }
}

class FakeHighLevel implements HighLevelClient {
  contacts = new Map<string, GhlContact>();
  error?: ExternalServiceError;

  async getContact(location: LocationConfig, contactId: string): Promise<GhlContact> {
    if (this.error) throw this.error;
    return this.contacts.get(`${location.id}:${contactId}`) ?? {
      id: contactId,
      locationId: location.id,
      assignedTo: "sales-ghl-1",
      firstName: "Test",
      lastName: "Client",
      phone: "+13055551234",
    };
  }
}

class FakeTelegram implements TelegramClient {
  readonly sent: Array<{ chatId: string; salesName?: string }> = [];
  error?: ExternalServiceError;

  async sendText(chatId: string, _text: string, _options?: TelegramMessageOptions): Promise<number> {
    if (this.error) throw this.error;
    this.sent.push({ chatId });
    return this.sent.length;
  }

  async sendCallNotification(input: {
    chatId: string;
    salesName: string;
    location: LocationConfig;
    webhook: VoiceCallWebhook;
    contact: GhlContact;
  }): Promise<number> {
    if (this.error) throw this.error;
    this.sent.push({ chatId: input.chatId, salesName: input.salesName });
    return this.sent.length;
  }

  async setWebhook(_url: string, _secretToken: string): Promise<void> {}
  async getMe(): Promise<{ id: number; username?: string }> { return { id: 1, username: "WPVoicePingBot" }; }
}

const logger = {
  info: (_bindings: Record<string, unknown>, _message: string) => undefined,
  warn: (_bindings: Record<string, unknown>, _message: string) => undefined,
  error: (_bindings: Record<string, unknown>, _message: string) => undefined,
};

function setup() {
  const store = new MemoryStore();
  const highLevel = new FakeHighLevel();
  const telegram = new FakeTelegram();
  const processor = new CallProcessor(config, store, highLevel, telegram, logger);
  return { store, highLevel, telegram, processor };
}

describe("CallProcessor routing", () => {
  it("delivers only to the exact assigned sales mapping", async () => {
    const { store, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "ready",
      salesUserId: "sales-1",
      salesName: "Mary",
      chatId: "chat-mary",
    });
    await expect(processor.process(webhook())).resolves.toMatchObject({ kind: "delivered" });
    expect(telegram.sent).toEqual([{ chatId: "chat-mary", salesName: "Mary" }]);
  });

  it("routes two assigned users to two different chats", async () => {
    const { store, highLevel, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "ready", salesUserId: "sales-1", salesName: "Mary", chatId: "chat-mary",
    });
    store.routes.set(`${wallpanels.id}:sales-ghl-2`, {
      kind: "ready", salesUserId: "sales-2", salesName: "Anthony", chatId: "chat-anthony",
    });
    highLevel.contacts.set(`${wallpanels.id}:contact-2`, {
      id: "contact-2", locationId: wallpanels.id, assignedTo: "sales-ghl-2",
    });
    await processor.process(webhook());
    await processor.process(webhook({ eventId: "call-event-2", contactId: "contact-2" }));
    expect(telegram.sent.map((item) => item.chatId)).toEqual(["chat-mary", "chat-anthony"]);
  });

  it("does not duplicate a previously claimed event", async () => {
    const { store, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "ready", salesUserId: "sales-1", salesName: "Mary", chatId: "chat-mary",
    });
    await processor.process(webhook());
    await expect(processor.process(webhook())).resolves.toMatchObject({ kind: "duplicate", status: "delivered" });
    expect(telegram.sent).toHaveLength(1);
  });

  it("waits when Contact Assigned User is absent", async () => {
    const { highLevel, telegram, processor } = setup();
    highLevel.contacts.set(`${wallpanels.id}:contact-1`, { id: "contact-1", locationId: wallpanels.id });
    await expect(processor.process(webhook())).resolves.toMatchObject({
      kind: "waiting", reason: "contact_has_no_assigned_user",
    });
    expect(telegram.sent).toHaveLength(0);
  });

  it("waits when sales has no active Telegram binding", async () => {
    const { store, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "unavailable", reason: "telegram_not_connected", salesUserId: "sales-1",
    });
    await expect(processor.process(webhook())).resolves.toMatchObject({
      kind: "waiting", reason: "telegram_not_connected",
    });
    expect(telegram.sent).toHaveLength(0);
  });

  it("rejects an unknown CRM location without claiming an event", async () => {
    const { store, processor } = setup();
    await expect(processor.process(webhook({ locationId: "unknown-location-id" }))).resolves.toMatchObject({
      kind: "permanent_failure", reason: "invalid_location",
    });
    expect(store.claimCount).toBe(0);
  });

  it("isolates the same GHL user ID by location", async () => {
    const { store, highLevel, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "ready", salesUserId: "sales-wall", salesName: "Wall Sales", chatId: "wall-chat",
    });
    store.routes.set(`${verona.id}:sales-ghl-1`, {
      kind: "ready", salesUserId: "sales-verona", salesName: "Verona Sales", chatId: "verona-chat",
    });
    highLevel.contacts.set(`${verona.id}:contact-v`, {
      id: "contact-v", locationId: verona.id, assignedTo: "sales-ghl-1",
    });
    await processor.process(webhook());
    await processor.process(webhook({ eventId: "event-v", locationId: verona.id, contactId: "contact-v" }));
    expect(telegram.sent.map((item) => item.chatId)).toEqual(["wall-chat", "verona-chat"]);
  });

  it("supports a newly added dynamic mapping without code changes", async () => {
    const { store, highLevel, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:new-ghl-user`, {
      kind: "ready", salesUserId: "new-sales", salesName: "New Sales", chatId: "new-chat",
    });
    highLevel.contacts.set(`${wallpanels.id}:new-contact`, {
      id: "new-contact", locationId: wallpanels.id, assignedTo: "new-ghl-user",
    });
    await processor.process(webhook({ eventId: "new-event", contactId: "new-contact" }));
    expect(telegram.sent[0]?.chatId).toBe("new-chat");
  });

  it("does not notify a disabled sales user", async () => {
    const { store, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "unavailable", reason: "sales_disabled", salesUserId: "sales-1",
    });
    await expect(processor.process(webhook())).resolves.toMatchObject({
      kind: "waiting", reason: "sales_disabled",
    });
    expect(telegram.sent).toHaveLength(0);
  });

  it("accepts missing optional webhook fields", async () => {
    const { store, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "ready", salesUserId: "sales-1", salesName: "Mary", chatId: "chat-mary",
    });
    await expect(processor.process(webhook())).resolves.toMatchObject({ kind: "delivered" });
  });

  it("marks transient GHL failures as retryable", async () => {
    const { highLevel, processor } = setup();
    highLevel.error = new ExternalServiceError({
      service: "ghl", code: "http_503", retryable: true, message: "temporary",
    });
    await expect(processor.process(webhook())).resolves.toMatchObject({
      kind: "retryable_failure", reason: "ghl_http_503",
    });
  });

  it("marks transient Telegram failures as retryable", async () => {
    const { store, telegram, processor } = setup();
    store.routes.set(`${wallpanels.id}:sales-ghl-1`, {
      kind: "ready", salesUserId: "sales-1", salesName: "Mary", chatId: "chat-mary",
    });
    telegram.error = new ExternalServiceError({
      service: "telegram", code: "http_503", retryable: true, message: "temporary",
    });
    await expect(processor.process(webhook())).resolves.toMatchObject({
      kind: "retryable_failure", reason: "telegram_http_503",
    });
  });
});

describe("Webhook authorization", () => {
  it("rejects an unauthorized GHL webhook", async () => {
    const { store, telegram, processor } = setup();
    const app = buildApp({ config, store, telegram, processor });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/ghl/voice-ai-call-completed",
      payload: webhook(),
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a malformed authorized webhook", async () => {
    const { store, telegram, processor } = setup();
    const app = buildApp({ config, store, telegram, processor });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/ghl/voice-ai-call-completed",
      headers: { "x-wp-voice-ping-secret": config.ghlWebhookSecret },
      payload: { locationId: wallpanels.id },
    });
    expect(response.statusCode).toBe(422);
    await app.close();
  });
});
