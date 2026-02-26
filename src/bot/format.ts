import { TrackingSnapshot } from "../types.js";

type FormatOptions = {
  label?: string;
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
    lines.push(`- Time: ${snapshot.lastCheckpoint.time ?? "n/a"}`);
    lines.push(`- Location: ${snapshot.lastCheckpoint.location ?? "n/a"}`);
    lines.push(`- Details: ${snapshot.lastCheckpoint.description ?? "n/a"}`);
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
