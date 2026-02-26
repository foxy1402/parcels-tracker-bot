import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { TrackingSnapshot, WatchRow } from "../types.js";

test("poller does not overlap cycles under slow query", async () => {
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "test-token";
  process.env.TRACK123_API_SECRET = process.env.TRACK123_API_SECRET ?? "test-secret";
  process.env.ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS ?? "1";
  const { startPoller } = await import("./poll-updates.js");

  const watches: WatchRow[] = [
    {
      userId: 1,
      trackingNumber: "SPXVN064584367312"
    }
  ];

  let inFlight = 0;
  let maxInFlight = 0;
  let stateHash: string | undefined;

  const repo = {
    listAll: () => [{ ...watches[0], lastStatusHash: stateHash }],
    removeWatch: () => 1,
    updateState: (_userId: number, _tracking: string, hash: string) => {
      stateHash = hash;
    }
  };

  const trackClient = {
    queryTracking: async (): Promise<TrackingSnapshot> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(40);
      inFlight -= 1;
      return {
        trackingNumber: "SPXVN064584367312",
        status: "In Transit",
        terminal: false
      };
    }
  };

  let sendCount = 0;
  const bot = {
    telegram: {
      sendMessage: async () => {
        sendCount += 1;
      }
    }
  };

  const poller = startPoller(bot as never, repo as never, trackClient as never, 0.01);
  await sleep(150);
  poller.stop();

  assert.equal(maxInFlight, 1);
  assert.equal(sendCount >= 1, true);
});
