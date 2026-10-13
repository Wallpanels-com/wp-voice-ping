import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HighLevelHttpClient } from "./highlevel.js";
import { CallProcessor } from "./processor.js";
import { PgStore } from "./store.js";
import { TelegramHttpClient } from "./telegram.js";

const config = loadConfig();
const store = new PgStore({ connectionString: config.databaseUrl });
const telegram = new TelegramHttpClient({ token: config.telegramBotToken });
const highLevel = new HighLevelHttpClient();
const processorLogger = {
  info: (bindings: Record<string, unknown>, message: string) => {
    process.stdout.write(`${JSON.stringify({ level: "info", message, ...bindings })}\n`);
  },
  warn: (bindings: Record<string, unknown>, message: string) => {
    process.stdout.write(`${JSON.stringify({ level: "warn", message, ...bindings })}\n`);
  },
  error: (bindings: Record<string, unknown>, message: string) => {
    process.stderr.write(`${JSON.stringify({ level: "error", message, ...bindings })}\n`);
  },
};
const processor = new CallProcessor(config, store, highLevel, telegram, processorLogger);
const app = buildApp({ config, store, processor, telegram });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down WP Voice Ping");
  await app.close();
  await store.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(
    { port: config.port, nodeEnv: config.nodeEnv, locations: [...config.locations.keys()] },
    "WP Voice Ping started",
  );
} catch (error) {
  app.log.fatal({ errorName: error instanceof Error ? error.name : "unknown" }, "Failed to start WP Voice Ping");
  await store.close();
  process.exit(1);
}
