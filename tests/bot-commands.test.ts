import { describe, expect, it, vi } from "vitest";

import { BotCommandService } from "../src/bot-commands.js";
import type { TelegramUpdate } from "../src/domain.js";
import type { NotificationRecipient, Store, TelegramStartResult } from "../src/store.js";
import type { TelegramClient, TelegramMessageOptions } from "../src/telegram.js";

class BotTelegram implements TelegramClient {
  readonly messages: Array<{ chatId: string; text: string; options?: TelegramMessageOptions }> = [];
  async sendText(chatId: string, text: string, options?: TelegramMessageOptions): Promise<number> {
    this.messages.push({ chatId, text, ...(options ? { options } : {}) });
    return this.messages.length;
  }
  async sendCallNotification(): Promise<number> { return 1; }
  async answerCallbackQuery(): Promise<void> {}
  async setWebhook(): Promise<void> {}
  async setCommands(): Promise<void> {}
  async getMe(): Promise<{ id: number; username?: string }> { return { id: 1 }; }
}

function startUpdate(username = "new_sales"): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      text: "/start",
      chat: { id: 777, type: "private" },
      from: { id: 777, username, first_name: "New" },
    },
  };
}

function setup(result: TelegramStartResult, admins: NotificationRecipient[] = []) {
  const startTelegramUser = vi.fn().mockResolvedValue(result);
  const store = {
    startTelegramUser,
    listActiveAdminRecipients: vi.fn().mockResolvedValue(admins),
    getBindingStatus: vi.fn().mockResolvedValue(null),
  } as unknown as Store;
  const telegram = new BotTelegram();
  return { service: new BotCommandService(store, telegram), store, telegram, startTelegramUser };
}

describe("Telegram onboarding", () => {
  it("connects with plain /start using the numeric Telegram ID", async () => {
    const { service, telegram, startTelegramUser } = setup({
      kind: "connected", salesName: "Mary", isAdmin: false,
    });
    await service.handle(startUpdate("mariarayme"));
    expect(startTelegramUser).toHaveBeenCalledWith(expect.objectContaining({
      telegramUserId: "777",
      chatId: "777",
      telegramUsername: "mariarayme",
    }));
    expect(telegram.messages[0]?.text).toContain("Connected as");
  });

  it("creates an approval request and alerts all connected admins", async () => {
    const admins: NotificationRecipient[] = [
      { salesUserId: "a", salesName: "Dmitry", chatId: "100", isAdmin: true },
      { salesUserId: "b", salesName: "Katherina", chatId: "200", isAdmin: true },
    ];
    const { service, telegram } = setup({
      kind: "pending", requestId: "10000000-0000-4000-8000-000000000999", created: true,
    }, admins);
    await service.handle(startUpdate());
    expect(telegram.messages.map((item) => item.chatId)).toEqual(["777", "100", "200"]);
    const buttons = telegram.messages[1]?.options?.replyMarkup?.inline_keyboard[0];
    expect(buttons).toHaveLength(2);
    expect(buttons?.[0]).toMatchObject({ text: "Approve" });
    expect(buttons?.[1]).toMatchObject({ text: "Reject" });
  });

  it("does not notify admins again for an already pending request", async () => {
    const admins: NotificationRecipient[] = [
      { salesUserId: "a", salesName: "Dmitry", chatId: "100", isAdmin: true },
    ];
    const { service, telegram } = setup({
      kind: "pending", requestId: "10000000-0000-4000-8000-000000000999", created: false,
    }, admins);
    await service.handle(startUpdate());
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]?.chatId).toBe("777");
  });
});
