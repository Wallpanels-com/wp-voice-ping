import { loadConfig } from "../src/config.js";
import { TelegramHttpClient } from "../src/telegram.js";

const config = loadConfig();
const telegram = new TelegramHttpClient({ token: config.telegramBotToken });
const bot = await telegram.getMe();
const expected = config.telegramBotUsername.toLowerCase();
const actual = bot.username?.toLowerCase();
if (!actual || actual !== expected) {
  throw new Error("Telegram bot username does not match TELEGRAM_BOT_USERNAME");
}
process.stdout.write(`Telegram bot verified: @${bot.username}\n`);
