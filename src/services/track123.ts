import { setTimeout as sleep } from "node:timers/promises";
import { request } from "undici";
import { createHash } from "node:crypto";
import { TrackingCheckpoint, TrackingSnapshot } from "../types.js";

type AnyRecord = Record<string, unknown>;

type QueueTask = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const TERMINAL_WORDS = ["delivered", "completed", "done", "signed", "returned"];
const TERMINAL_PHRASES = [
  "returning to sender",
  "returned to sender",
  "giao hang thanh cong",
  "giao hàng thành công",
  "da giao hang",
  "đã giao hàng",
  "tra hang",
  "trả hàng",
  "hoan hang",
  "hoàn hàng"
];
const FINAL_EXCEPTION_PHRASES = [
  "lost",
  "package lost",
  "parcel lost",
  "destroyed",
  "disposed",
  "undeliverable",
  "delivery impossible",
  "cancelled",
  "canceled",
  "shipment cancelled",
  "shipment canceled",
  "cannot be delivered",
  "failed permanently",
  "returned to origin"
];
const NON_TERMINAL_RETRY_HINTS = [
  "reattempt",
  "re-attempt",
  "retry",
  "will attempt",
  "attempt again",
  "second attempt",
  "next delivery attempt",
  "rescheduled"
];

export class Track123Client {
  private readonly queue: Array<QueueTask> = [];
  private readonly minIntervalMs: number;
  private running = 0;
  private nextStartAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly apiSecret: string,
    private readonly maxRps: number,
    private readonly maxConcurrency: number
  ) {
    this.minIntervalMs = Math.max(1, Math.floor(1000 / maxRps));
  }

  async importTracking(trackingNumber: string, carrierCode?: string): Promise<void> {
    await this.enqueue(async () => {
      const payload = [
        {
          trackNo: trackingNumber,
          courierCode: carrierCode
        }
      ];
      await this.postWithRetry("/tk/v2.1/track/import", payload);
    });
  }

  async queryTracking(trackingNumber: string, carrierCode?: string): Promise<TrackingSnapshot> {
    return this.enqueue(async () => {
      const payload: AnyRecord = carrierCode
        ? {
            trackNoInfos: [
              {
                trackNo: trackingNumber,
                courierCode: carrierCode
              }
            ]
          }
        : {
            trackNos: [trackingNumber]
          };
      const raw = await this.postWithRetry("/tk/v2.1/track/query", payload);
      const record = extractQueryRecordOrThrow(raw, trackingNumber);
      return normalizeSnapshot(record, trackingNumber, carrierCode);
    });
  }

  async deleteTracking(trackingNumber: string, carrierCode: string): Promise<void> {
    await this.enqueue(async () => {
      const payload = [
        {
          trackNo: trackingNumber,
          courierCode: carrierCode
        }
      ];
      await this.postWithRetry("/tk/v2.1/track/delete", payload);
    });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: async () => run(),
        resolve: (value) => resolve(value as T),
        reject
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.running >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    if (now < this.nextStartAt) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, this.nextStartAt - now);
      }
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.running += 1;
    this.nextStartAt = Date.now() + this.minIntervalMs;

    task
      .run()
      .then((result) => task.resolve(result))
      .catch((error) => task.reject(error))
      .finally(() => {
        this.running -= 1;
        this.pump();
      });

    this.pump();
  }

  private async postWithRetry(endpoint: string, body: unknown): Promise<unknown> {
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await this.post(endpoint, body);

      if (result.ok) {
        return result.body;
      }

      const retryable = result.statusCode === 429 || result.statusCode >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Track123 request failed (${result.statusCode}): ${result.bodyText}`);
      }

      const retryAfter = Number(result.retryAfterSeconds);
      const backoffSeconds = Number.isFinite(retryAfter)
        ? retryAfter
        : Math.min(8, 2 ** (attempt - 1)) + Math.random();

      await sleep(backoffSeconds * 1000);
    }

    throw new Error("Unexpected retry loop exit");
  }

  private async post(endpoint: string, body: unknown): Promise<{
    ok: boolean;
    statusCode: number;
    body: unknown;
    bodyText: string;
    retryAfterSeconds?: string;
  }> {
    const response = await request(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "parcels-tracker-bot/0.1 (+https://github.com/foxy1402/parcels-tracker-bot)",
        "Track123-Api-Secret": this.apiSecret
      },
      body: JSON.stringify(body)
    });

    const text = await response.body.text();
    let parsed: unknown = text;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    const retryAfterHeader = response.headers["retry-after"];
    const retryAfterSeconds = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const appOk = isTrack123Success(parsed);

    return {
      ok: response.statusCode >= 200 && response.statusCode < 300 && appOk,
      statusCode: response.statusCode,
      body: parsed,
      bodyText: typeof parsed === "string" ? parsed : JSON.stringify(parsed),
      retryAfterSeconds
    };
  }
}

export function snapshotHash(snapshot: TrackingSnapshot): string {
  const value = [
    snapshot.trackingNumber,
    snapshot.carrierCode ?? "",
    snapshot.status,
    snapshot.lastCheckpoint?.time ?? "",
    snapshot.lastCheckpoint?.location ?? "",
    snapshot.lastCheckpoint?.description ?? "",
    snapshot.terminal ? "1" : "0"
  ].join("|");

  return createHash("sha1").update(value).digest("hex");
}

export function normalizeSnapshot(raw: unknown, trackingNumber: string, carrierCode?: string): TrackingSnapshot {
  const record = findParcelRecord(raw, trackingNumber) ?? {};
  const checkpoints = extractCheckpoints(record);
  const lastCheckpoint = checkpoints[0];

  const rawStatus =
    firstString(record, [
      "status",
      "track_status",
      "latest_status",
      "status_description",
      "trackingStatus",
      "transitStatus"
    ]) ?? "unknown";

  const status = lastCheckpoint?.description ?? rawStatus;
  const logistics = asRecord(record.localLogisticsInfo);
  const resolvedCarrier =
    firstString(record, ["carrier_code", "carrierCode", "carrier", "shipping_carrier", "courierCode"]) ??
    firstString(logistics ?? {}, ["courierCode"]) ??
    carrierCode;
  const transitStatus = firstString(record, ["transitStatus"]);
  const transitSubStatus = firstString(record, ["transitSubStatus"]);
  const latestEventSubStatus = firstTrackingDetailSubStatus(record);
  const terminalSignals = [rawStatus, transitStatus, transitSubStatus, latestEventSubStatus, status].filter(
    (v): v is string => Boolean(v)
  );

  return {
    trackingNumber,
    carrierCode: resolvedCarrier,
    status,
    terminal: isTerminal(...terminalSignals),
    lastCheckpoint
  };
}

function findParcelRecord(raw: unknown, trackingNumber: string): AnyRecord | undefined {
  const candidates = collectLikelyParcelRecords(raw);

  const exact = candidates.find((c) => {
    const n = firstString(c, ["tracking_number", "trackingNumber", "number", "track_number", "trackNo"]);
    return n?.toUpperCase() === trackingNumber.toUpperCase();
  });

  if (exact) {
    return exact;
  }

  return candidates.find((candidate) =>
    hasAnyKey(candidate, ["status", "track_status", "latest_status", "status_description", "checkpoints", "events"])
  );
}

function extractCheckpoints(record: AnyRecord): TrackingCheckpoint[] {
  const arrays: unknown[] = [];

  for (const key of ["checkpoints", "events", "tracking_info", "trace", "traces", "origin_info"] as const) {
    const value = record[key];
    if (Array.isArray(value)) {
      arrays.push(value);
    }
  }
  const logistics = asRecord(record.localLogisticsInfo);
  if (logistics && Array.isArray(logistics.trackingDetails)) {
    arrays.push(logistics.trackingDetails);
  }

  const flattened = arrays.flatMap((arr) => arr as unknown[]);
  const mapped = flattened
    .filter((v): v is AnyRecord => typeof v === "object" && v !== null)
    .map((v) => ({
      // Prefer UTC-normalized event time to avoid timezone mis-conversion downstream.
      time: firstString(v, ["eventTimeZeroUTC", "time", "event_time", "checkpoint_time", "date", "created_at", "eventTime"]),
      location: firstString(v, ["location", "city", "country", "place", "address"]),
      description: firstString(v, ["description", "status", "event", "details", "checkpoint_description", "eventDetail"])
    }))
    .filter((v) => v.time || v.location || v.description);

  return mapped.sort((a, b) => `${b.time ?? ""}`.localeCompare(`${a.time ?? ""}`));
}

function isTerminal(...signals: string[]): boolean {
  for (const signal of signals) {
    const normalized = signal.toLowerCase();

    const codeMatches = normalized.match(/\b(\d{3})\b/g) ?? [];
    for (const codeText of codeMatches) {
      const code = Number(codeText);
      if (code >= 300 && code < 400) {
        return true;
      }
    }

    if (TERMINAL_WORDS.some((word) => normalized.includes(word))) {
      return true;
    }
    if (TERMINAL_PHRASES.some((phrase) => normalized.includes(phrase))) {
      return true;
    }
    if (/\b(returning_to_sender|returned_to_sender|delivered|delivery_success)\b/i.test(signal)) {
      return true;
    }
    const hasRetryHint = NON_TERMINAL_RETRY_HINTS.some((hint) => normalized.includes(hint));
    if (!hasRetryHint && FINAL_EXCEPTION_PHRASES.some((phrase) => normalized.includes(phrase))) {
      return true;
    }
    if (!hasRetryHint && /\b(canceled|cancelled|undeliverable|lost|destroyed|disposed)\b/i.test(signal)) {
      return true;
    }
  }
  return false;
}

function firstString(obj: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function hasAnyKey(obj: AnyRecord, keys: string[]): boolean {
  return keys.some((key) => key in obj);
}

function collectLikelyParcelRecords(root: unknown): AnyRecord[] {
  const roots: unknown[] = [root];
  const top = asRecord(root);
  if (top) {
    for (const key of ["data", "result", "results", "items", "list", "trackings", "packages"]) {
      const nested = top[key];
      if (nested) {
        roots.push(nested);
      }
    }
  }

  const records: AnyRecord[] = [];
  for (const node of roots) {
    walk(node, (obj) => {
      if (hasAnyKey(obj, ["tracking_number", "trackingNumber", "number", "track_number", "trackNo"])) {
        records.push(obj);
        return;
      }
      if (hasAnyKey(obj, ["status", "track_status", "latest_status", "status_description", "checkpoints", "events"])) {
        records.push(obj);
      }
    });
  }

  return dedupeRecords(records);
}

function walk(value: unknown, cb: (obj: AnyRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, cb);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  cb(record);
  for (const nested of Object.values(record)) {
    walk(nested, cb);
  }
}

function dedupeRecords(records: AnyRecord[]): AnyRecord[] {
  const seen = new Set<string>();
  const deduped: AnyRecord[] = [];
  for (const record of records) {
    const signature = JSON.stringify(record);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(record);
  }
  return deduped;
}

function asRecord(value: unknown): AnyRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as AnyRecord;
}

function firstTrackingDetailSubStatus(record: AnyRecord): string | undefined {
  const logistics = asRecord(record.localLogisticsInfo);
  if (!logistics || !Array.isArray(logistics.trackingDetails) || logistics.trackingDetails.length === 0) {
    return undefined;
  }
  const first = asRecord(logistics.trackingDetails[0]);
  return firstString(first ?? {}, ["transitSubStatus"]);
}

function extractQueryRecordOrThrow(raw: unknown, trackingNumber: string): AnyRecord {
  const body = asRecord(raw);
  const data = asRecord(body?.data);
  const accepted = asRecord(data?.accepted);
  const content = Array.isArray(accepted?.content) ? accepted.content : [];

  const exact = content
    .map((item) => asRecord(item))
    .filter((item): item is AnyRecord => Boolean(item))
    .find((item) => firstString(item, ["trackNo", "tracking_number", "trackingNumber"])?.toUpperCase() === trackingNumber.toUpperCase());

  if (exact) {
    return exact;
  }

  const first = content.map((item) => asRecord(item)).find((item): item is AnyRecord => Boolean(item));
  if (first) {
    return first;
  }

  const rejected = Array.isArray(data?.rejected) ? data.rejected : [];
  if (rejected.length > 0) {
    const firstRejected = asRecord(rejected[0]);
    const err = asRecord(firstRejected?.error);
    const errCode = firstString(err ?? {}, ["code"]) ?? "UNKNOWN";
    const errMsg = firstString(err ?? {}, ["msg", "message"]) ?? "query rejected";
    throw new Error(`Track123 query rejected (${errCode}): ${errMsg}`);
  }

  throw new Error("Track123 query returned no accepted records");
}

function isTrack123Success(value: unknown): boolean {
  const body = asRecord(value);
  if (!body) {
    return true;
  }

  const code = body.code;
  if (typeof code === "string") {
    return code === "00000";
  }

  const msg = body.msg;
  if (typeof msg === "string" && msg.trim()) {
    const normalized = msg.trim().toLowerCase();
    return normalized === "success";
  }

  const message = body.message;
  if (typeof message === "string" && message.trim()) {
    // Track123 non-success bodies can return only `message` with 2xx/4xx.
    return false;
  }

  return true;
}
