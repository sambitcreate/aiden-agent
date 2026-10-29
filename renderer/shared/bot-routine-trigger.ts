// Routines that run when something happens (spec §6 P1): a file changes in
// the Bot's folder, the routine's own link is called on this Mac's network,
// or a watch notices that a page or a script's output changed (a cheap check
// before the model: unchanged output never wakes the Bot). Email and calendar
// watches are not built yet (D2 approved, spike pending).

/** What a watch checks: a bounded GET of one address, or a script in the Bot's folder. */
export type BotWatchSource = { type: "url"; url: string } | { type: "script"; script: string };

export type BotRoutineTrigger =
  | { kind: "file_change"; folder: string; pattern?: string }
  | { kind: "webhook" }
  | { kind: "watch"; source: BotWatchSource; everyMinutes: number };

export type BotRoutineTriggerKind = BotRoutineTrigger["kind"];

export const BOT_ROUTINE_EVENT_LIMITS = {
  minGapMs: 5 * 60_000,
  perDay: 24,
  payloadChars: 4_000,
  coalesceMs: 30_000,
  seenIds: 200,
  folderChars: 200,
  patternChars: 64,
} as const;

export const BOT_WATCH_LIMITS = {
  minMinutes: 5,
  maxMinutes: 1_440,
  urlChars: 2_048,
  scriptChars: 200,
  /** A URL check: one GET, no redirects, 30 seconds, 256 KB. */
  urlTimeoutMs: 30_000,
  urlBytes: 256 * 1024,
  /** A script check: 60 seconds, 1 MB of output. */
  scriptTimeoutMs: 60_000,
  scriptBytes: 1024 * 1024,
  /** Consecutive failed checks before the watch turns itself off with one card. */
  failuresBeforePause: 3,
} as const;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A relative path inside the Bot's folder: never absolute, never `..`, never the Bot's own `.aiden/` state. */
function insideRelative(value: unknown, limit: number): string | undefined {
  const relative = typeof value === "string" ? value.trim().replace(/\\/gu, "/").replace(/^\.\/+/u, "") : "";
  if (!relative || relative.length > limit) return undefined;
  if (relative.startsWith("/") || /^[A-Za-z]:/u.test(relative)) return undefined;
  if (relative.split("/").some((part) => part === ".." || part === "" || part === ".")) return undefined;
  if (relative.split("/")[0] === ".aiden") return undefined;
  if (relative.includes("\0")) return undefined;
  return relative;
}

/**
 * A watch address: https, or http only to this Mac (localhost, 127.0.0.1,
 * [::1]). No user name or password in it; the fragment is dropped because it
 * is never sent.
 */
export function parseBotWatchUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.trim().length > BOT_WATCH_LIMITS.urlChars) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return undefined;
  url.hash = "";
  return url.href;
}

function parseWatch(record: Record<string, unknown>): BotRoutineTrigger | undefined {
  if (!Object.keys(record).every((key) => key === "kind" || key === "source" || key === "everyMinutes")) return undefined;
  const every = record.everyMinutes;
  if (typeof every !== "number" || !Number.isInteger(every)) return undefined;
  if (every < BOT_WATCH_LIMITS.minMinutes || every > BOT_WATCH_LIMITS.maxMinutes) return undefined;
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const fields = source as Record<string, unknown>;
  if (fields.type === "url") {
    if (Object.keys(fields).length !== 2 || !("url" in fields)) return undefined;
    const url = parseBotWatchUrl(fields.url);
    return url ? { kind: "watch", source: { type: "url", url }, everyMinutes: every } : undefined;
  }
  if (fields.type === "script") {
    if (Object.keys(fields).length !== 2 || !("script" in fields)) return undefined;
    const script = insideRelative(fields.script, BOT_WATCH_LIMITS.scriptChars);
    return script ? { kind: "watch", source: { type: "script", script }, everyMinutes: every } : undefined;
  }
  return undefined;
}

/** Strict: only these shapes; a folder is relative to the Bot's folder and never climbs out of it. */
export function parseBotRoutineTrigger(value: unknown): BotRoutineTrigger {
  const fail = (): never => {
    throw new Error("Invalid routine trigger.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (record.kind === "watch") return parseWatch(record) ?? fail();
  if (record.kind === "webhook") {
    if (Object.keys(record).length !== 1) return fail();
    return { kind: "webhook" };
  }
  if (record.kind !== "file_change") return fail();
  if (!Object.keys(record).every((key) => key === "kind" || key === "folder" || key === "pattern")) return fail();
  const folder = typeof record.folder === "string" ? record.folder.trim().replace(/\\/gu, "/").replace(/^\.\/+/u, "") : "";
  if (!folder || folder.length > BOT_ROUTINE_EVENT_LIMITS.folderChars) return fail();
  if (folder.startsWith("/") || /^[A-Za-z]:/u.test(folder)) return fail();
  if (folder.split("/").some((part) => part === ".." || part === "")) return fail();
  if (folder.split("/")[0] === ".aiden") return fail();
  if (record.pattern !== undefined) {
    if (typeof record.pattern !== "string" || !record.pattern.trim() || record.pattern.length > BOT_ROUTINE_EVENT_LIMITS.patternChars) return fail();
    return { kind: "file_change", folder, pattern: record.pattern.trim() };
  }
  return { kind: "file_change", folder };
}

/** "5 min", "90 min", "hour", "3 hours", "day": how often a watch checks. */
export function formatBotWatchInterval(minutes: number): string {
  if (minutes === 1_440) return "day";
  if (minutes % 60 !== 0) return `${minutes} min`;
  return minutes === 60 ? "hour" : `${minutes / 60} hours`;
}

function shortened(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function formatBotRoutineTriggerLabel(trigger: BotRoutineTrigger): string {
  if (trigger.kind === "webhook") return "When this routine's link is called";
  if (trigger.kind === "watch") {
    const what = trigger.source.type === "url"
      ? shortened(trigger.source.url, 80)
      : `the output of ${shortened(trigger.source.script, 60)}`;
    return `Every ${formatBotWatchInterval(trigger.everyMinutes)}, when ${what} changes`;
  }
  return trigger.pattern
    ? `When ${trigger.pattern} files change in ${trigger.folder}`
    : `When files change in ${trigger.folder}`;
}

/** Whether a changed path's file name matches a simple `*.ext`-style pattern. */
export function matchesTriggerPattern(fileName: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const expression = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`,
    "iu",
  );
  return expression.test(fileName);
}
