import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { BotCommandService, ConnectionCodeService } from "./bot-commands.js";
import type { AppConfig } from "./config.js";
import { voiceCallWebhookSchema, type TelegramUpdate } from "./domain.js";
import type { CallProcessor } from "./processor.js";
import { secureEquals } from "./security.js";
import type { Store } from "./store.js";
import type { TelegramClient } from "./telegram.js";

const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number(),
    text: z.string().optional(),
    chat: z.object({ id: z.number(), type: z.string() }),
    from: z.object({
      id: z.number(),
      username: z.string().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    }).optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string(),
    data: z.string().optional(),
    from: z.object({
      id: z.number(),
      username: z.string().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    }),
    message: z.object({
      message_id: z.number(),
      chat: z.object({ id: z.number(), type: z.string() }),
    }).optional(),
  }).optional(),
}).passthrough();

const createSalesSchema = z.object({
  name: z.string().trim().min(1).max(160),
  telegramUsername: z.string().trim().min(1).max(100).optional(),
  locations: z.array(z.object({
    locationId: z.string().trim().min(1).max(100),
    ghlUserId: z.string().trim().min(1).max(160),
  })).min(1).max(10),
});

const activeSchema = z.object({ active: z.boolean() });
const connectionCodeSchema = z.object({
  salesUserId: z.uuid(),
  ttlMinutes: z.number().int().min(5).max(1440).default(30),
});
const testMessageSchema = z.object({ salesUserId: z.uuid() });

interface BuildAppOptions {
  config: AppConfig;
  store: Store;
  processor: CallProcessor;
  telegram: TelegramClient;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-wp-voice-ping-secret",
          "req.headers.x-telegram-bot-api-secret-token",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 256 * 1024,
    trustProxy: true,
    requestIdHeader: "x-request-id",
  });
  const codeService = new ConnectionCodeService(options.config, options.store);
  const botCommands = new BotCommandService(options.store, options.telegram);

  app.get("/", async () => ({ service: "wp-voice-ping", status: "ok" }));

  app.get("/health", async (_request, reply) => {
    try {
      await options.store.healthCheck();
      return { status: "ok", database: "ok", uptimeSeconds: Math.floor(process.uptime()) };
    } catch {
      reply.code(503);
      return { status: "unavailable", database: "error" };
    }
  });

  app.post("/webhooks/ghl/voice-ai-call-completed", async (request, reply) => {
    const secret = headerValue(request.headers["x-wp-voice-ping-secret"]);
    if (!secureEquals(secret, options.config.ghlWebhookSecret)) {
      request.log.warn({ reason: "unauthorized_ghl_webhook" }, "Rejected GHL webhook");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = voiceCallWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.info({ reason: "invalid_webhook_payload" }, "Rejected invalid GHL webhook payload");
      return reply.code(422).send({ error: "invalid_payload", issues: parsed.error.issues.map((issue) => issue.path.join(".")) });
    }
    if (!options.config.locations.has(parsed.data.locationId)) {
      request.log.warn({ locationId: parsed.data.locationId, reason: "invalid_location" }, "Rejected unknown GHL location");
      return reply.code(422).send({ error: "invalid_location" });
    }

    const outcome = await options.processor.process(parsed.data);
    if (outcome.kind === "retryable_failure") {
      return reply.code(503).send(outcome);
    }
    if (outcome.kind === "permanent_failure") {
      return reply.code(422).send(outcome);
    }
    if (outcome.kind === "waiting") {
      return reply.code(202).send(outcome);
    }
    return reply.code(200).send(outcome);
  });

  app.post("/telegram/webhook", async (request, reply) => {
    const secret = headerValue(request.headers["x-telegram-bot-api-secret-token"]);
    if (!secureEquals(secret, options.config.telegramWebhookSecret)) {
      request.log.warn({ reason: "unauthorized_telegram_webhook" }, "Rejected Telegram webhook");
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = telegramUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_update" });
    await botCommands.handle(parsed.data as TelegramUpdate);
    return reply.code(200).send({ ok: true });
  });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = headerValue(request.headers.authorization);
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!secureEquals(token, options.config.adminApiToken)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.get("/admin/sales", { preHandler: requireAdmin }, async () => {
    return { sales: await options.store.listSales() };
  });

  app.post("/admin/sales", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createSalesSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_payload" });
    const uniqueLocationIds = new Set(parsed.data.locations.map((item) => item.locationId));
    if (uniqueLocationIds.size !== parsed.data.locations.length) {
      return reply.code(422).send({ error: "duplicate_location_mapping" });
    }
    if (parsed.data.locations.some((item) => !options.config.locations.has(item.locationId))) {
      return reply.code(422).send({ error: "invalid_location" });
    }
    const salesUserId = await options.store.createSales({
      name: parsed.data.name,
      locations: parsed.data.locations,
      ...(parsed.data.telegramUsername ? { telegramUsername: parsed.data.telegramUsername } : {}),
    });
    return reply.code(201).send({ salesUserId });
  });

  app.patch("/admin/sales/:salesUserId", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ salesUserId: z.uuid() }).safeParse(request.params);
    const body = activeSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(422).send({ error: "invalid_payload" });
    const updated = await options.store.setSalesActive(params.data.salesUserId, body.data.active);
    return updated ? reply.send({ updated: true }) : reply.code(404).send({ error: "sales_not_found" });
  });

  app.post("/admin/connection-codes", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = connectionCodeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_payload" });
    const created = await codeService.create(parsed.data.salesUserId, parsed.data.ttlMinutes);
    if (!created) return reply.code(404).send({ error: "active_sales_not_found" });
    return reply.code(201).send({
      code: created.code,
      expiresAt: created.expiresAt.toISOString(),
      deepLink: `https://t.me/${options.config.telegramBotUsername}?start=${created.code}`,
    });
  });

  app.post("/admin/test-message", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = testMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_payload" });
    const recipient = await options.store.getTestRecipient(parsed.data.salesUserId);
    if (!recipient) return reply.code(409).send({ error: "sales_not_connected" });
    const messageId = await options.telegram.sendText(
      recipient.chatId,
      `<b>WP VOICE PING | TEST</b>\nConnection verified for ${recipient.salesName}.\nNo CRM data was accessed for this test.`,
    );
    return reply.send({ delivered: true, messageId });
  });

  app.setErrorHandler((error, request, reply) => {
    const safeError = error instanceof Error ? error : new Error("Unknown request error");
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
    request.log.error({ errorName: safeError.name, code }, "Unhandled request error");
    void reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
