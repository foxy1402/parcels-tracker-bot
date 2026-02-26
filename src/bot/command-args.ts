export function parseBaseArgs(text: string): [string | undefined, string | undefined] {
  const parts = text.trim().split(/\s+/).slice(1);
  const trackingNumber = parts[0]?.trim();
  const carrierCode = parts[1]?.trim();
  return [trackingNumber, carrierCode];
}

export function parseTrackArgs(text: string): {
  trackingNumber?: string;
  carrierCode?: string;
  label?: string;
} {
  const parts = text.trim().split(/\s+/).slice(1);
  const trackingNumber = parts[0]?.trim();
  const args = parts.slice(1);

  if (!trackingNumber) {
    return {};
  }

  if (args.length === 0) {
    return { trackingNumber };
  }

  const first = args[0] ?? "";
  const prefixedCarrier = parseCarrierPrefix(first);
  if (prefixedCarrier) {
    return {
      trackingNumber,
      carrierCode: prefixedCarrier,
      label: args.slice(1).join(" ").trim() || undefined
    };
  }

  // Backward compatibility: if there are more args, treat first token as carrier-looking code.
  if (args.length > 1 && looksLikeCarrierCode(first)) {
    return {
      trackingNumber,
      carrierCode: first,
      label: args.slice(1).join(" ").trim() || undefined
    };
  }

  // Default single token to label to avoid accidental carrier misclassification.
  return {
    trackingNumber,
    label: args.join(" ").trim() || undefined
  };
}

function parseCarrierPrefix(value: string): string | undefined {
  const match = /^(?:c|carrier):(.+)$/i.exec(value);
  if (!match) {
    return undefined;
  }
  const carrier = match[1]?.trim();
  return carrier || undefined;
}

function looksLikeCarrierCode(value: string): boolean {
  return /^(?=.*[A-Z])[A-Z0-9_-]{2,20}$/.test(value);
}
