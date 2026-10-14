// What a working Bot's status line says (spec 2026-10-14 §5): one phase at a
// time, with the same ids, words and marks on the Mac and, from slice D, on
// phones. Main classifies the active tool with this table, the renderer draws
// it, and the CLI bundles it as is.

import type { ActivityMark } from "./activity-marks.js";

export const BOT_ACTIVITY_PHASES = [
  "preparing",
  "thinking",
  "reading",
  "photo",
  "searching",
  "command",
  "editing",
  "app",
  "helper",
  "computer",
  "remembering",
  "routine",
  "working",
  "writing",
  "waiting",
  "tidying",
  "stopping",
  "resuming",
  "reconnecting",
] as const;
export type BotActivityPhase = (typeof BOT_ACTIVITY_PHASES)[number];

/** The phases an active tool maps to (§5.1). */
export type BotToolPhase = Extract<
  BotActivityPhase,
  | "reading"
  | "photo"
  | "searching"
  | "command"
  | "editing"
  | "app"
  | "helper"
  | "computer"
  | "remembering"
  | "routine"
  | "working"
  | "waiting"
>;

/** What the status line says: the work, or always "Thinking". */
export type BotChatActivityWording = "follows" | "thinking";

const PHASES: Record<BotActivityPhase, { word: string; mark: ActivityMark }> = {
  preparing: { word: "Getting ready", mark: "bounce" },
  thinking: { word: "Thinking", mark: "tri-step" },
  reading: { word: "Reading", mark: "scan-grid" },
  photo: { word: "Looking at your photo", mark: "scan-grid" },
  searching: { word: "Searching the web", mark: "scan-grid" },
  command: { word: "Running a command", mark: "quad-shuffle" },
  editing: { word: "Editing files", mark: "quad-shuffle" },
  app: { word: "Using an app", mark: "quad-shuffle" },
  helper: { word: "Asking a helper", mark: "quad-shuffle" },
  computer: { word: "Using your Mac", mark: "quad-shuffle" },
  remembering: { word: "Remembering", mark: "compose" },
  routine: { word: "Setting up a routine", mark: "tri-step" },
  working: { word: "Working", mark: "quad-shuffle" },
  writing: { word: "Writing", mark: "compose" },
  waiting: { word: "Waiting for you", mark: "glance" },
  tidying: { word: "Tidying up its notes", mark: "bounce" },
  stopping: { word: "Stopping", mark: "bounce" },
  resuming: { word: "Picking up where it left off", mark: "bounce" },
  reconnecting: { word: "Reconnecting to your Mac", mark: "bounce" },
};

/** The Bot tool set's fixed tools (`bot-tool-policy.ts`, `bot-file-tool-router.ts`). */
const TOOL_PHASES: ReadonlyMap<string, BotToolPhase> = new Map<string, BotToolPhase>([
  ["read_file", "reading"],
  ["list_dir", "reading"],
  ["glob", "reading"],
  ["grep", "reading"],
  ["edit_file", "editing"],
  ["write_file", "editing"],
  ["run_command", "command"],
  ["web_search", "searching"],
  ["computer_use", "computer"],
  ["form_fill", "computer"],
  ["inspect_image", "photo"],
  ["subagent", "helper"],
  ["bot_memory", "remembering"],
  ["routines", "routine"],
  ["routine_notes", "routine"],
  ["ask_user_question", "waiting"],
]);

const PHASE_IDS: ReadonlySet<string> = new Set(BOT_ACTIVITY_PHASES);

export function isBotActivityPhase(value: unknown): value is BotActivityPhase {
  return typeof value === "string" && PHASE_IDS.has(value);
}

/** The longest connection label a status line shows; the Remote wire uses the same bound (§11). */
export const BOT_APP_LABEL_CHARS = 40;

// `mcpAgentToolName` (main/services/mcp-tool-identity.ts) mints connection
// tools as `<server name>__<tool>_<12 hex>`, with other characters as `_`.
const MCP_AGENT_TOOL = /^(.+?)__.+_[0-9a-f]{12}$/u;

/** The connection label of an MCP or Composio tool, or undefined for Aiden's own tools. */
export function botToolApp(toolName: string): string | undefined {
  const match = MCP_AGENT_TOOL.exec(toolName);
  const label = match?.[1]?.replace(/_+/gu, " ").trim();
  if (!label) return undefined;
  const points = [...label];
  return points.length > BOT_APP_LABEL_CHARS ? points.slice(0, BOT_APP_LABEL_CHARS).join("").trimEnd() : label;
}

/** The phase an active tool puts its Bot in (§5.1). */
export function botToolPhase(toolName: string, app?: string): BotToolPhase {
  return TOOL_PHASES.get(toolName) ?? (app ? "app" : "working");
}

/** The status line's word for a phase; `app` fills "Using {app}". */
export function botPhaseWord(phase: BotActivityPhase, app?: string): string {
  return phase === "app" && app ? `Using ${app}` : PHASES[phase].word;
}

/** Phases that keep their own word under Always "Thinking": they change what the person should do. */
const KEEPS_ITS_WORD: ReadonlySet<BotActivityPhase> = new Set(["waiting", "stopping", "reconnecting"]);

export interface BotActivityDisplay {
  phase: BotActivityPhase;
  word: string;
  mark: ActivityMark;
}

/** What the line shows for a phase id from any client: unknown ids read as `working` (§5.2). */
export function botActivityDisplay(phase: string, wording: BotChatActivityWording, app?: string): BotActivityDisplay {
  const known: BotActivityPhase = isBotActivityPhase(phase) ? phase : "working";
  const shown: BotActivityPhase = wording === "thinking" && !KEEPS_ITS_WORD.has(known) ? "thinking" : known;
  return { phase: shown, word: botPhaseWord(shown, app), mark: PHASES[shown].mark };
}

interface StepPhrases {
  one: string;
  many(count: number): string;
  infinitive: string;
}

function stepPhrases(kind: BotToolPhase, app?: string): StepPhrases {
  const name = app ?? "an app";
  switch (kind) {
    case "reading":
      return { one: "Read 1 file", many: (n) => `Read ${n} files`, infinitive: "read a file" };
    case "editing":
      return { one: "Edited 1 file", many: (n) => `Edited ${n} files`, infinitive: "edit a file" };
    case "command":
      return { one: "Ran a command", many: (n) => `Ran ${n} commands`, infinitive: "run a command" };
    case "searching":
      return { one: "Searched the web", many: (n) => `Searched the web ${n} times`, infinitive: "search the web" };
    case "photo":
      return { one: "Looked at your photo", many: (n) => `Looked at ${n} photos`, infinitive: "look at your photo" };
    case "computer":
      return { one: "Used your Mac", many: (n) => `Used your Mac ${n} times`, infinitive: "use your Mac" };
    case "helper":
      return { one: "Asked a helper", many: (n) => `Asked ${n} helpers`, infinitive: "ask a helper" };
    case "remembering":
      return { one: "Updated its memory", many: () => "Updated its memory", infinitive: "update its memory" };
    case "routine":
      return { one: "Set up a routine", many: (n) => `Worked on ${n} routines`, infinitive: "set up a routine" };
    case "app":
      return { one: `Used ${name}`, many: (n) => `Used ${name} ${n} times`, infinitive: `use ${name}` };
    case "waiting":
      return { one: "Asked you a question", many: (n) => `Asked you ${n} questions`, infinitive: "ask you a question" };
    case "working":
      return { one: "Used a tool", many: (n) => `Used ${n} tools`, infinitive: "use a tool" };
  }
}

/** A finished step, past tense: "Read 1 file", "Read 6 files", "Used Notion". */
export function botStepPhrase(kind: BotToolPhase, count: number, app?: string): string {
  const phrases = stepPhrases(kind, app);
  return count <= 1 ? phrases.one : phrases.many(count);
}

/** The bare verb phrase for "Couldn’t …" and "Blocked: …". */
export function botStepInfinitive(kind: BotToolPhase, app?: string): string {
  return stepPhrases(kind, app).infinitive;
}

export const BOT_ELAPSED_AFTER_MS = 20_000;
export const BOT_STILL_GOING_AFTER_MS = 120_000;

/** "18s", "1m 12s", "2m", "1h 2m". Never less than one second. */
export function botDurationLabel(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** The status line's elapsed time, once a turn has run for 20 seconds. */
export function botElapsedLabel(startedAt: number, now: number): string | null {
  const elapsed = now - startedAt;
  return Number.isFinite(elapsed) && elapsed >= BOT_ELAPSED_AFTER_MS ? botDurationLabel(elapsed) : null;
}

/** Screen readers hear a phase change at most this often (§14). */
export const BOT_ANNOUNCE_GAP_MS = 2_000;

export interface BotAnnouncement {
  text: string;
  at: number;
}

/**
 * What to announce now. A change inside the gap keeps the current text and
 * says when to try again; the newest text wins once the gap has passed.
 */
export function nextBotAnnouncement(
  current: BotAnnouncement | null,
  text: string,
  now: number,
  gapMs = BOT_ANNOUNCE_GAP_MS,
): { shown: BotAnnouncement; retryInMs?: number } {
  if (current !== null && current.text === text) return { shown: current };
  if (current === null || now - current.at >= gapMs) return { shown: { text, at: now } };
  return { shown: current, retryInMs: gapMs - (now - current.at) };
}

/**
 * The tool slot a status line follows. Slots are in call order and parallel
 * calls start in that order, so the last running one started most recently;
 * with none running, the first one about to start.
 */
export function pickActiveToolSlot<T extends { status: string }>(slots: readonly T[] | undefined): T | undefined {
  if (!slots) return undefined;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index]!.status === "running") return slots[index];
  }
  return slots.find((slot) => slot.status === "pending");
}
