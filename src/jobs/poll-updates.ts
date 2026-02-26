import { Telegraf } from "telegraf";
import { logger } from "../logger.js";
import { Track123Client, snapshotHash } from "../services/track123.js";
import { WatchRepository } from "../store/watch-repository.js";
import { formatSnapshot } from "../bot/format.js";
import { config } from "../config.js";

export type PollerHandle = {
  stop: () => void;
};

export function startPoller(
  bot: Telegraf,
  repo: WatchRepository,
  trackClient: Track123Client,
  intervalSeconds: number
): PollerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void runCycle();
    }, intervalSeconds * 1000);
  };

  const runCycle = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    const watches = repo.listAll();
    if (watches.length === 0) {
      schedule();
      return;
    }

    logger.info({ count: watches.length }, "running poll cycle");

    for (const watch of watches) {
      try {
        const snapshot = await queryWithCarrierFallback(trackClient, watch.trackingNumber, watch.carrierCode);
        const hash = snapshotHash(snapshot);

        if (watch.lastStatusHash === hash) {
          continue;
        }

        const title = watch.label ? `Update for ${watch.label} (${watch.trackingNumber})` : `Update for ${watch.trackingNumber}`;
        await bot.telegram.sendMessage(
          watch.userId,
          `${title}:\n\n${formatSnapshot(snapshot, { label: watch.label, timezone: config.timezone })}`
        );

        if (snapshot.terminal) {
          const deleteCarrier = snapshot.carrierCode ?? watch.carrierCode;
          if (deleteCarrier) {
            try {
              await trackClient.deleteTracking(watch.trackingNumber, deleteCarrier);
            } catch (error) {
              logger.warn(
                { err: error, trackingNumber: watch.trackingNumber, userId: watch.userId },
                "failed to delete terminal tracking from Track123"
              );
            }
          }
          repo.removeWatch(watch.userId, watch.trackingNumber);
          logger.info({ trackingNumber: watch.trackingNumber, userId: watch.userId }, "removed delivered watch");
          continue;
        }

        repo.updateState(watch.userId, watch.trackingNumber, hash, snapshot.carrierCode);
      } catch (error) {
        logger.warn({ err: error, trackingNumber: watch.trackingNumber, userId: watch.userId }, "poll update failed");
      }
    }

    schedule();
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}

async function queryWithCarrierFallback(trackClient: Track123Client, trackingNumber: string, carrierCode?: string) {
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
