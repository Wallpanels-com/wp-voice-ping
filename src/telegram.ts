import { z } from "zod";

import type { LocationConfig } from "./config.js";
import type { GhlContact, VoiceCallWebhook } from "./domain.js";
import { ExternalServiceError } from "./external-error.js";

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  result: z.object({ message_id: z.number() }).passthrough().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

export interface TelegramMessageOptions {
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
}

export interface TelegramClient {
  sendText(chatId: string, text: string, options?: TelegramMessageOptions): Promise<number>;
  sendCallNotification(input: {
    chatId: string;
    salesName: string;
    location: LocationConfig;
    webhook: VoiceCallWebhook;
    contact: GhlContact;
  }): Promise<number>;
  setWebhook(url: string, secretToken: string): Promise<void>;
  getMe(): Promise<{ id: number; username?: string }>;
}

interface TelegramHttpClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function maskPhone(phone: string | undefined): string {
  if (!phone) return "Not available";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "Available in CRM";
  const country = phone.trim().startsWith("+") ? `+${digits.slice(0, Math.max(1, digits.length - 10))}` : "";
  const lastFour = digits.slice(-4);
  const area = digits.length >= 10 ? digits.slice(-10, -7) : digits.slice(0, 3);
  return `${country}${country ? " " : ""}${area} XXX ${lastFour}`.trim();
}

function contactName(contact: GhlContact, webhook: VoiceCallWebhook): string {
  const combined = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  return contact.name ?? (combined || webhook.clientName || "Unknown client");
}

function crmUrl(location: LocationConfig, contactId: string): string | undefined {
  if (!location.contactUrlTemplate) return undefined;
  const value = location.contactUrlTemplate
    .replaceAll("{locationId}", encodeURIComponent(location.id))
    .replaceAll("{contactId}", encodeURIComponent(contactId));
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export class TelegramHttpClient implements TelegramClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepFn: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: TelegramHttpClientOptions) {
    this.baseUrl = `https://api.telegram.org/bot${options.token}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepFn = options.sleep ?? sleep;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async sendText(chatId: string, text: string, options: TelegramMessageOptions = {}): Promise<number> {
    const result = await this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_notification: false,
      disable_web_page_preview: true,
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
    const messageId = result.result?.message_id;
    if (messageId === undefined) {
      throw new ExternalServiceError({
        service: "telegram",
        code: "missing_message_id",
        retryable: false,
        message: "Telegram response did not include a message ID",
      });
    }
    return messageId;
  }

  async sendCallNotification(input: {
    chatId: string;
    salesName: string;
    location: LocationConfig;
    webhook: VoiceCallWebhook;
    contact: GhlContact;
  }): Promise<number> {
    const name = contactName(input.contact, input.webhook);
    const phone = input.contact.phone ?? input.webhook.clientPhone;
    const lines = [
      `<b>${input.location.displayName} | AI CALL COMPLETED</b>`,
      "",
      `Client: ${escapeHtml(name)}`,
      `Phone: ${escapeHtml(maskPhone(phone))}`,
      `Assigned Sales: ${escapeHtml(input.salesName)}`,
      "",
      "AI has completed a call with this client.",
      "Please review the conversation and follow up if necessary.",
    ];
    if (input.webhook.callSummary) {
      lines.push("", `<b>Call Summary</b>`, escapeHtml(input.webhook.callSummary));
    }
    const url = crmUrl(input.location, input.webhook.contactId);
    const options: TelegramMessageOptions = {};
    if (url) options.replyMarkup = { inline_keyboard: [[{ text: "Open in CRM", url }]] };
    return this.sendText(input.chatId, lines.join("\n"), options);
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/getMe`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = z.object({
      ok: z.literal(true),
      result: z.object({ id: z.number(), username: z.string().optional() }),
    }).parse(await response.json());
    return {
      id: payload.result.id,
      ...(payload.result.username ? { username: payload.result.username } : {}),
    };
  }

  private async call(method: string, body: Record<string, unknown>): Promise<z.infer<typeof telegramResponseSchema>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const parsed = telegramResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new ExternalServiceError({
            service: "telegram",
            code: "invalid_response",
            retryable: response.status >= 500,
            message: "Telegram returned an invalid response",
            statusCode: response.status,
          });
        }
        if (response.ok && parsed.data.ok) return parsed.data;
        const statusCode = parsed.data.error_code ?? response.status;
        const retryable = statusCode === 429 || statusCode >= 500;
        const error = new ExternalServiceError({
          service: "telegram",
          code: statusCode === 403 ? "bot_blocked" : `http_${statusCode}`,
          retryable,
          message: `Telegram request failed with HTTP ${statusCode}`,
          statusCode,
        });
        if (!retryable || attempt === this.maxAttempts) throw error;
        lastError = error;
        const retryAfter = parsed.data.parameters?.retry_after;
        await this.sleepFn(retryAfter ? Math.min(retryAfter * 1000, 30_000) : 400 * 2 ** (attempt - 1));
      } catch (error) {
        if (error instanceof ExternalServiceError) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) {
          throw new ExternalServiceError({
            service: "telegram",
            code: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_error",
            retryable: true,
            message: "Telegram request failed before receiving a valid response",
            cause: error,
          });
        }
        await this.sleepFn(400 * 2 ** (attempt - 1));
      }
    }
    throw new ExternalServiceError({
      service: "telegram",
      code: "unknown",
      retryable: true,
      message: "Telegram request failed",
      cause: lastError,
    });
  }
}
