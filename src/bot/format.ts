import { TrackingSnapshot } from "../types.js";

type FormatOptions = {
  label?: string;
  timezone?: string;
};

export function formatSnapshot(snapshot: TrackingSnapshot, options?: FormatOptions): string {
  const humanStatus = humanizeStatus(snapshot.status);
  const lines = [
    `Tracking: ${snapshot.trackingNumber}`,
    `Carrier: ${snapshot.carrierCode ?? "auto-detect/unknown"}`,
    `Status: ${humanStatus}`
  ];

  if (options?.label) {
    lines.splice(1, 0, `Label: ${options.label}`);
  }

  if (snapshot.lastCheckpoint) {
    lines.push("Last checkpoint:");
    lines.push(`- Time: ${formatCheckpointTime(snapshot.lastCheckpoint.time, options?.timezone)}`);
    if (snapshot.lastCheckpoint.location) {
      lines.push(`- Location: ${snapshot.lastCheckpoint.location}`);
    }
    const details = snapshot.lastCheckpoint.description?.trim();
    if (details && details !== snapshot.status.trim()) {
      lines.push(`- Details: ${details}`);
    }
  }

  if (snapshot.terminal) {
    lines.push("Terminal shipment state detected. This tracking will be auto-removed.");
  }

  return lines.join("\n");
}

export function humanizeStatus(status: string): string {
  const value = status.trim();
  const upper = value.toUpperCase();

  if (!value) {
    return "Unknown";
  }

  const transitMap: Record<string, string> = {
    INIT: "Shipment information received",
    PICKUP: "Picked up by carrier",
    TRANSIT: "In transit",
    DELIVERING: "Out for delivery",
    DELIVERED: "Delivered",
    EXCEPTION: "Delivery exception",
    RETURNED: "Returned to sender"
  };

  if (transitMap[upper]) {
    return transitMap[upper];
  }

  if (/^\d{3}$/.test(upper)) {
    const code = Number(upper);
    const exactMap: Record<string, string> = {
      "001": "Shipment information received",
      "101": "In transit",
      "201": "Out for delivery",
      "301": "Delivered",
      "401": "Delivery exception",
      "501": "Returned to sender"
    };

    if (exactMap[upper]) {
      return `${exactMap[upper]} (${upper})`;
    }

    if (code >= 100 && code < 200) {
      return `In transit (${upper})`;
    }
    if (code >= 200 && code < 300) {
      return `Out for delivery (${upper})`;
    }
    if (code >= 300 && code < 400) {
      return `Delivered (${upper})`;
    }
    if (code >= 400 && code < 500) {
      return `Delivery exception (${upper})`;
    }
    if (code >= 500 && code < 600) {
      return `Returned/cancelled (${upper})`;
    }

    return `Shipment status (${upper})`;
  }

  return value;
}

function formatCheckpointTime(time: string | undefined, timezone: string | undefined): string {
  if (!time) {
    return "n/a";
  }

  const date = parseUtcLikeTime(time);
  if (!date) {
    return time;
  }

  const targetTz = timezone?.trim() || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: targetTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  } catch {
    return time;
  }
}

function parseUtcLikeTime(value: string): Date | undefined {
  // ISO strings with offset/Z are parsed directly.
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime()) && (value.includes("T") || value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value))) {
    return direct;
  }

  // `YYYY-MM-DD HH:mm:ss` is treated as UTC input.
  const plainUtc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  if (plainUtc) {
    const asUtc = new Date(`${plainUtc[1]}T${plainUtc[2]}Z`);
    if (!Number.isNaN(asUtc.getTime())) {
      return asUtc;
    }
  }

  return undefined;
}
