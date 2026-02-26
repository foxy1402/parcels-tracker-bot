import { copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { WatchRow } from "../types.js";

type StoreFile = {
  watches: WatchRow[];
};

export class WatchRepository {
  private readonly filePath: string;

  constructor(filePath: string = config.dbPath) {
    this.filePath = this.resolveWritablePath(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!this.exists()) {
      this.writeStore({ watches: [] });
    }
  }

  upsertWatch(userId: number, trackingNumber: string, carrierCode?: string, label?: string): void {
    const store = this.readStore();
    const normalized = trackingNumber.toUpperCase();
    const existing = store.watches.find((w) => w.userId === userId && w.trackingNumber.toUpperCase() === normalized);

    if (existing) {
      existing.carrierCode = carrierCode ?? existing.carrierCode;
      existing.label = label ?? existing.label;
      this.writeStore(store);
      return;
    }

    store.watches.unshift({
      userId,
      trackingNumber,
      carrierCode,
      label
    });
    this.writeStore(store);
  }

  listByUser(userId: number): WatchRow[] {
    return this.readStore().watches.filter((w) => w.userId === userId);
  }

  listAll(): WatchRow[] {
    return this.readStore().watches;
  }

  removeWatch(userId: number, trackingNumber: string): number {
    const store = this.readStore();
    const normalized = trackingNumber.toUpperCase();
    const before = store.watches.length;
    store.watches = store.watches.filter((w) => !(w.userId === userId && w.trackingNumber.toUpperCase() === normalized));
    this.writeStore(store);
    return before - store.watches.length;
  }

  updateState(userId: number, trackingNumber: string, lastStatusHash: string, carrierCode?: string): void {
    const store = this.readStore();
    const normalized = trackingNumber.toUpperCase();
    const watch = store.watches.find((w) => w.userId === userId && w.trackingNumber.toUpperCase() === normalized);
    if (!watch) {
      return;
    }

    watch.lastStatusHash = lastStatusHash;
    watch.carrierCode = carrierCode ?? watch.carrierCode;
    this.writeStore(store);
  }

  private exists(): boolean {
    try {
      readFileSync(this.filePath, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  private readStore(): StoreFile {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || !Array.isArray(parsed.watches)) {
        logger.warn({ filePath: this.filePath }, "watch store schema invalid, resetting");
        this.backupCorruptFile();
        return { watches: [] };
      }
      return parsed;
    } catch (error) {
      logger.warn({ err: error, filePath: this.filePath }, "watch store unreadable, resetting");
      this.backupCorruptFile();
      return { watches: [] };
    }
  }

  private writeStore(data: StoreFile): void {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }

  private resolveWritablePath(targetPath: string): string {
    if (this.canWriteTo(targetPath)) {
      return targetPath;
    }

    const fallbackPath = "/tmp/bot.db";
    if (this.canWriteTo(fallbackPath)) {
      logger.warn(
        { requestedPath: targetPath, fallbackPath },
        "configured DB_PATH is not writable; falling back to /tmp (non-persistent)"
      );
      return fallbackPath;
    }

    throw new Error(`DB_PATH is not writable and fallback failed: requested=${targetPath}, fallback=${fallbackPath}`);
  }

  private canWriteTo(targetPath: string): boolean {
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      const probe = `${targetPath}.probe-${process.pid}-${Date.now()}`;
      writeFileSync(probe, "ok", "utf8");
      unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  private backupCorruptFile(): void {
    try {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      copyFileSync(this.filePath, backupPath);
      logger.warn({ backupPath }, "backed up corrupt watch store");
    } catch {
      // No existing file or backup failure; continue with empty store fallback.
    }
  }
}
