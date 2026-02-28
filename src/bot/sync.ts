import { TrackingSnapshot } from "../types.js";

export type SyncWindow = {
  createTimeStart: string;
  createTimeEnd: string;
};

export type SyncBatchStats = {
  synced: number;
  added: number;
  skippedTerminal: number;
  activeItems: TrackingSnapshot[];
};

export function buildSyncWindow(now: Date, lookbackDays: number): SyncWindow {
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return {
    createTimeStart: toTrack123Time(start),
    createTimeEnd: toTrack123Time(now)
  };
}

export function applySyncBatch(existing: Set<string>, snapshots: TrackingSnapshot[]): SyncBatchStats {
  let synced = 0;
  let added = 0;
  let skippedTerminal = 0;
  const activeItems: TrackingSnapshot[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.terminal) {
      skippedTerminal += 1;
      continue;
    }

    const key = snapshot.trackingNumber.toUpperCase();
    if (!existing.has(key)) {
      existing.add(key);
      added += 1;
    }

    synced += 1;
    activeItems.push(snapshot);
  }

  return { synced, added, skippedTerminal, activeItems };
}

export function toTrack123Time(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}
