// Routines that run when something happens (spec §6 P1): a file changes in
// the Bot's folder, or the routine's own link is called on this Mac's
// network. Email and calendar watches are not built yet (D2 approved, spike
// pending).

export type BotRoutineTrigger =
  | { kind: "file_change"; folder: string; pattern?: string }
  | { kind: "webhook" };

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

/** Strict: only these shapes; a folder is relative to the Bot's folder and never climbs out of it. */
export function parseBotRoutineTrigger(value: unknown): BotRoutineTrigger {
  const fail = (): never => {
    throw new Error("Invalid routine trigger.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
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

export function formatBotRoutineTriggerLabel(trigger: BotRoutineTrigger): string {
  if (trigger.kind === "webhook") return "When this routine's link is called";
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
