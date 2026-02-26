import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { WatchRepository } from "./store/watch-repository.js";
import { Track123Client, snapshotHash } from "./services/track123.js";
import { formatSnapshot } from "./bot/format.js";
import { startPoller } from "./jobs/poll-updates.js";
import { parseBaseArgs, parseTrackArgs } from "./bot/command-args.js";

const watchRepo = new WatchRepository();
const trackClient = new Track123Client(
  config.track123BaseUrl,
  config.track123ApiSecret,
  config.track123MaxRps,
  config.track123MaxConcurrency
);

const bot = new Telegraf(config.telegramBotToken);

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !config.allowedUserIds.has(userId)) {
    if (ctx.chat?.id) {
      await ctx.reply("Not authorized.");
    }
    return;
  }

  await next();
});

bot.start(async (ctx) => {
  await ctx.reply(
    [
      "Parcel Tracker Bot",
      "",
      "Commands:",
      "/track <tracking_number> [carrier:code] [label]",
      "/status [tracking_number] [carrier_code]",
      "/list",
      "/untrack <tracking_number>",
      "",
      "Examples:",
      "/track SPXVN064584367312 áo cho mập",
      "/track SPXVN064584367312 carrier:SPXVN áo cho mập"
    ].join("\n")
  );
});

bot.command("track", async (ctx) => {
  const { trackingNumber, carrierCode, label } = parseTrackArgs(ctx.message.text);
  if (!trackingNumber) {
    await ctx.reply("Usage: /track <tracking_number> [carrier:code] [label]");
    return;
  }

  try {
    await trackClient.importTracking(trackingNumber, carrierCode);
  } catch (error) {
    logger.warn({ err: error, trackingNumber }, "import failed, continuing to query");
  }

  try {
    const snapshot = await trackClient.queryTracking(trackingNumber, carrierCode);
    watchRepo.upsertWatch(ctx.from.id, trackingNumber, snapshot.carrierCode ?? carrierCode, label);

    if (snapshot.terminal) {
      await ctx.reply(`This parcel is already in terminal state.\n\n${formatSnapshot(snapshot, { label })}`);
      watchRepo.removeWatch(ctx.from.id, trackingNumber);
      return;
    }

    watchRepo.updateState(ctx.from.id, trackingNumber, snapshotHash(snapshot), snapshot.carrierCode ?? carrierCode);
    await ctx.reply(`Tracking started.\n\n${formatSnapshot(snapshot, { label })}`);
  } catch (error) {
    logger.error({ err: error, trackingNumber }, "track command failed");
    await ctx.reply("Unable to track this parcel right now. Try again later or provide an explicit carrier code.");
  }
});

bot.command("status", async (ctx) => {
  const [trackingNumber, carrierCode] = parseBaseArgs(ctx.message.text);
  if (!trackingNumber) {
    const watches = watchRepo.listByUser(ctx.from.id);
    if (watches.length === 0) {
      await ctx.reply("No active tracked parcels.");
      return;
    }

    await ctx.reply(`Refreshing ${watches.length} tracked parcel(s)...`);
    for (const watch of watches) {
      try {
        const snapshot = await trackClient.queryTracking(watch.trackingNumber, watch.carrierCode);
        if (snapshot.terminal) {
          watchRepo.removeWatch(ctx.from.id, watch.trackingNumber);
        } else {
          watchRepo.updateState(ctx.from.id, watch.trackingNumber, snapshotHash(snapshot), snapshot.carrierCode);
        }
        await ctx.reply(formatSnapshot(snapshot, { label: watch.label }));
      } catch (error) {
        logger.error({ err: error, trackingNumber: watch.trackingNumber }, "status refresh failed");
        await ctx.reply(`Unable to fetch status for ${watch.trackingNumber}.`);
      }
    }
    return;
  }

  try {
    const watch = watchRepo
      .listByUser(ctx.from.id)
      .find((w) => w.trackingNumber.toUpperCase() === trackingNumber.toUpperCase());
    const snapshot = await trackClient.queryTracking(trackingNumber, carrierCode ?? watch?.carrierCode);
    if (snapshot.terminal && watch) {
      watchRepo.removeWatch(ctx.from.id, watch.trackingNumber);
    } else if (watch) {
      watchRepo.updateState(ctx.from.id, watch.trackingNumber, snapshotHash(snapshot), snapshot.carrierCode);
    }
    await ctx.reply(formatSnapshot(snapshot, { label: watch?.label }));
  } catch (error) {
    logger.error({ err: error, trackingNumber }, "status command failed");
    await ctx.reply("Unable to fetch status right now.");
  }
});

bot.command("list", async (ctx) => {
  const watches = watchRepo.listByUser(ctx.from.id);
  if (watches.length === 0) {
    await ctx.reply("No active tracked parcels.");
    return;
  }

  const lines = watches.map(
    (w) => `- ${w.trackingNumber}${w.carrierCode ? ` (${w.carrierCode})` : ""}${w.label ? ` - ${w.label}` : ""}`
  );
  await ctx.reply(["Active parcels:", ...lines].join("\n"));
});

bot.command("untrack", async (ctx) => {
  const [trackingNumber] = parseBaseArgs(ctx.message.text);
  if (!trackingNumber) {
    await ctx.reply("Usage: /untrack <tracking_number>");
    return;
  }

  const removed = watchRepo.removeWatch(ctx.from.id, trackingNumber);
  if (removed === 0) {
    await ctx.reply("Parcel was not in your watch list.");
    return;
  }

  await ctx.reply(`Removed ${trackingNumber} from watch list.`);
});

bot.catch((error, ctx) => {
  logger.error({ err: error, update: ctx.update }, "telegram update error");
});

const pollTimer = startPoller(bot, watchRepo, trackClient, config.pollIntervalSeconds);

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function bootstrap(): Promise<void> {
  await bot.launch();
  logger.info({ pollEverySeconds: config.pollIntervalSeconds }, "bot started");
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  pollTimer.stop();
  await bot.stop(signal);
  process.exit(0);
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, "failed to start bot");
  process.exit(1);
});
