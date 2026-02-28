import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { WatchRepository } from "./store/watch-repository.js";
import { Track123Client, snapshotHash } from "./services/track123.js";
import { formatSnapshot } from "./bot/format.js";
import { startPoller } from "./jobs/poll-updates.js";
import { parseBaseArgs, parseTrackArgs } from "./bot/command-args.js";
import { applySyncBatch, buildSyncWindow } from "./bot/sync.js";

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
      "/sync",
      "/list",
      "/untrack <tracking_number> [carrier_code]",
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
    const snapshot = await queryWithCarrierFallback(trackingNumber, carrierCode);
    watchRepo.upsertWatch(ctx.from.id, trackingNumber, snapshot.carrierCode ?? carrierCode, label);

    if (snapshot.terminal) {
      await tryDeleteRemoteTracking(trackingNumber, snapshot.carrierCode ?? carrierCode);
      await ctx.reply(`This parcel is already in terminal state.\n\n${formatSnapshot(snapshot, { label, timezone: config.timezone })}`);
      watchRepo.removeWatch(ctx.from.id, trackingNumber);
      return;
    }

    watchRepo.updateState(ctx.from.id, trackingNumber, snapshotHash(snapshot), snapshot.carrierCode ?? carrierCode);
    await ctx.reply(`Tracking started.\n\n${formatSnapshot(snapshot, { label, timezone: config.timezone })}`);
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
        const refreshed = await queryWithCarrierFallback(watch.trackingNumber, watch.carrierCode);
        if (refreshed.terminal) {
          await tryDeleteRemoteTracking(watch.trackingNumber, refreshed.carrierCode ?? watch.carrierCode);
          watchRepo.removeWatch(ctx.from.id, watch.trackingNumber);
        } else {
          watchRepo.updateState(ctx.from.id, watch.trackingNumber, snapshotHash(refreshed), refreshed.carrierCode);
        }
        await ctx.reply(formatSnapshot(refreshed, { label: watch.label, timezone: config.timezone }));
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
    const snapshot = await queryWithCarrierFallback(trackingNumber, carrierCode ?? watch?.carrierCode);
    if (snapshot.terminal && watch) {
      await tryDeleteRemoteTracking(watch.trackingNumber, snapshot.carrierCode ?? watch.carrierCode);
      watchRepo.removeWatch(ctx.from.id, watch.trackingNumber);
    } else if (watch) {
      watchRepo.updateState(ctx.from.id, watch.trackingNumber, snapshotHash(snapshot), snapshot.carrierCode);
    }
    await ctx.reply(formatSnapshot(snapshot, { label: watch?.label, timezone: config.timezone }));
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

bot.command("sync", async (ctx) => {
  const { createTimeStart, createTimeEnd } = buildSyncWindow(new Date(), config.syncLookbackDays);

  await ctx.reply(`Syncing trackings from Track123 (${createTimeStart} -> ${createTimeEnd})...`);

  const existing = new Set(watchRepo.listByUser(ctx.from.id).map((w) => w.trackingNumber.toUpperCase()));
  let synced = 0;
  let added = 0;
  let skippedTerminal = 0;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  try {
    for (let page = 0; page < 30; page += 1) {
      const result = await trackClient.listTrackingsByCreateTime(createTimeStart, createTimeEnd, 100, cursor);
      if (result.items.length === 0 && !result.nextCursor) {
        break;
      }

      const batch = applySyncBatch(existing, result.items);
      synced += batch.synced;
      added += batch.added;
      skippedTerminal += batch.skippedTerminal;

      for (const snapshot of batch.activeItems) {
        watchRepo.upsertWatch(ctx.from.id, snapshot.trackingNumber, snapshot.carrierCode);
        watchRepo.updateState(ctx.from.id, snapshot.trackingNumber, snapshotHash(snapshot), snapshot.carrierCode);
      }

      if (!result.nextCursor || seenCursors.has(result.nextCursor)) {
        break;
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    await ctx.reply(
      [`Sync complete.`, `- Active synced: ${synced}`, `- Newly added: ${added}`, `- Skipped terminal: ${skippedTerminal}`].join(
        "\n"
      )
    );
  } catch (error) {
    logger.error({ err: error }, "sync command failed");
    await ctx.reply("Sync failed. Track123 may be rate-limiting or query parameters were rejected.");
  }
});

bot.command("untrack", async (ctx) => {
  const [trackingNumber, carrierCode] = parseBaseArgs(ctx.message.text);
  if (!trackingNumber) {
    await ctx.reply("Usage: /untrack <tracking_number> [carrier_code]");
    return;
  }

  const watch = watchRepo
    .listByUser(ctx.from.id)
    .find((w) => w.trackingNumber.toUpperCase() === trackingNumber.toUpperCase());
  const resolvedCarrier = carrierCode ?? watch?.carrierCode;
  await tryDeleteRemoteTracking(trackingNumber, resolvedCarrier);

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

async function tryDeleteRemoteTracking(trackingNumber: string, carrierCode?: string): Promise<void> {
  if (!carrierCode) {
    return;
  }
  try {
    await trackClient.deleteTracking(trackingNumber, carrierCode);
  } catch (error) {
    logger.warn({ err: error, trackingNumber, carrierCode }, "failed deleting tracking from Track123");
  }
}

async function queryWithCarrierFallback(trackingNumber: string, carrierCode?: string) {
  try {
    return await trackClient.queryTracking(trackingNumber, carrierCode);
  } catch (error) {
    if (!carrierCode) {
      throw error;
    }
    logger.warn({ err: error, trackingNumber, carrierCode }, "carrier query failed, retrying without carrier");
    return trackClient.queryTracking(trackingNumber);
  }
}
