import { describe, expect, it, vi } from "vitest";

import { BotCommandService } from "../src/bot-commands.js";
import type { AppConfig } from "../src/config.js";
import type { TelegramUpdate } from "../src/domain.js";
import type { HighLevelClient } from "../src/highlevel.js";
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

const config = {
  nodeEnv: "test",
  port: 3000,
  logLevel: "silent",
  databaseUrl: "postgresql://test",
  telegramBotToken: "test-token",
  telegramBotUsername: "WPVoicePingBot",
  telegramWebhookSecret: "telegram-secret-value-123456",
  ghlWebhookSecret: "ghl-secret-value-123456789",
  adminApiToken: "admin-secret-value-123456789",
  linkCodePepper: "pepper-value-123456789012",
  adminTelegramChatIds: new Set<string>(),
  locations: new Map([["Iwpfx8zGzpsZszcnGovT", {
    id: "Iwpfx8zGzpsZszcnGovT",
    code: "wallpanels",
    displayName: "WALLPANELS",
    ghlToken: "test-ghl-token",
  }]]),
} satisfies AppConfig;

const highLevel = {
  listUsers: vi.fn().mockResolvedValue([]),
} as unknown as HighLevelClient;

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
  const getBindingStatusByTelegramUserId = vi.fn().mockResolvedValue(null);
  const store = {
    startTelegramUser,
    listActiveManagerRecipients: vi.fn().mockResolvedValue(admins),
    getBindingStatus: vi.fn().mockResolvedValue(null),
    getBindingStatusByTelegramUserId,
  } as unknown as Store;
  const telegram = new BotTelegram();
  return {
    service: new BotCommandService(config, store, telegram, highLevel),
    store,
    telegram,
    startTelegramUser,
    getBindingStatusByTelegramUserId,
  };
}

describe("Telegram onboarding", () => {
  it("connects with plain /start using the numeric Telegram ID", async () => {
    const { service, telegram, startTelegramUser } = setup({
      kind: "connected", salesName: "Mary", isAdmin: false, canManage: false,
    });
    await service.handle(startUpdate("mariarayme"));
    expect(startTelegramUser).toHaveBeenCalledWith(expect.objectContaining({
      telegramUserId: "777",
      chatId: "777",
      telegramUsername: "mariarayme",
    }));
    expect(telegram.messages[0]?.text).toContain("Connected as");
  });

  it("creates an approval request and alerts only connected managers", async () => {
    const admins: NotificationRecipient[] = [
      { salesUserId: "a", salesName: "Dmitry", chatId: "100", isAdmin: true },
    ];
    const { service, telegram } = setup({
      kind: "pending", requestId: "10000000-0000-4000-8000-000000000999", created: true,
    }, admins);
    await service.handle(startUpdate());
    expect(telegram.messages.map((item) => item.chatId)).toEqual(["777", "100"]);
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

  it("does not grant /admin to an all-call recipient without manager permission", async () => {
    const { service, telegram, getBindingStatusByTelegramUserId } = setup({
      kind: "pending", requestId: "10000000-0000-4000-8000-000000000999", created: false,
    });
    getBindingStatusByTelegramUserId.mockResolvedValue({
      salesUserId: "katherina",
      salesName: "Katherina",
      active: true,
      isAdmin: true,
      canManage: false,
      locations: [],
    });
    await service.handle({
      update_id: 2,
      message: {
        message_id: 2,
        text: "/admin",
        chat: { id: 777, type: "private" },
        from: { id: 777, username: "katherina_ostroglo" },
      },
    });
    expect(getBindingStatusByTelegramUserId).toHaveBeenCalledWith("777");
    expect(telegram.messages[0]?.text).toContain("Administrator access is required");
  });

  it("creates a missing Neon profile from the selected live GHL user and approves immediately", async () => {
    const requestId = "10000000-0000-4000-8000-000000000999";
    const requestToken = Buffer.from(requestId.replaceAll("-", ""), "hex").toString("base64url");
    const createSales = vi.fn().mockResolvedValue("10000000-0000-4000-8000-000000000777");
    const approveAccessRequest = vi.fn().mockResolvedValue({
      kind: "approved", salesName: "New Sales", chatId: "900",
    });
    const store = {
      getBindingStatusByTelegramUserId: vi.fn().mockResolvedValue({
        salesUserId: "dima",
        salesName: "Dmitry",
        active: true,
        isAdmin: true,
        canManage: true,
        locations: [],
      }),
      listSales: vi.fn().mockResolvedValue([]),
      listPendingAccessRequests: vi.fn().mockResolvedValue([{
        id: requestId,
        telegramUserId: "900",
        chatId: "900",
        telegramUsername: "new_sales",
        displayName: "New Sales",
        requestedAt: new Date(),
      }]),
      createSales,
      approveAccessRequest,
    } as unknown as Store;
    const currentHighLevel = {
      listUsers: vi.fn().mockResolvedValue([{ id: "ghl-user-1", name: "New Sales" }]),
    } as unknown as HighLevelClient;
    const telegram = new BotTelegram();
    const service = new BotCommandService(config, store, telegram, currentHighLevel);
    await service.handle({
      update_id: 3,
      callback_query: {
        id: "callback-1",
        data: `ghl:${requestToken}:ghl-user-1`,
        from: { id: 777, username: "dimaqim" },
        message: { message_id: 3, chat: { id: 777, type: "private" } },
      },
    });
    expect(createSales).toHaveBeenCalledWith({
      name: "New Sales",
      telegramUsername: "new_sales",
      locations: [{ locationId: "Iwpfx8zGzpsZszcnGovT", ghlUserId: "ghl-user-1" }],
    });
    expect(approveAccessRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      adminTelegramUserId: "777",
    }));
    expect(telegram.messages.at(-1)).toMatchObject({ chatId: "900" });
  });
});
