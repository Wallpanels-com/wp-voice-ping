import { randomBytes } from "node:crypto";

import type { AppConfig } from "./config.js";
import type { TelegramUpdate } from "./domain.js";
import { hashConnectionCode } from "./security.js";
import type { Store } from "./store.js";
import type { TelegramClient } from "./telegram.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(length = 8): string {
  const bytes = randomBytes(length);
  return [...bytes].map((value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

function commandParts(text: string): { command: string; argument?: string } | null {
  if (!text.startsWith("/")) return null;
  const [rawCommand, rawArgument] = text.trim().split(/\s+/, 2);
  if (!rawCommand) return null;
  const command = rawCommand.slice(1).split("@", 1)[0]?.toLowerCase();
  if (!command) return null;
  return rawArgument ? { command, argument: rawArgument.trim() } : { command };
}

export class ConnectionCodeService {
  constructor(private readonly config: AppConfig, private readonly store: Store) {}

  async create(salesUserId: string, ttlMinutes = 30): Promise<{ code: string; expiresAt: Date } | null> {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const created = await this.store.createConnectionCode({
      salesUserId,
      codeHash: hashConnectionCode(code, this.config.linkCodePepper),
      expiresAt,
    });
    return created ? { code, expiresAt } : null;
  }
}

export class BotCommandService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly telegram: TelegramClient,
  ) {}

  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text || message.chat.type !== "private") return;
    const parsed = commandParts(message.text);
    if (!parsed) return;
    const chatId = String(message.chat.id);

    if (parsed.command === "start") {
      if (!parsed.argument) {
        await this.telegram.sendText(
          chatId,
          "Welcome to WP Voice Ping. Ask an administrator for a one-time connection code, then open the provided link or send <code>/start CODE</code>.",
        );
        return;
      }
      const result = await this.store.redeemConnectionCode({
        codeHash: hashConnectionCode(parsed.argument, this.config.linkCodePepper),
        chatId,
        ...(message.from?.id !== undefined ? { telegramUserId: String(message.from.id) } : {}),
        ...(message.from?.username ? { telegramUsername: message.from.username } : {}),
      });
      const textByResult = {
        linked: `Connected successfully as <b>${result.kind === "linked" ? result.salesName : ""}</b>. You will receive notifications only for CRM contacts assigned to you.`,
        invalid: "This connection code is invalid. Ask an administrator for a new code.",
        expired: "This connection code has expired. Ask an administrator for a new code.",
        used: "This connection code has already been used. Ask an administrator for a new code.",
        sales_disabled: "This sales profile is disabled. Contact an administrator.",
        chat_already_linked: "This Telegram account is already connected to another sales profile. Contact an administrator.",
      } as const;
      await this.telegram.sendText(chatId, textByResult[result.kind]);
      return;
    }

    if (parsed.command === "status") {
      const status = await this.store.getBindingStatus(chatId);
      if (!status) {
        await this.telegram.sendText(chatId, "This Telegram account is not connected. Use <code>/start CODE</code>.");
        return;
      }
      const locations = status.locations.length > 0
        ? status.locations.map((item) => `${item.locationName}: ${item.ghlUserId}`).join("\n")
        : "No CRM mapping configured";
      await this.telegram.sendText(
        chatId,
        `<b>WP Voice Ping status</b>\nSales: ${status.salesName}\nActive: ${status.active ? "yes" : "no"}\n${locations}`,
      );
      return;
    }

    if (parsed.command === "help") {
      await this.telegram.sendText(
        chatId,
        "<b>WP Voice Ping</b>\n/start CODE — connect your account\n/status — check your connection\n/help — show this message",
      );
    }
  }
}
