// Per-routine notepad for Bot routines (spec 2026-10-09 §11.4).
//
// A routine run may keep a few short notes between its own runs ("last
// headline I sent", "week of the meal plan"). The notes live next to the
// Bot's session in `<profile>/bots/<dir>/routine-notes.json`, keyed by the
// routine's task id, so deleting the Bot erases them with its directory and
// deleting the routine clears its key. They are rendered at the top of that
// routine's own input message, never in the system prompt.

import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeJsonAtomic } from "./durable-fs.js";
import { botDirectoryName } from "./bot-runtime/harness-host.js";

export const ROUTINE_NOTES_TOOL_NAME = "routine_notes";
export const BOT_ROUTINE_NOTES_FILE = "routine-notes.json";
export const BOT_ROUTINE_NOTES_LIMITS = {
  keys: 16,
  keyChars: 64,
  valueChars: 2_000,
  /** UTF-8 bytes of every key and value of one routine together. */
  totalBytes: 8_000,
} as const;
export const BOT_ROUTINE_NOTES_HEADER = "Notes you kept from earlier runs of this routine:";

export interface BotRoutineNote {
  value: string;
  updatedAt: number;
}

export type BotRoutineNotes = Record<string, BotRoutineNote>;

export type BotRoutineNotesWriteResult =
  | { ok: true; notes: BotRoutineNotes }
  | { ok: false; code: "notes_full" | "invalid"; error: string; notes: BotRoutineNotes };

/** Runs `action` after every earlier action with the same key has settled. */
export function createKeyedSerial() {
  const tails = new Map<string, Promise<unknown>>();
  return function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(action, action);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** The Bot's private session directory, `<profile>/bots/<dir>`. */
export function botSessionDirectory(profileDir: string, botId: string): string {
  return path.join(profileDir, "bots", botDirectoryName(botId));
}

function isNote(value: unknown): value is BotRoutineNote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const note = value as Record<string, unknown>;
  return typeof note.value === "string" && typeof note.updatedAt === "number" && Number.isFinite(note.updatedAt);
}

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.trim() === key && key.length > 0 && [...key].length <= BOT_ROUTINE_NOTES_LIMITS.keyChars && !/[\r\n]/u.test(key);
}

/** Every routine's notes; unreadable or malformed content reads as no notes. */
function parseFile(text: string): Record<string, BotRoutineNotes> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const routines: Record<string, BotRoutineNotes> = {};
  for (const [taskId, notes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!notes || typeof notes !== "object" || Array.isArray(notes)) continue;
    const kept: BotRoutineNotes = {};
    for (const [key, note] of Object.entries(notes as Record<string, unknown>)) {
      if (validKey(key) && isNote(note) && [...note.value].length <= BOT_ROUTINE_NOTES_LIMITS.valueChars) kept[key] = note;
    }
    if (Object.keys(kept).length > 0) routines[taskId] = kept;
  }
  return routines;
}

function totalBytes(notes: BotRoutineNotes): number {
  let total = 0;
  for (const [key, note] of Object.entries(notes)) total += Buffer.byteLength(key) + Buffer.byteLength(note.value);
  return total;
}

/** `""` when there are no notes; otherwise the block prepended to the routine's input. */
export function renderBotRoutineNotes(notes: BotRoutineNotes): string {
  const lines = Object.entries(notes)
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .map(([key, note]) => `- ${key}: ${note.value.replace(/\r?\n/gu, " ")}`);
  return lines.length === 0 ? "" : `${BOT_ROUTINE_NOTES_HEADER}\n${lines.join("\n")}`;
}

export interface BotRoutineNotesStoreOptions {
  profileDir(): string;
  now?(): number;
}

export function createBotRoutineNotesStore(options: BotRoutineNotesStoreOptions) {
  const now = options.now ?? Date.now;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_ROUTINE_NOTES_FILE);

  async function load(botId: string): Promise<Record<string, BotRoutineNotes>> {
    try {
      return parseFile(await fs.readFile(fileOf(botId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async function save(botId: string, routines: Record<string, BotRoutineNotes>): Promise<void> {
    await writeJsonAtomic(fileOf(botId), routines, { mode: 0o600, mkdirMode: 0o700 });
  }

  return {
    async read(botId: string, taskId: string): Promise<BotRoutineNotes> {
      return (await load(botId))[taskId] ?? {};
    },

    async render(botId: string, taskId: string): Promise<string> {
      return renderBotRoutineNotes((await load(botId))[taskId] ?? {});
    },

    /** Set one note. A write over a cap changes nothing and returns `notes_full`. */
    set(botId: string, taskId: string, key: unknown, value: unknown): Promise<BotRoutineNotesWriteResult> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const current = routines[taskId] ?? {};
        if (!validKey(key)) {
          return { ok: false, code: "invalid", error: `A note key is 1 to ${BOT_ROUTINE_NOTES_LIMITS.keyChars} characters on one line.`, notes: current };
        }
        if (typeof value !== "string" || [...value].length > BOT_ROUTINE_NOTES_LIMITS.valueChars) {
          return { ok: false, code: "invalid", error: `A note value is at most ${BOT_ROUTINE_NOTES_LIMITS.valueChars} characters.`, notes: current };
        }
        const next: BotRoutineNotes = { ...current, [key]: { value, updatedAt: now() } };
        if (Object.keys(next).length > BOT_ROUTINE_NOTES_LIMITS.keys || totalBytes(next) > BOT_ROUTINE_NOTES_LIMITS.totalBytes) {
          return {
            ok: false,
            code: "notes_full",
            error: `This routine's notes are full (${BOT_ROUTINE_NOTES_LIMITS.keys} notes, ${BOT_ROUTINE_NOTES_LIMITS.totalBytes} bytes). Delete or shorten a note first.`,
            notes: current,
          };
        }
        await save(botId, { ...routines, [taskId]: next });
        return { ok: true, notes: next };
      });
    },

    delete(botId: string, taskId: string, key: unknown): Promise<BotRoutineNotesWriteResult> {
      return serial(botId, async () => {
        const routines = await load(botId);
        const current = routines[taskId] ?? {};
        if (typeof key !== "string" || !(key in current)) return { ok: true, notes: current };
        const next = { ...current };
        delete next[key];
        const rest = { ...routines };
        if (Object.keys(next).length === 0) delete rest[taskId];
        else rest[taskId] = next;
        await save(botId, rest);
        return { ok: true, notes: next };
      });
    },

    /** Forget one routine's notes (the routine was deleted). */
    clear(botId: string, taskId: string): Promise<void> {
      return serial(botId, async () => {
        const routines = await load(botId);
        if (!(taskId in routines)) return;
        const rest = { ...routines };
        delete rest[taskId];
        await save(botId, rest);
      });
    },
  };
}

export type BotRoutineNotesStore = ReturnType<typeof createBotRoutineNotesStore>;

function json(value: unknown): AgentToolResult<null> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: null };
}

/**
 * The `routine_notes` tool, bound per call to the routine whose run is
 * calling it. `taskId()` resolves that routine; `undefined` means the call is
 * not part of a routine run and nothing is written.
 */
export function createRoutineNotesTool(options: {
  botId: string;
  notes: Pick<BotRoutineNotesStore, "set" | "delete">;
  taskId(): Promise<string | undefined>;
}): AgentTool {
  return {
    name: ROUTINE_NOTES_TOOL_NAME,
    label: "Routine notes",
    description:
      "Keep short notes for this routine's next run, like what you already reported. They appear at the top of the routine's message next time. Only available while a routine runs. action \"set\" needs key and value; \"delete\" needs key.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("set"), Type.Literal("delete")]),
        key: Type.String({ minLength: 1, maxLength: BOT_ROUTINE_NOTES_LIMITS.keyChars }),
        value: Type.Optional(Type.String({ maxLength: BOT_ROUTINE_NOTES_LIMITS.valueChars })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams): Promise<AgentToolResult<null>> {
      const params = (rawParams ?? {}) as { action?: unknown; key?: unknown; value?: unknown };
      const taskId = await options.taskId();
      if (taskId === undefined) {
        return json({ ok: false, code: "unavailable", error: "Routine notes are only available while a routine runs." });
      }
      const outcome =
        params.action === "set" && typeof params.value === "string"
          ? await options.notes.set(options.botId, taskId, params.key, params.value)
          : params.action === "delete" && params.value === undefined
            ? await options.notes.delete(options.botId, taskId, params.key)
            : ({ ok: false, code: "invalid", error: "Use set with key and value, or delete with key.", notes: {} } as const);
      const notes = Object.fromEntries(Object.entries(outcome.notes).map(([key, note]) => [key, note.value]));
      return json(outcome.ok ? { ok: true, notes } : { ok: false, code: outcome.code, error: outcome.error, notes });
    },
  };
}
