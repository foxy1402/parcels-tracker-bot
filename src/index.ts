import { Telegraf, Markup } from "telegraf";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { WatchRow } from "./types.js";
import { TrackingSnapshot } from "./types.js";
import { WatchRepository } from "./store/watch-repository.js";
import { Track123Client, snapshotHash } from "./services/track123.js";
import { formatSnapshot } from "./bot/format.js";
import { startPoller } from "./jobs/poll-updates.js";
import { parseBaseArgs, parseTrackArgs } from "./bot/command-args.js";
import { applySyncBatch, buildSyncWindow } from "./bot/sync.js";
import { QUICK_CARRIERS } from "./bot/carriers.js";

const watchRepo = new WatchRepository();
const trackClient = new Track123Client(
  config.track123BaseUrl,
  config.track123ApiSecret,
  config.track123MaxRps,
  config.track123MaxConcurrency
);

const bot = new Telegraf(config.telegramBotToken);

// ─── Pending "type a carrier code" state ─────────────────────────────────────
// Stored in memory; cleared on bot restart (acceptable — it's transient UI state).

type PendingCarrierEdit = {
  trackingNumber: string;
  chatId: number;
  /** Message ID of the interactive prompt so we can delete it on completion. */
  promptMessageId: number;
};

const pendingCarrierEdits = new Map<number, PendingCarrierEdit>();

// ─── Auth middleware ──────────────────────────────────────────────────────────

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

// ─── Custom carrier-code text interceptor ─────────────────────────────────────
// Must be registered BEFORE command handlers so it can intercept plain text
// that would otherwise fall through unhandled.

bot.use(async (ctx, next) => {
  const msg = ctx.message;
  if (!msg || !("text" in msg)) return next();

  const userId = ctx.from!.id;

  if (msg.text.startsWith("/")) {
    // Slash command — clear stale pending state so a future plain message
    // from the same user is never misread as a carrier code.
    pendingCarrierEdits.delete(userId);
    return next();
  }

  const pending = pendingCarrierEdits.get(userId);
  if (!pending || ctx.chat?.id !== pending.chatId) return next();

  // ── User has sent a carrier code ──────────────────────────────────────────
  pendingCarrierEdits.delete(userId);

  const carrierCode = msg.text.trim().toLowerCase();

  // Delete the "enter carrier code" prompt (the interactive message).
  try {
    await bot.telegram.deleteMessage(pending.chatId, pending.promptMessageId);
  } catch { /* already gone */ }

  const watch = findWatch(userId, pending.trackingNumber);
  const result = await doCarrierChange(userId, pending.trackingNumber, carrierCode);

  if (result.success) {
    const header = `Carrier updated to: ${result.resolvedCarrier ?? carrierCode}\n\n`;
    await ctx.reply(
      header + formatSnapshot(result.snapshot, { label: watch?.label, timezone: config.timezone })
    );
  } else if (result.reason === "not_found") {
    await ctx.reply(
      "Parcel not found — it may have been removed. Use /list to see your current parcels."
    );
  } else {
    await ctx.reply(
      `Could not update carrier to "${carrierCode}".\n` +
        "Check that the code is a valid Track123 carrier code and try again via ✏️ Edit Carrier."
    );
  }

  // Swallow this update — don't let command handlers see it.
});

// ─── Callback-data builders (Telegram limit: 64 bytes per payload) ────────────

const CB_LIST = "ls";
const cbDetail    = (tn: string) => `d|${tn}`;
const cbRefresh   = (tn: string) => `rf|${tn}`;
const cbEditCarr  = (tn: string) => `ec|${tn}`;
const cbSetCarr   = (tn: string, cc: string) => `sc|${tn}|${cc}`;
const cbAutoCarr  = (tn: string) => `sa|${tn}`;
const cbOtherCarr = (tn: string) => `oc|${tn}`;
const cbCancelEdit = (tn: string) => `cec|${tn}`;
const cbRmPrompt  = (tn: string) => `rm|${tn}`;
const cbRmConfirm = (tn: string) => `rmc|${tn}`;

// ─── Message text builders ────────────────────────────────────────────────────

function listText(count: number): string {
  return `Your tracked parcels (${count}):\n\nTap a parcel to manage it.`;
}

function detailText(w: WatchRow): string {
  const lines = [`Tracking: ${w.trackingNumber}`];
  if (w.label) lines.push(`Label: ${w.label}`);
  lines.push(`Carrier: ${w.carrierCode ?? "auto-detect/unknown"}`);
  lines.push("", "Tap Refresh to see the latest status.");
  return lines.join("\n");
}

// ─── Inline keyboard builders ─────────────────────────────────────────────────

function listMarkup(watches: WatchRow[]) {
  const rows = watches.map((w) => {
    const name = w.label ?? w.trackingNumber;
    const carrier = w.carrierCode ? ` · ${w.carrierCode}` : "";
    const label = `📦 ${name}${carrier}`.slice(0, 40);
    return [Markup.button.callback(label, cbDetail(w.trackingNumber))];
  });
  return Markup.inlineKeyboard(rows);
}

function detailMarkup(tn: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh Status", cbRefresh(tn))],
    [
      Markup.button.callback("✏️ Edit Carrier", cbEditCarr(tn)),
      Markup.button.callback("🗑️ Remove", cbRmPrompt(tn)),
    ],
    [Markup.button.callback("◀ Back to List", CB_LIST)],
  ]);
}

/** Split an array into successive chunks of at most `size` elements. */
function chunk<T>(arr: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Carrier picker keyboard.
 * Buttons are generated directly from QUICK_CARRIERS in src/bot/carriers.ts —
 * that file is the single source of truth. To add, remove, or reorder carriers
 * just edit carriers.ts; no changes needed here.
 */
function carrierMarkup(tn: string) {
  const carrierRows = chunk(QUICK_CARRIERS, 2).map((pair) =>
    pair.map((c) => Markup.button.callback(c.label, cbSetCarr(tn, c.code)))
  );

  return Markup.inlineKeyboard([
    ...carrierRows,
    [Markup.button.callback("📝 Other carrier…", cbOtherCarr(tn))],
    [Markup.button.callback("🔍 Auto-detect",     cbAutoCarr(tn))],
    [Markup.button.callback("◀ Back",            cbDetail(tn))],
  ]);
}

function removeMarkup(tn: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Yes, remove", cbRmConfirm(tn)),
      Markup.button.callback("❌ Cancel",       cbDetail(tn)),
    ],
  ]);
}

// ─── Core logic helpers ───────────────────────────────────────────────────────

function findWatch(userId: number, trackingNumber: string): WatchRow | undefined {
  return watchRepo
    .listByUser(userId)
    .find((w) => w.trackingNumber.toUpperCase() === trackingNumber.toUpperCase());
}

type CarrierChangeResult =
  | { success: true; snapshot: TrackingSnapshot; resolvedCarrier: string | undefined }
  | { success: false; reason: "not_found" | "api_error" };

/**
 * Pure carrier-change business logic — no Telegram UI concerns.
 *
 * Strategy depends on what we know about the current state:
 *
 *  A. New carrier is specific AND old carrier is known
 *     → use `update-courier` (atomic, preserves Track123 history, no race).
 *       Falls back to delete + import if the endpoint rejects (e.g. entry not
 *       found on Track123's side after a sync gap).
 *
 *  B. New carrier is specific AND no old carrier known
 *     → import fresh (nothing to update in-place).
 *
 *  C. New carrier is undefined (switch to auto-detect)
 *     → delete existing entry and re-import without a courierCode so Track123
 *       re-detects from scratch.
 *
 * Requires the watch to already exist; returns { reason: "not_found" } for
 * stale inline-keyboard presses on parcels that have since been removed.
 */
async function doCarrierChange(
  userId: number,
  tn: string,
  cc: string | undefined
): Promise<CarrierChangeResult> {
  const watch = findWatch(userId, tn);
  if (!watch) {
    logger.warn({ userId, trackingNumber: tn }, "carrier change requested for non-existent watch");
    return { success: false, reason: "not_found" };
  }

  const oldCarrier = watch.carrierCode;

  try {
    if (cc !== undefined) {
      if (oldCarrier) {
        // Case A: atomic update — preserves history, takes effect immediately.
        try {
          await trackClient.updateCourier(tn, oldCarrier, cc);
        } catch (updateErr) {
          // Fallback: entry may not exist on Track123 (e.g. after a /sync gap).
          logger.warn(
            { err: updateErr, trackingNumber: tn, oldCarrier, newCarrier: cc },
            "update-courier failed, falling back to delete + import"
          );
          await tryDeleteRemoteTracking(tn, oldCarrier);
          try {
            await trackClient.importTracking(tn, cc);
          } catch (importErr) {
            logger.warn({ err: importErr, trackingNumber: tn, carrierCode: cc }, "fallback import also failed, continuing to query");
          }
        }
      } else {
        // Case B: no existing entry to update — import fresh.
        try {
          await trackClient.importTracking(tn, cc);
        } catch (err) {
          logger.warn({ err, trackingNumber: tn, carrierCode: cc }, "import failed, continuing to query");
        }
      }
    } else {
      // Case C: auto-detect — wipe existing entry and let Track123 re-detect.
      await tryDeleteRemoteTracking(tn, oldCarrier);
      try {
        await trackClient.importTracking(tn, undefined);
      } catch (err) {
        logger.warn({ err, trackingNumber: tn }, "re-import for auto-detect failed, continuing to query");
      }
    }

    const snapshot = await queryWithCarrierFallback(tn, cc);
    const resolvedCarrier = snapshot.carrierCode ?? cc;

    watchRepo.upsertWatch(userId, tn, resolvedCarrier, watch.label);
    watchRepo.updateState(userId, tn, snapshotHash(snapshot), resolvedCarrier);

    return { success: true, snapshot, resolvedCarrier };
  } catch (error) {
    logger.error({ err: error, trackingNumber: tn, carrierCode: cc }, "carrier change failed");
    return { success: false, reason: "api_error" };
  }
}

/**
 * Applies a carrier change triggered from an inline-keyboard action.
 * On success: deletes the interactive message, sends a clean status card.
 * On failure: edits the message back to the detail view with an error note.
 */
async function applyCarrierChange(
  ctx: {
    from: { id: number };
    deleteMessage: () => Promise<unknown>;
    editMessageText: (text: string, extra?: object) => Promise<unknown>;
    reply: (text: string) => Promise<unknown>;
  },
  tn: string,
  cc: string | undefined
): Promise<void> {
  const watch = findWatch(ctx.from.id, tn);
  const result = await doCarrierChange(ctx.from.id, tn, cc);

  if (result.success) {
    const carrierLabel = cc
      ? (QUICK_CARRIERS.find((c) => c.code === cc)?.label ?? cc)
      : `${result.resolvedCarrier ?? "auto-detect"} (auto-detected)`;

    await ctx.deleteMessage();
    await ctx.reply(
      `Carrier updated to: ${carrierLabel}\n\n` +
        formatSnapshot(result.snapshot, { label: watch?.label, timezone: config.timezone })
    );
  } else if (result.reason === "not_found") {
    await ctx.editMessageText(
      "Parcel not found — it may have already been removed.\n\nUse /list to see your current parcels."
    );
  } else {
    const current = findWatch(ctx.from.id, tn) ?? watch ?? { userId: ctx.from.id, trackingNumber: tn };
    await ctx.editMessageText(
      `Failed to update carrier. Please try again.\n\n${detailText(current)}`,
      detailMarkup(tn)
    );
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  await ctx.reply(
    [
      "Parcel Tracker Bot",
      "",
      "Commands:",
      "/track <tracking_number> [carrier:code] [label]",
      "/status [tracking_number] [carrier_code]",
      "/list  — interactive parcel manager",
      "/sync",
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
  await ctx.reply(listText(watches.length), listMarkup(watches));
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

// ─── Interactive action handlers ──────────────────────────────────────────────

/** Navigate back to the parcel list (replaces current message in-place). */
bot.action(CB_LIST, async (ctx) => {
  await ctx.answerCbQuery();
  const watches = watchRepo.listByUser(ctx.from.id);
  if (watches.length === 0) {
    await ctx.editMessageText("No active tracked parcels.");
    return;
  }
  await ctx.editMessageText(listText(watches.length), listMarkup(watches));
});

/** Show detail view for a single parcel. */
bot.action(/^d\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tn = ctx.match[1];
  const watch = findWatch(ctx.from.id, tn);
  if (!watch) {
    await ctx.editMessageText("Parcel not found — it may have already been removed.");
    return;
  }
  await ctx.editMessageText(detailText(watch), detailMarkup(tn));
});

/** Refresh live status for the selected parcel (edits message in-place). */
bot.action(/^rf\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Refreshing…");
  const tn = ctx.match[1];
  const watch = findWatch(ctx.from.id, tn);

  try {
    const snapshot = await queryWithCarrierFallback(tn, watch?.carrierCode);

    if (snapshot.terminal) {
      await tryDeleteRemoteTracking(tn, snapshot.carrierCode ?? watch?.carrierCode);
      watchRepo.removeWatch(ctx.from.id, tn);
      await ctx.editMessageText(
        formatSnapshot(snapshot, { label: watch?.label, timezone: config.timezone }) +
          "\n\nThis parcel reached its final state and has been removed from your list."
      );
      return;
    }

    if (watch) {
      watchRepo.updateState(ctx.from.id, tn, snapshotHash(snapshot), snapshot.carrierCode);
    }

    await ctx.editMessageText(
      formatSnapshot(snapshot, { label: watch?.label, timezone: config.timezone }),
      detailMarkup(tn)
    );
  } catch (error) {
    logger.error({ err: error, trackingNumber: tn }, "refresh action failed");
    await ctx.editMessageText(`Unable to fetch status for ${tn}. Try again later.`, detailMarkup(tn));
  }
});

/** Show the carrier picker for the selected parcel. */
bot.action(/^ec\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tn = ctx.match[1];
  const watch = findWatch(ctx.from.id, tn);
  const currentLine = watch?.carrierCode ? `Current carrier: ${watch.carrierCode}\n\n` : "";
  await ctx.editMessageText(`${currentLine}Select new carrier for:\n${tn}`, carrierMarkup(tn));
});

/** Apply a specific carrier selection from the quick-pick buttons. */
bot.action(/^sc\|([^|]+)\|(.+)$/, async (ctx) => {
  const tn = ctx.match[1];
  const cc = ctx.match[2];
  await ctx.answerCbQuery("Updating carrier…");
  await applyCarrierChange(ctx, tn, cc);
});

/** Apply auto-detect (clear manual carrier). */
bot.action(/^sa\|(.+)$/, async (ctx) => {
  const tn = ctx.match[1];
  await ctx.answerCbQuery("Switching to auto-detect…");
  await applyCarrierChange(ctx, tn, undefined);
});

/**
 * "Other carrier…" — edits the message to a prompt asking the user to type
 * any Track123 carrier code. Registers a pending edit so the next plain-text
 * message from this user is treated as the code input.
 */
bot.action(/^oc\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tn = ctx.match[1];

  // The message ID is already known from the callback context — it's the
  // message that owns this button. editMessageText edits it in-place, so the
  // ID never changes. Using this is more reliable than parsing the return value
  // of editMessageText, which can be boolean true on some Telegram servers.
  const promptMessageId = ctx.callbackQuery.message?.message_id;
  const chatId = ctx.chat?.id;

  if (!promptMessageId || !chatId) {
    await ctx.answerCbQuery("Unable to open the input prompt. Try again.");
    return;
  }

  const promptText = [
    `Type the Track123 carrier code for:`,
    tn,
    "",
    "Send it as a message — any code Track123 supports works.",
    "Examples: dpdpoland, tnt, yamato, postnl, correos",
  ].join("\n");

  await ctx.editMessageText(
    promptText,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", cbCancelEdit(tn))]])
  );

  pendingCarrierEdits.set(ctx.from.id, { trackingNumber: tn, chatId, promptMessageId });
});

/** Cancel the "type a carrier code" prompt and go back to the carrier picker. */
bot.action(/^cec\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tn = ctx.match[1];
  pendingCarrierEdits.delete(ctx.from.id);
  const watch = findWatch(ctx.from.id, tn);
  const currentLine = watch?.carrierCode ? `Current carrier: ${watch.carrierCode}\n\n` : "";
  await ctx.editMessageText(`${currentLine}Select new carrier for:\n${tn}`, carrierMarkup(tn));
});

/** Show remove confirmation prompt. */
bot.action(/^rm\|(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const tn = ctx.match[1];
  const watch = findWatch(ctx.from.id, tn);
  const labelInfo = watch?.label ? ` "${watch.label}"` : "";
  await ctx.editMessageText(
    `Remove ${tn}${labelInfo} from your watch list?\n\nThis cannot be undone.`,
    removeMarkup(tn)
  );
});

/** Execute remove after user confirmation. */
bot.action(/^rmc\|(.+)$/, async (ctx) => {
  const tn = ctx.match[1];
  await ctx.answerCbQuery("Removing…");
  const watch = findWatch(ctx.from.id, tn);
  await tryDeleteRemoteTracking(tn, watch?.carrierCode);
  const removed = watchRepo.removeWatch(ctx.from.id, tn);
  await ctx.deleteMessage();
  if (removed === 0) {
    await ctx.reply("Parcel was not found in your watch list.");
  } else {
    const labelInfo = watch?.label ? ` "${watch.label}"` : "";
    await ctx.reply(`Removed ${tn}${labelInfo} from your watch list.`);
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((error, ctx) => {
  logger.error({ err: error, update: ctx.update }, "telegram update error");
});

// ─── Startup / shutdown ───────────────────────────────────────────────────────

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

// ─── Private helpers ──────────────────────────────────────────────────────────

async function tryDeleteRemoteTracking(trackingNumber: string, carrierCode?: string): Promise<void> {
  if (!carrierCode) return;
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
    if (!carrierCode) throw error;
    logger.warn({ err: error, trackingNumber, carrierCode }, "carrier query failed, retrying without carrier");
    return trackClient.queryTracking(trackingNumber);
  }
}
