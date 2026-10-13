import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env.local" });
dotenv.config();

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: optionalString,
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d{6,12}:[A-Za-z0-9_-]{20,}$/),
  TELEGRAM_BOT_USERNAME: z.string().trim().min(3),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(24),
  GHL_WEBHOOK_SECRET: z.string().min(24),
  GHL_WALLPANELS_TOKEN: z.string().min(10),
  GHL_VERONA_TOKEN: z.string().min(10),
  WALLPANELS_LOCATION_ID: z.string().length(20),
  VERONA_LOCATION_ID: z.string().length(20),
  WALLPANELS_CONTACT_URL_TEMPLATE: optionalString,
  VERONA_CONTACT_URL_TEMPLATE: optionalString,
  ADMIN_API_TOKEN: z.string().min(24),
  LINK_CODE_PEPPER: z.string().min(24),
  ADMIN_TELEGRAM_CHAT_IDS: z.string().default(""),
  PUBLIC_BASE_URL: optionalUrl,
});

export interface LocationConfig {
  id: string;
  code: "wallpanels" | "verona_home";
  displayName: "WALLPANELS" | "VERONA HOME";
  ghlToken: string;
  contactUrlTemplate?: string;
}

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: string;
  databaseUrl: string;
  databaseUrlUnpooled?: string;
  telegramBotToken: string;
  telegramBotUsername: string;
  telegramWebhookSecret: string;
  ghlWebhookSecret: string;
  adminApiToken: string;
  linkCodePepper: string;
  adminTelegramChatIds: Set<string>;
  publicBaseUrl?: string;
  locations: ReadonlyMap<string, LocationConfig>;
}

function validatedTemplate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value.replace("{locationId}", "location").replace("{contactId}", "contact"));
  if (url.protocol !== "https:" || !value.includes("{locationId}") || !value.includes("{contactId}")) {
    throw new Error("CRM contact URL templates must be HTTPS and contain {locationId} and {contactId}");
  }
  return value;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(source);
  const wallpanelsTemplate = validatedTemplate(env.WALLPANELS_CONTACT_URL_TEMPLATE);
  const veronaTemplate = validatedTemplate(env.VERONA_CONTACT_URL_TEMPLATE);

  const locations = new Map<string, LocationConfig>();
  const wallpanels: LocationConfig = {
    id: env.WALLPANELS_LOCATION_ID,
    code: "wallpanels",
    displayName: "WALLPANELS",
    ghlToken: env.GHL_WALLPANELS_TOKEN,
  };
  if (wallpanelsTemplate) wallpanels.contactUrlTemplate = wallpanelsTemplate;
  const verona: LocationConfig = {
    id: env.VERONA_LOCATION_ID,
    code: "verona_home",
    displayName: "VERONA HOME",
    ghlToken: env.GHL_VERONA_TOKEN,
  };
  if (veronaTemplate) verona.contactUrlTemplate = veronaTemplate;
  locations.set(wallpanels.id, wallpanels);
  locations.set(verona.id, verona);

  const config: AppConfig = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramBotUsername: env.TELEGRAM_BOT_USERNAME.replace(/^@/, ""),
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    ghlWebhookSecret: env.GHL_WEBHOOK_SECRET,
    adminApiToken: env.ADMIN_API_TOKEN,
    linkCodePepper: env.LINK_CODE_PEPPER,
    adminTelegramChatIds: new Set(
      env.ADMIN_TELEGRAM_CHAT_IDS.split(",").map((value) => value.trim()).filter(Boolean),
    ),
    locations,
  };
  if (env.DATABASE_URL_UNPOOLED) config.databaseUrlUnpooled = env.DATABASE_URL_UNPOOLED;
  if (env.PUBLIC_BASE_URL) config.publicBaseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return config;
}
