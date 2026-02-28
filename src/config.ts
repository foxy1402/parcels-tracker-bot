import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TRACK123_API_SECRET: z.string().min(1),
  ALLOWED_USER_IDS: z.string().min(1),
  TRACK123_BASE_URL: z.string().url().default("https://api.track123.com/gateway/open-api"),
  DB_PATH: z.string().default("./data/bot.db"),
  TIMEZONE: z.string().default("UTC"),
  SYNC_LOOKBACK_DAYS: z.coerce.number().int().positive().default(365),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  TRACK123_MAX_RPS: z.coerce.number().positive().default(2),
  TRACK123_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

const parsed = envSchema.parse(process.env);

const allowedUserIds = parsed.ALLOWED_USER_IDS.split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .map((v) => Number(v))
  .filter((n) => Number.isInteger(n));

if (allowedUserIds.length === 0) {
  throw new Error("ALLOWED_USER_IDS must contain at least one numeric Telegram user id");
}

export const config = {
  telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
  track123ApiSecret: parsed.TRACK123_API_SECRET,
  track123BaseUrl: parsed.TRACK123_BASE_URL.replace(/\/$/, ""),
  allowedUserIds: new Set<number>(allowedUserIds),
  dbPath: parsed.DB_PATH,
  timezone: parsed.TIMEZONE,
  syncLookbackDays: parsed.SYNC_LOOKBACK_DAYS,
  pollIntervalSeconds: parsed.POLL_INTERVAL_SECONDS,
  track123MaxRps: parsed.TRACK123_MAX_RPS,
  track123MaxConcurrency: parsed.TRACK123_MAX_CONCURRENCY,
  logLevel: parsed.LOG_LEVEL
};
