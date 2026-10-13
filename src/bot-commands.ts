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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function compactUuid(uuid: string): string {
  return Buffer.from(uuid.replaceAll("-", ""), "hex").toString("base64url");
}

function expandUuid(value: string): string | null {
  const hex = Buffer.from(value, "base64url").toString("hex");
  if (!/^[a-f0-9]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    private readonly store: Store,
    private readonly telegram: TelegramClient,
  ) {}

  async handle(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.text || message.chat.type !== "private") return;
    const parsed = commandParts(message.text);
    if (!parsed) return;
    const chatId = String(message.chat.id);

    if (parsed.command === "start") {
      if (message.from?.id === undefined) return;
      const result = await this.store.startTelegramUser({
        telegramUserId: String(message.from.id),
        chatId,
        ...(message.from?.username ? { telegramUsername: message.from.username } : {}),
        ...(message.from?.first_name ? { firstName: message.from.first_name } : {}),
        ...(message.from?.last_name ? { lastName: message.from.last_name } : {}),
      });
      if (result.kind === "connected") {
        await this.telegram.sendText(
          chatId,
          `Connected as <b>${escapeHtml(result.salesName)}</b>. ${result.isAdmin
            ? "Administrator access is active; you will receive all completed calls."
            : "You will receive calls assigned to you."}`,
        );
      } else if (result.kind === "disabled") {
        await this.telegram.sendText(chatId, `Profile <b>${escapeHtml(result.salesName)}</b> is disabled. Contact an administrator.`);
      } else {
        await this.telegram.sendText(chatId, "Your access request is pending administrator approval. No client data will be sent before approval.");
        if (result.created) await this.notifyAdminsOfRequest(result.requestId, message.from.username);
      }
      return;
    }

    if (parsed.command === "status") {
      const status = await this.store.getBindingStatus(chatId);
      if (!status) {
        await this.telegram.sendText(chatId, "This Telegram account is not connected. Send <code>/start</code> to request access.");
        return;
      }
      const locations = status.locations.length > 0
        ? status.locations.map((item) => `${item.locationName}: ${item.ghlUserId}`).join("\n")
        : "No CRM mapping configured";
      await this.telegram.sendText(
        chatId,
        `<b>WP Voice Ping status</b>\nSales: ${escapeHtml(status.salesName)}\nActive: ${status.active ? "yes" : "no"}\nRole: ${status.isAdmin ? "administrator" : "sales"}\n${escapeHtml(locations)}`,
      );
      return;
    }

    if (parsed.command === "help") {
      await this.telegram.sendText(
        chatId,
        "<b>WP Voice Ping</b>\n/start — connect or request access\n/status — check your connection\n/help — show this message\n/admin — administrator menu",
      );
      return;
    }

    if (parsed.command === "admin") {
      const status = await this.store.getBindingStatus(chatId);
      if (!status?.active || !status.isAdmin) {
        await this.telegram.sendText(chatId, "Administrator access is required.");
        return;
      }
      await this.sendAdminMenu(chatId);
    }
  }

  private async notifyAdminsOfRequest(requestId: string, username?: string): Promise<void> {
    const admins = await this.store.listActiveAdminRecipients();
    const label = username ? `@${escapeHtml(username)}` : "a Telegram user";
    const token = compactUuid(requestId);
    await Promise.allSettled(admins.map((admin) => this.telegram.sendText(
      admin.chatId,
      `<b>New access request</b>\n${label}\nApprove only after confirming the person's identity.`,
      { replyMarkup: { inline_keyboard: [[
        { text: "Approve", callback_data: `req:a:${token}` },
        { text: "Reject", callback_data: `req:r:${token}` },
      ]] } },
    )));
  }

  private async sendAdminMenu(chatId: string): Promise<void> {
    await this.telegram.sendText(chatId, "<b>WP Voice Ping admin</b>", {
      replyMarkup: { inline_keyboard: [
        [{ text: "Employees & statuses", callback_data: "admin:staff" }],
        [{ text: "Pending approvals", callback_data: "admin:pending" }],
        [{ text: "Test notification", callback_data: "admin:test" }],
      ] },
    });
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const chatId = callback.message ? String(callback.message.chat.id) : String(callback.from.id);
    const status = await this.store.getBindingStatus(chatId);
    if (!status?.active || !status.isAdmin) {
      await this.telegram.answerCallbackQuery(callback.id, "Administrator access is required");
      return;
    }
    const data = callback.data ?? "";
    await this.telegram.answerCallbackQuery(callback.id);

    if (data === "admin:staff") {
      const sales = await this.store.listSales();
      const lines = sales.map((item) => {
        const binding = item.binding?.active ? "connected" : "not connected";
        return `${item.active ? "✅" : "⛔"} ${escapeHtml(item.name)}${item.isAdmin ? " (admin)" : ""} — ${binding}`;
      });
      const buttons = sales.map((item) => [{
        text: `${item.active ? "Disable" : "Enable"} ${item.name}`,
        callback_data: `staff:${compactUuid(item.id)}:${item.active ? "0" : "1"}`,
      }]);
      await this.telegram.sendText(chatId, `<b>Employees</b>\n${lines.join("\n")}`, {
        replyMarkup: { inline_keyboard: buttons },
      });
      return;
    }

    if (data === "admin:pending") {
      const pending = await this.store.listPendingAccessRequests();
      if (pending.length === 0) {
        await this.telegram.sendText(chatId, "No pending access requests.");
        return;
      }
      for (const request of pending) {
        const username = request.telegramUsername ? `@${escapeHtml(request.telegramUsername)}` : "username unavailable";
        await this.telegram.sendText(chatId, `<b>${escapeHtml(request.displayName)}</b>\n${username}`, {
          replyMarkup: { inline_keyboard: [[
            { text: "Approve", callback_data: `req:a:${compactUuid(request.id)}` },
            { text: "Reject", callback_data: `req:r:${compactUuid(request.id)}` },
          ]] },
        });
      }
      return;
    }

    if (data === "admin:test") {
      await this.telegram.sendText(
        chatId,
        "<b>WP VOICE PING | TEST</b>\nAdministrator notifications are working.\nNo CRM client data was used.",
      );
      return;
    }

    if (data.startsWith("staff:")) {
      const [, salesToken, activeFlag] = data.split(":");
      const salesUserId = salesToken ? expandUuid(salesToken) : null;
      if (!salesUserId || !["0", "1"].includes(activeFlag ?? "")) return;
      const updated = await this.store.setSalesActive(salesUserId, activeFlag === "1");
      await this.telegram.sendText(chatId, updated ? "Employee status updated." : "Employee not found.");
      return;
    }

    if (data.startsWith("req:r:")) {
      const requestId = expandUuid(data.slice(6));
      const rejected = requestId
        ? await this.store.rejectAccessRequest(requestId, String(callback.from.id))
        : false;
      await this.telegram.sendText(chatId, rejected ? "Access request rejected." : "Request is no longer pending.");
      return;
    }

    if (data.startsWith("req:a:")) {
      const requestId = expandUuid(data.slice(6));
      if (!requestId) return;
      const sales = (await this.store.listSales()).filter((item) => item.active);
      await this.telegram.sendText(chatId, "Select the confirmed employee profile:", {
        replyMarkup: { inline_keyboard: sales.map((item) => [{
          text: `${item.name}${item.binding?.active ? " (rebind)" : ""}`,
          callback_data: `link:${compactUuid(requestId)}:${compactUuid(item.id)}`,
        }]) },
      });
      return;
    }

    if (data.startsWith("link:")) {
      const [, requestToken, salesToken] = data.split(":");
      const requestId = requestToken ? expandUuid(requestToken) : null;
      const salesUserId = salesToken ? expandUuid(salesToken) : null;
      if (!requestId || !salesUserId) return;
      const result = await this.store.approveAccessRequest({
        requestId,
        salesUserId,
        adminTelegramUserId: String(callback.from.id),
      });
      if (result.kind === "approved") {
        await this.telegram.sendText(chatId, `Connected as <b>${escapeHtml(result.salesName)}</b>.`);
        await this.telegram.sendText(result.chatId, `Access approved. Connected as <b>${escapeHtml(result.salesName)}</b>.`);
      } else {
        await this.telegram.sendText(chatId, `Unable to approve: ${result.kind}.`);
      }
    }
  }
}
