import { describe, expect, it, vi } from "vitest";

import type { LocationConfig } from "../src/config.js";
import { HighLevelHttpClient } from "../src/highlevel.js";
import { TelegramHttpClient } from "../src/telegram.js";

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
});

describe("TelegramHttpClient", () => {
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
});
