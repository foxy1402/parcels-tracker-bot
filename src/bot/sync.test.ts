import test from "node:test";
import assert from "node:assert/strict";
import { applySyncBatch, buildSyncWindow } from "./sync.js";

test("buildSyncWindow uses UTC formatted Track123 time", () => {
  const now = new Date("2026-02-28T12:00:00Z");
  const window = buildSyncWindow(now, 30);
  assert.equal(window.createTimeEnd, "2026-02-28 12:00:00");
  assert.equal(window.createTimeStart, "2026-01-29 12:00:00");
});

test("applySyncBatch counts added/synced/skipped-terminal", () => {
  const existing = new Set<string>(["EXIST123"]);
  const batch = applySyncBatch(existing, [
    { trackingNumber: "EXIST123", status: "In transit", terminal: false },
    { trackingNumber: "NEW123", status: "In transit", terminal: false },
    { trackingNumber: "DONE123", status: "Delivered", terminal: true }
  ]);

  assert.equal(batch.synced, 2);
  assert.equal(batch.added, 1);
  assert.equal(batch.skippedTerminal, 1);
  assert.equal(batch.activeItems.length, 2);
  assert.equal(existing.has("NEW123"), true);
});
