import { describe, expect, it, vi } from "vitest";

import type { LocationConfig } from "../src/config.js";
import { HighLevelHttpClient } from "../src/highlevel.js";
import { conversationUrl, TelegramHttpClient } from "../src/telegram.js";

const location: LocationConfig = {
  id: "Iwpfx8zGzpsZszcnGovT",
  code: "wallpanels",
  displayName: "WALLPANELS",
  ghlToken: "test-token",
};

describe("HighLevelHttpClient", () => {
  it("retries a temporary HTTP failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        contact: {
          id: "contact-1",
          locationId: location.id,
          assignedTo: "user-1",
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new HighLevelHttpClient({ fetchImpl, sleep: async () => undefined });
    const contact = await client.getContact(location, "contact-1");
    expect(contact.assignedTo).toBe("user-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("resolves a conversation ID for a contact", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      conversations: [{ id: "conversation-1", contactId: "contact-1", locationId: location.id }],
      total: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new HighLevelHttpClient({ fetchImpl });
    await expect(client.findConversation(location, "contact-1")).resolves.toMatchObject({
      id: "conversation-1",
      contactId: "contact-1",
      locationId: location.id,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("contactId=contact-1");
  });

  it("lists current GHL users for administrator onboarding", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      users: [{ id: "user-1", firstName: "New", lastName: "Sales" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new HighLevelHttpClient({ fetchImpl });
    await expect(client.listUsers(location)).resolves.toEqual([{ id: "user-1", name: "New Sales" }]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`locationId=${location.id}`);
  });
});

describe("TelegramHttpClient", () => {
  it("builds the verified HighLevel conversation deep link", () => {
    expect(conversationUrl(location.id, "conversation-1")).toBe(
      `https://app.gohighlevel.com/v2/location/${location.id}/conversations/conversations/conversation-1`,
    );
  });
  it("accepts Telegram's boolean setWebhook result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: true,
      description: "Webhook was set",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelegramHttpClient({ token: "test-telegram-token", fetchImpl });

    await expect(client.setWebhook("https://example.com/telegram/webhook", "secret-token"))
      .resolves.toBeUndefined();
  });

  it("honors retry_after and retries without silent delivery", async () => {
    const delays: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 1 },
      }), { status: 429, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 77 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelegramHttpClient({
      token: "test-telegram-token",
      fetchImpl,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    const messageId = await client.sendText("123", "test");
    expect(messageId).toBe(77);
    expect(delays).toEqual([1000]);
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(secondBody.disable_notification).toBe(false);
  });

  it("adds Open Conversation to every call notification", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { message_id: 88 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelegramHttpClient({ token: "test-telegram-token", fetchImpl });
    await client.sendCallNotification({
      chatId: "123",
      salesName: "Mary",
      location,
      webhook: {
        eventId: "event-1",
        eventType: "voice_ai_call.completed",
        locationId: location.id,
        contactId: "contact-1",
        callStatus: "completed",
      },
      contact: { id: "contact-1", locationId: location.id },
      conversationId: "conversation-1",
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
    };
    expect(body.reply_markup.inline_keyboard[0]?.[0]).toEqual({
      text: "Open Conversation",
      url: `https://app.gohighlevel.com/v2/location/${location.id}/conversations/conversations/conversation-1`,
    });
  });
});
