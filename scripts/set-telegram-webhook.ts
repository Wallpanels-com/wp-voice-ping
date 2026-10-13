import { loadConfig } from "../src/config.js";
import { TelegramHttpClient } from "../src/telegram.js";

const config = loadConfig();
if (!config.publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required to configure the Telegram webhook");
const telegram = new TelegramHttpClient({ token: config.telegramBotToken });
const bot = await telegram.getMe();
await telegram.setWebhook(`${config.publicBaseUrl}/telegram/webhook`, config.telegramWebhookSecret);
process.stdout.write(`Telegram webhook configured for bot ${bot.username ?? bot.id}\n`);
