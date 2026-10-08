/**
 * Adapted from t3code apps/web/src/components/device/deviceHubApi.ts @ a6ec88f7 (MIT)
 *
 * serve-sim's iOS event log: touches, keys, buttons, and app launches the hub
 * saw, seeded with recent history and then pushed live over Server-Sent
 * Events at `/vendor/serve-sim/api/event-log/events?device=<udid>`. T3 uses
 * EventSource; Aiden reads the stream with `fetch` through main's token proxy,
 * like the frontmost-app feed. The buffer is bounded so a long session never
 * grows the drawer without limit. Android emulators show logcat in the same
 * buffer, from serve-emu's `/api/logcat` stream.
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

/** `HH:MM:SS` from an ISO timestamp, or empty when there is none. */
export function eventLogTime(timestamp: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/u.exec(timestamp);
  return match?.[1] ?? "";
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

// ── Android: serve-emu's logcat stream ───────────────────────────────────────
// serve-emu runs one `adb logcat -T 1 -v threadtime` child per emulator while
// anyone subscribes, batches lines into `logs` SSE events with bounded
// per-subscriber queues, and stops the child (SIGTERM, then SIGKILL after a
// second) when the last subscriber's request goes away. Its `package` query
// keeps only lines from that app's processes.

const LOGCAT_LEVELS: Readonly<Record<string, string>> = {
  V: "verbose",
  D: "debug",
  I: "info",
  W: "warning",
  E: "error",
  F: "fatal",
  A: "assert",
};

/** `MM-DD HH:MM:SS.mmm  PID  TID L TAG     : message`, as `-v threadtime` prints it. */
const THREADTIME = /^\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d{3}\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:(?: (.*))?$/u;

export interface LogcatLine {
  pid: number;
  tid: number;
  level: string;
  tag: string;
  message: string;
}

/** One threadtime line, or null for anything else (buffer banners, adb's own stderr). */
export function parseLogcatLine(line: string): LogcatLine | null {
  const match = THREADTIME.exec(line);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    tid: Number(match[2]),
    level: match[3]!,
    tag: match[4]!.trim(),
    message: match[5] ?? "",
  };
}

/** Ids keep rising across subscriptions, so a cleared log stays cleared when the section reopens. */
let nextLogcatId = 1;

/** One logcat line as an event-log entry: the level as its kind, `L Tag: message` as its summary. */
export function logcatEntry(line: string, at: string): DeviceEventLogEntry {
  const parsed = parseLogcatLine(line);
  const id = nextLogcatId++;
  if (!parsed) return { id, timestamp: text(at), kind: "logcat", summary: text(line) };
  return {
    id,
    timestamp: text(at),
    kind: LOGCAT_LEVELS[parsed.level] ?? "logcat",
    summary: text(`${parsed.level} ${parsed.tag}: ${parsed.message}`),
  };
}

/**
 * One serve-emu logcat payload: a `logs` batch becomes entries (with a note
 * when serve-emu dropped lines for a slow reader); `error` and `close`
 * report why the feed ended.
 */
export function parseLogcatPayload(
  data: unknown,
): { entries: DeviceEventLogEntry[] } | { error: string } | { closed: true } | null {
  if (!isRecord(data)) return null;
  if (Array.isArray(data.lines)) {
    const entries = data.lines.flatMap((raw) =>
      isRecord(raw) && typeof raw.line === "string" ? [logcatEntry(raw.line, typeof raw.at === "string" ? raw.at : "")] : [],
    );
    const dropped = typeof data.dropped === "number" && Number.isFinite(data.dropped) ? data.dropped : 0;
    if (dropped > 0) {
      entries.push({
        id: nextLogcatId++,
        timestamp: entries[entries.length - 1]?.timestamp ?? "",
        kind: "logcat",
        summary: dropped === 1 ? "1 line was skipped to keep up." : `${dropped} lines were skipped to keep up.`,
      });
    }
    return { entries };
  }
  if (typeof data.error === "string") return { error: text(data.error) };
  if ("reason" in data || "code" in data || "signal" in data) return { closed: true };
  return null;
}

/** An app package as Android names it; anything else is not sent as a filter. */
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;

/** Follows an emulator's logcat until the returned function is called, optionally one app's lines only. */
export function subscribeAndroidLogcat(
  target: { hostId: string; deviceId: string; grant: DeviceStreamGrant; packageName?: string },
  onEvents: (entries: DeviceEventLogEntry[], reset: boolean) => void,
  onEnd: (error: string | null) => void = () => undefined,
  runtime: DeviceEventLogRuntime = { fetch: (url, init) => fetch(url, init) },
): () => void {
  const controller = new AbortController();
  const query = new URLSearchParams({ device: target.deviceId });
  if (target.packageName && ANDROID_PACKAGE.test(target.packageName)) query.set("package", target.packageName);
  const url = deviceHubUrl(target, `/vendor/serve-emu/api/logcat?${query.toString()}`, "http");
  let ended = false;
  const end = (error: string | null) => {
    if (ended || controller.signal.aborted) return;
    ended = true;
    onEnd(error);
  };
  const parse = createSseParser((data) => {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = parseLogcatPayload(payload);
    if (!parsed || controller.signal.aborted) return;
    if ("entries" in parsed) {
      if (parsed.entries.length > 0) onEvents(parsed.entries, false);
    } else if ("error" in parsed) {
      end(`Logcat stopped: ${parsed.error}`);
    } else {
      end(null);
    }
  });
  void (async () => {
    try {
      const response = await runtime.fetch(url, { signal: controller.signal, credentials: "omit" });
      if (!response.ok || !response.body) {
        end(response.status === 429 ? "Too many logcat readers are open for this emulator." : "Logcat is unavailable for this emulator.");
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) {
          end(null);
          return;
        }
        parse(value);
      }
    } catch {
      end("Logcat disconnected.");
    }
  })();
  // Aborting the request is what makes serve-emu stop its logcat child.
  return () => controller.abort();
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
