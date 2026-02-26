import { TrackingSnapshot } from "../types.js";

type FormatOptions = {
  label?: string;
};

export function formatSnapshot(snapshot: TrackingSnapshot, options?: FormatOptions): string {
  const lines = [
    `Tracking: ${snapshot.trackingNumber}`,
    `Carrier: ${snapshot.carrierCode ?? "auto-detect/unknown"}`,
    `Status: ${snapshot.status}`
  ];

  if (options?.label) {
    lines.splice(1, 0, `Label: ${options.label}`);
  }

  if (snapshot.lastCheckpoint) {
    lines.push("Last checkpoint:");
    lines.push(`- Time: ${snapshot.lastCheckpoint.time ?? "n/a"}`);
    lines.push(`- Location: ${snapshot.lastCheckpoint.location ?? "n/a"}`);
    lines.push(`- Details: ${snapshot.lastCheckpoint.description ?? "n/a"}`);
  }

  if (snapshot.terminal) {
    lines.push("Terminal shipment state detected. This tracking will be auto-removed.");
  }

  return lines.join("\n");
}
