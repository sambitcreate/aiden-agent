/**
 * Adapted from t3code apps/web/src/components/device/deviceHubApi.ts @ a6ec88f7 (MIT)
 *
 * serve-sim's iOS event log: touches, keys, buttons, and app launches the hub
 * saw, seeded with recent history and then pushed live over Server-Sent
 * Events at `/vendor/serve-sim/api/event-log/events?device=<udid>`. T3 uses
 * EventSource; Aiden reads the stream with `fetch` through main's token proxy,
 * like the frontmost-app feed. The buffer is bounded so a long session never
 * grows the drawer without limit.
 */
import type { DeviceStreamGrant } from "../shared/devices";
import { createSseParser } from "./device-foreground";
import { deviceHubUrl } from "./device-stream";

export interface DeviceEventLogEntry {
  id: number;
  timestamp: string;
  kind: string;
  summary: string;
}

/** Entries kept in the drawer; serve-sim itself keeps 500 per hub. */
export const DEVICE_EVENT_LOG_LIMIT = 500;
/** History requested when the panel opens. */
export const DEVICE_EVENT_LOG_SEED = 100;
const MAX_TEXT = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value.slice(0, MAX_TEXT) : "");

function toEntry(raw: unknown): DeviceEventLogEntry | null {
  if (!isRecord(raw) || typeof raw.id !== "number" || !Number.isFinite(raw.id)) return null;
  return {
    id: raw.id,
    timestamp: text(raw.timestamp),
    kind: text(raw.kind),
    summary: text(raw.summary) || text(raw.msg),
  };
}

/** One SSE payload: `{ events: [...] }` seeds (and replaces) the log, `{ event }` appends one entry. */
export function parseEventLogPayload(data: unknown): { entries: DeviceEventLogEntry[]; reset: boolean } | null {
  if (!isRecord(data)) return null;
  if (Array.isArray(data.events)) {
    return { entries: data.events.flatMap((raw) => toEntry(raw) ?? []), reset: true };
  }
  const entry = toEntry(data.event);
  return entry ? { entries: [entry], reset: false } : null;
}

export interface DeviceEventLogBuffer {
  /** Adds entries in id order, replacing everything on `reset`. Returns the new snapshot. */
  apply(entries: readonly DeviceEventLogEntry[], reset: boolean): DeviceEventLogEntry[];
  clear(): void;
  entries(): DeviceEventLogEntry[];
}

/**
 * Keeps the newest `limit` entries. serve-sim may re-send an entry after it
 * updates it (an action result), so an id already present is replaced in place.
 */
export function createEventLogBuffer(limit = DEVICE_EVENT_LOG_LIMIT): DeviceEventLogBuffer {
  let items: DeviceEventLogEntry[] = [];
  /** Entries at or below this id were cleared by the user and are not shown again. */
  let clearedThrough = -Infinity;
  return {
    apply(entries, reset) {
      if (reset) items = [];
      for (const entry of entries) {
        if (entry.id <= clearedThrough) continue;
        const index = items.findIndex((item) => item.id === entry.id);
        if (index >= 0) items[index] = entry;
        else items.push(entry);
      }
      items.sort((left, right) => left.id - right.id);
      if (items.length > limit) items = items.slice(items.length - limit);
      return [...items];
    },
    clear() {
      clearedThrough = Math.max(clearedThrough, ...items.map((item) => item.id));
      items = [];
    },
    entries: () => [...items],
  };
}

/** Case-insensitive match on the summary or kind. */
export function filterEventLog(entries: readonly DeviceEventLogEntry[], query: string): DeviceEventLogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (entry) => entry.summary.toLowerCase().includes(needle) || entry.kind.toLowerCase().includes(needle),
  );
}

/** Local `HH:MM:SS` from an ISO timestamp (serve-sim sends UTC), or empty when there is none. */
export function eventLogTime(timestamp: string): string {
  if (!/T\d{2}:\d{2}:\d{2}/u.test(timestamp)) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Plain text for the clipboard: one line per entry. */
export function formatEventLog(entries: readonly DeviceEventLogEntry[]): string {
  return entries
    .map((entry) => [eventLogTime(entry.timestamp), entry.kind, entry.summary].filter(Boolean).join("  "))
    .join("\n");
}

export interface DeviceEventLogRuntime {
  fetch(url: string, init: { signal: AbortSignal; credentials: "omit" }): Promise<Response>;
}

/** Follows the event log until the returned function is called. Failures end the feed and are reported once. */
export function subscribeDeviceEventLog(
  target: { hostId: string; deviceId: string; grant: DeviceStreamGrant },
  onEvents: (entries: DeviceEventLogEntry[], reset: boolean) => void,
  onEnd: (error: string | null) => void = () => undefined,
  runtime: DeviceEventLogRuntime = { fetch: (url, init) => fetch(url, init) },
): () => void {
  const controller = new AbortController();
  const query = new URLSearchParams({ device: target.deviceId, limit: String(DEVICE_EVENT_LOG_SEED) });
  const url = deviceHubUrl(target, `/vendor/serve-sim/api/event-log/events?${query.toString()}`, "http");
  const parse = createSseParser((data) => {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = parseEventLogPayload(payload);
    if (parsed && !controller.signal.aborted) onEvents(parsed.entries, parsed.reset);
  });
  void (async () => {
    try {
      const response = await runtime.fetch(url, { signal: controller.signal, credentials: "omit" });
      if (!response.ok || !response.body) {
        if (!controller.signal.aborted) onEnd("The event log is unavailable for this simulator.");
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) {
          onEnd(null);
          return;
        }
        parse(value);
      }
    } catch {
      if (!controller.signal.aborted) onEnd("The event log disconnected.");
    }
  })();
  return () => controller.abort();
}
