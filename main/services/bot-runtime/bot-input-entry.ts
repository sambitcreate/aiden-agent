/** Pi places this kind on the input itself only when the host admits a routine. */
export const BOT_ROUTINE_INPUT_KIND = "aiden.routine-input";
export const BOT_PERSON_INPUT_KIND = "aiden.person-input";
export const BOT_PEER_INPUT_KIND = "aiden.peer-input";

export function isBotInputEntryKind(kind: string): boolean {
  return kind === "pi.user" || kind === BOT_PERSON_INPUT_KIND || kind === BOT_ROUTINE_INPUT_KIND || kind === BOT_PEER_INPUT_KIND;
}

export interface BotRoutineInputOrigin {
  version: 1;
  botId: string;
  routineId: string;
  runId: string;
  kind: "scheduled" | "manual" | "event" | "retry" | "catch_up";
}
const issuedRoutineOrigins = new WeakSet<object>();
/** Strict stored facts; callers must additionally verify actual host routine ownership. */
export function parseBotRoutineInputOrigin(value: unknown): BotRoutineInputOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 5 || Object.keys(raw).some((key) => !["version", "botId", "routineId", "runId", "kind"].includes(key)) || raw.version !== 1 || !["scheduled", "manual", "event", "retry", "catch_up"].includes(String(raw.kind))) return undefined;
  if ([raw.botId, raw.routineId, raw.runId].some((item) => typeof item !== "string" || item.length < 1 || item.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(item))) return undefined;
  return { version: 1, botId: raw.botId as string, routineId: raw.routineId as string, runId: raw.runId as string, kind: raw.kind as BotRoutineInputOrigin["kind"] };
}
/** Called only by the host routine adapter after accepted-task ownership checks. */
export function issueBotRoutineInputOrigin(value: BotRoutineInputOrigin): BotRoutineInputOrigin {
  const origin = parseBotRoutineInputOrigin(value);
  if (!origin) throw new Error("Invalid host routine input origin.");
  issuedRoutineOrigins.add(origin); return Object.freeze(origin);
}
export function isIssuedBotRoutineInputOrigin(value: unknown): value is BotRoutineInputOrigin {
  return value !== null && typeof value === "object" && issuedRoutineOrigins.has(value);
}
