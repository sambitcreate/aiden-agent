// What starts a scheduled task that has no cron: a trigger. A watch checks an
// address or a project script every N minutes and runs the task only when
// something changed (docs/plans/proactive-aiden-plan.md, Phase 4). The check
// itself never runs a model; an unchanged page or a quiet script costs nothing.
//
// Main validates every trigger with `parseScheduledTaskTrigger`; renderer and
// phone input is never trusted as-is.

import {
  BOT_WATCH_LIMITS,
  formatBotWatchInterval,
  parseBotWatchUrl,
  watchAddressLabel,
} from "./bot-routine-trigger.js";
import {
  BOT_CONNECTOR_WATCH_LIMITS,
  type BotConnectorWatchCondition,
  type BotConnectorWatchInterval,
} from "./bot-connector-watches.js";

/** A watch checks one https address (http only to this computer) or one script from `.aiden/scripts`. */
export type ScheduledTaskWatchSource =
  | { type: "url"; url: string }
  | { type: "script"; script: string };

export type ScheduledTaskWatchTrigger = {
  kind: "watch";
  source: ScheduledTaskWatchSource;
  everyMinutes: number;
  /**
   * Aiden proposed this address watch (the schedule tool): each check
   * connects only to public addresses, so a name that resolves to this
   * computer or a private network is refused.
   */
  agentProposed?: true;
};

/** A call runs the task only when the JSON value at `path` equals `equals` (compared as text). */
export type ScheduledTaskLinkFilter = { path: string; equals: string };

/**
 * A private link on Aiden On The Go's listener (`POST /hooks/tasks/<token>`).
 * The token and the optional signing secret never leave main except once, to
 * the person, when the link is made or rotated.
 */
export type ScheduledTaskLinkTrigger = {
  kind: "webhook";
  /** Minutes between runs (1–60); calls inside the gap are batched. */
  gapMinutes: number;
  /** Calls must carry an HMAC-SHA256 of the body in this header (`sha256=<hex>`). */
  signatureHeader?: string;
  /** Every filter must match, or the call is logged and ignored. */
  filters?: ScheduledTaskLinkFilter[];
  /** Calls with the same value here are one event. */
  dedupePath?: string;
  /** Only these fields reach the model; otherwise the body, cut to 4,000 characters. */
  includeFields?: string[];
};

/** What the person picked in Find sources: names to show, never the account or tool identities. */
export type ScheduledTaskConnectorSourceLabels = {
  providerLabel: string;
  accountLabel: string;
  resourceLabel: string;
};

/**
 * A connected app checked every 15, 30 or 60 minutes (a local Mail mailbox
 * through iMCP on a Mac, or a Composio calendar). The exact source binding is
 * made in the foreground by Find sources and stays in main; a background
 * check only reads through a connection that is already open.
 */
export type ScheduledTaskConnectorTrigger = {
  kind: "connector";
  everyMinutes: BotConnectorWatchInterval;
  condition: BotConnectorWatchCondition;
  source: ScheduledTaskConnectorSourceLabels;
  /** Only on a save from the editor: the Find sources choice main swaps for the private binding. */
  sourceChoiceId?: string;
};

/** What a connected-app task that is on but has no source bound shows (it never checks). */
export const TASK_CONNECTOR_NEEDS_SOURCE =
  "Needs its source: open the task, choose Find sources and save it.";

export type ScheduledTaskTrigger =
  | ScheduledTaskWatchTrigger
  | ScheduledTaskLinkTrigger
  | ScheduledTaskConnectorTrigger;

export type ScheduledTaskTriggerKind = ScheduledTaskTrigger["kind"];

/** Per-task limits for trigger runs, and the overall cap on trigger runs at once. */
export const SCHEDULED_TASK_TRIGGER_LIMITS = {
  /** At most one run every 5 minutes per task. */
  minGapMs: 5 * 60_000,
  /** At most 48 runs a day per task. */
  perDay: 48,
  /** Trigger runs across every task at once. */
  runningOverall: 4,
  /** A script check's private state file. */
  checkStateBytes: 8 * 1024,
  /**
   * What one trigger run hands the model, in characters: a watch's newest
   * change first, a link's heading and calls. Held payloads use the same bound.
   */
  eventTextChars: 24_000,
} as const;

/** Link (webhook) limits per task. */
export const SCHEDULED_TASK_LINK_LIMITS = {
  minGapMinutes: 1,
  maxGapMinutes: 60,
  bodyBytes: 256 * 1024,
  callsPerMinute: 60,
  /** Calls held while the gap runs out; older ones beyond are dropped. */
  batch: 20,
  /** Delivery log entries kept per task. */
  log: 50,
  previewBytes: 2 * 1024,
  /** What one call shows the model. */
  payloadChars: 4_000,
  filters: 5,
  includeFields: 10,
  pathChars: 200,
} as const;

/** The intervals the editor offers, in minutes. Any whole number from 5 to 1440 is valid. */
export const SCHEDULED_TASK_WATCH_INTERVALS = [5, 10, 15, 30, 60, 120, 360, 720, 1_440] as const;

function scriptName(value: unknown): string | undefined {
  const script = typeof value === "string" ? value.trim() : "";
  if (
    !script ||
    script.length > 255 ||
    script === "." ||
    script === ".." ||
    script.includes("/") ||
    script.includes("\\") ||
    script.includes("\0")
  )
    return undefined;
  return script;
}

function invalid(): never {
  throw new Error("Invalid task trigger.");
}

/** `a.b.0.c`: dot-separated keys and array indexes into a JSON body. */
function jsonPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!path || path.length > SCHEDULED_TASK_LINK_LIMITS.pathChars) return undefined;
  const parts = path.split(".");
  if (!parts.every((part) => /^[A-Za-z0-9_$@-]+$/u.test(part))) return undefined;
  if (parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype"))
    return undefined;
  return path;
}

function parseLinkTrigger(record: Record<string, unknown>): ScheduledTaskLinkTrigger {
  const allowed = new Set([
    "kind",
    "gapMinutes",
    "signatureHeader",
    "filters",
    "dedupePath",
    "includeFields",
  ]);
  if (!Object.keys(record).every((key) => allowed.has(key))) return invalid();
  const gap = record.gapMinutes;
  if (
    typeof gap !== "number" ||
    !Number.isInteger(gap) ||
    gap < SCHEDULED_TASK_LINK_LIMITS.minGapMinutes ||
    gap > SCHEDULED_TASK_LINK_LIMITS.maxGapMinutes
  ) {
    throw new Error("A link runs the task at most once every 1 to 60 minutes.");
  }
  const trigger: ScheduledTaskLinkTrigger = { kind: "webhook", gapMinutes: gap };
  if (record.signatureHeader !== undefined) {
    const header =
      typeof record.signatureHeader === "string" ? record.signatureHeader.trim().toLowerCase() : "";
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(header) ||
      ["host", "content-type", "content-length", "authorization", "cookie"].includes(header)
    ) {
      throw new Error("Name the header that carries the signature, like x-signature-256.");
    }
    trigger.signatureHeader = header;
  }
  if (record.filters !== undefined) {
    if (
      !Array.isArray(record.filters) ||
      record.filters.length > SCHEDULED_TASK_LINK_LIMITS.filters
    ) {
      throw new Error(`A link has at most ${SCHEDULED_TASK_LINK_LIMITS.filters} filters.`);
    }
    const filters = record.filters.map((filter): ScheduledTaskLinkFilter => {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) return invalid();
      const row = filter as Record<string, unknown>;
      if (
        Object.keys(row).length !== 2 ||
        typeof row.equals !== "string" ||
        row.equals.length > 500
      )
        return invalid();
      const path = jsonPath(row.path);
      if (!path) throw new Error("A filter names a field like action or pull_request.state.");
      return { path, equals: row.equals };
    });
    if (filters.length) trigger.filters = filters;
  }
  if (record.dedupePath !== undefined) {
    const path = jsonPath(record.dedupePath);
    if (!path) throw new Error("The repeat check names a field like delivery.id.");
    trigger.dedupePath = path;
  }
  if (record.includeFields !== undefined) {
    if (
      !Array.isArray(record.includeFields) ||
      record.includeFields.length > SCHEDULED_TASK_LINK_LIMITS.includeFields
    ) {
      throw new Error(`A link passes at most ${SCHEDULED_TASK_LINK_LIMITS.includeFields} fields.`);
    }
    const fields = record.includeFields.map((field) => jsonPath(field) ?? invalid());
    if (fields.length) trigger.includeFields = [...new Set(fields)];
  }
  return trigger;
}

/** The intervals a connected-app check may use, in minutes. */
export const SCHEDULED_TASK_CONNECTOR_INTERVALS = [15, 30, 60] as const;

const CHOICE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function label(value: unknown, limit: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= limit && !text.includes("\0") ? text : undefined;
}

function parseConnectorCondition(value: unknown): BotConnectorWatchCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (record.kind === "email") {
    if (
      !Object.keys(record).every((key) =>
        ["kind", "unreadOnly", "sender", "subject"].includes(key),
      ) ||
      typeof record.unreadOnly !== "boolean"
    )
      return invalid();
    const condition: BotConnectorWatchCondition = { kind: "email", unreadOnly: record.unreadOnly };
    for (const key of ["sender", "subject"] as const) {
      if (record[key] === undefined || record[key] === "") continue;
      const text = label(record[key], BOT_CONNECTOR_WATCH_LIMITS.filterChars);
      if (!text) throw new Error("A Mail filter is at most 200 characters.");
      condition[key] = text;
    }
    return condition;
  }
  if (record.kind === "calendar") {
    if (Object.keys(record).sort().join(",") !== "kind,lookAheadMinutes,timezone") return invalid();
    const ahead = record.lookAheadMinutes;
    if (
      typeof ahead !== "number" ||
      !Number.isInteger(ahead) ||
      ahead < BOT_CONNECTOR_WATCH_LIMITS.lookAheadMinMinutes ||
      ahead > BOT_CONNECTOR_WATCH_LIMITS.lookAheadMaxMinutes
    ) {
      throw new Error("Look ahead between 15 minutes and one day.");
    }
    const timezone = label(record.timezone, BOT_CONNECTOR_WATCH_LIMITS.timezoneChars);
    try {
      if (!timezone) throw new Error();
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new Error("Choose a valid time zone for the calendar.");
    }
    return { kind: "calendar", lookAheadMinutes: ahead, timezone };
  }
  return invalid();
}

function parseConnectorTrigger(record: Record<string, unknown>): ScheduledTaskConnectorTrigger {
  if (
    !Object.keys(record).every((key) =>
      ["kind", "everyMinutes", "condition", "source", "sourceChoiceId"].includes(key),
    )
  )
    return invalid();
  if (!SCHEDULED_TASK_CONNECTOR_INTERVALS.includes(record.everyMinutes as 15))
    throw new Error("A connected app is checked every 15, 30 or 60 minutes.");
  const condition = parseConnectorCondition(record.condition);
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new Error("Find a source for this task first.");
  const fields = source as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "accountLabel,providerLabel,resourceLabel")
    return invalid();
  const labels = (["providerLabel", "accountLabel", "resourceLabel"] as const).map((key) =>
    label(fields[key], BOT_CONNECTOR_WATCH_LIMITS.labelChars),
  );
  if (labels.some((value) => value === undefined)) return invalid();
  const trigger: ScheduledTaskConnectorTrigger = {
    kind: "connector",
    everyMinutes: record.everyMinutes as BotConnectorWatchInterval,
    condition,
    source: { providerLabel: labels[0]!, accountLabel: labels[1]!, resourceLabel: labels[2]! },
  };
  if (record.sourceChoiceId !== undefined) {
    if (typeof record.sourceChoiceId !== "string" || !CHOICE_ID.test(record.sourceChoiceId))
      return invalid();
    trigger.sourceChoiceId = record.sourceChoiceId.toLowerCase();
  }
  return trigger;
}

/** Strict: only these shapes, nothing extra. Throws a message for the person otherwise. */
export function parseScheduledTaskTrigger(value: unknown): ScheduledTaskTrigger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (record.kind === "webhook") return parseLinkTrigger(record);
  if (record.kind === "connector") return parseConnectorTrigger(record);
  if (record.kind !== "watch") return invalid();
  if (
    !Object.keys(record).every(
      (key) =>
        key === "kind" || key === "source" || key === "everyMinutes" || key === "agentProposed",
    )
  )
    return invalid();
  if (record.agentProposed !== undefined && record.agentProposed !== true) return invalid();
  const every = record.everyMinutes;
  if (
    typeof every !== "number" ||
    !Number.isInteger(every) ||
    every < BOT_WATCH_LIMITS.minMinutes ||
    every > BOT_WATCH_LIMITS.maxMinutes
  ) {
    throw new Error(
      `A watch checks every ${BOT_WATCH_LIMITS.minMinutes} to ${BOT_WATCH_LIMITS.maxMinutes} minutes.`,
    );
  }
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return invalid();
  const fields = source as Record<string, unknown>;
  if (Object.keys(fields).length !== 2) return invalid();
  if (fields.type === "url") {
    const url = parseBotWatchUrl(fields.url);
    if (!url) throw new Error("Watch an https address, or http only on this computer.");
    return {
      kind: "watch",
      source: { type: "url", url },
      everyMinutes: every,
      ...(record.agentProposed === true ? { agentProposed: true as const } : {}),
    };
  }
  if (fields.type === "script") {
    const script = scriptName(fields.script);
    if (!script) throw new Error("Choose one script file from an .aiden/scripts folder.");
    return { kind: "watch", source: { type: "script", script }, everyMinutes: every };
  }
  return invalid();
}

function shortened(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** "Every 15 min, when example.com/status changes": the line a task row shows instead of its schedule. */
export function formatScheduledTaskTriggerLabel(trigger: ScheduledTaskTrigger): string {
  if (trigger.kind === "webhook") {
    const filtered = trigger.filters?.length ? ", when it matches" : "";
    return `When its link is called${filtered} (at most every ${formatBotWatchInterval(trigger.gapMinutes)})`;
  }
  if (trigger.kind === "connector") {
    const every = formatBotWatchInterval(trigger.everyMinutes);
    const where = shortened(trigger.source.resourceLabel, 60);
    return trigger.condition.kind === "email"
      ? `Every ${every}, when ${where} gets new mail`
      : `Every ${every}, when ${where} has events coming up`;
  }
  const every = formatBotWatchInterval(trigger.everyMinutes);
  if (trigger.source.type === "url") {
    return `Every ${every}, when ${watchAddressLabel(trigger.source.url, { scheme: false, query: false, pathChars: 40 })} changes`;
  }
  return `Every ${every}, when ${shortened(trigger.source.script, 60)} prints something`;
}

function privateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part))) return false;
  const [a, b, c] = parts.map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    // IETF protocol assignments, benchmarking, documentation, multicast, reserved and broadcast.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The IPv4 address two hex groups spell (`7f00:1` is 127.0.0.1). */
function ipv4FromGroups(high: string, low: string): string {
  const h = Number.parseInt(high, 16);
  const l = Number.parseInt(low, 16);
  return [h >> 8, h & 255, l >> 8, l & 255].join(".");
}

function privateIpv6(raw: string): boolean {
  let ip: string;
  try {
    // The URL parser writes every spelling of an address the same way.
    ip = new URL(`http://[${raw}]`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  if (ip === "::" || ip === "::1") return true;
  // IPv4-mapped (::ffff:), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::) addresses carry an IPv4 address.
  const embedded = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(ip);
  if (embedded) return privateIpv4(ipv4FromGroups(embedded[1]!, embedded[2]!));
  if (ip.startsWith("64:ff9b:1:")) return true; // Local-use NAT64.
  return (
    /^f[cd][0-9a-f]{0,2}:/u.test(ip) || // Unique local.
    /^fe[89ab][0-9a-f]?:/u.test(ip) || // Link-local.
    /^fe[c-f][0-9a-f]?:/u.test(ip) || // Site-local (deprecated).
    /^ff[0-9a-f]{0,2}:/u.test(ip) || // Multicast.
    /^2001:db8:/u.test(ip)
  ); // Documentation.
}

/**
 * Whether an IP address (dotted IPv4, or IPv6 with or without brackets) is
 * this computer, a private or link-local network, or otherwise not a public
 * host. Also used for what a watch address resolves to.
 */
export function isPrivateIpAddress(value: string): boolean {
  const ip = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return ip.includes(":") ? privateIpv6(ip) : privateIpv4(ip);
}

/** Names that only mean something on a local network. */
const LOCAL_NAME =
  /\.(?:localhost|local|internal|home\.arpa|lan|home|corp|intranet|private|localdomain|box|router)$/u;

/**
 * Whether a watch address points at this computer or a private network: a
 * loopback, private, link-local, reserved or multicast IP literal (IPv4 inside
 * IPv6 too), `localhost`, a name with no dot, or a local-network name
 * (`.local`, `.internal`, `.home.arpa`, `.lan` and the like). The person's
 * editor may watch these; a watch the agent proposes may not. A name that
 * resolves to such an address is caught when the watch is checked.
 */
export function isPrivateWatchAddress(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return true;
  }
  if (host === "localhost" || LOCAL_NAME.test(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) return privateIpv6(host.slice(1, -1));
  if (/^[\d.]+$/u.test(host)) return privateIpv4(host) || host.split(".").length !== 4;
  return !host.includes(".");
}
