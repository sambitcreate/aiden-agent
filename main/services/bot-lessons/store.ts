// Lessons per Bot in `<profile>/bots/<dir>/lessons.json`. Text is scanned like
// memory and stays below the Bot's authority when rendered.

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BOT_LESSON_COMPONENTS,
  BOT_LESSON_LIMITS,
  type BotLesson,
  type BotLessonScope,
  type BotLessonStatus,
} from "../../../renderer/shared/bot-lessons.js";
import { scanMemoryText } from "../bot-memory/scan.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_LESSONS_FILE = "lessons.json";
const KEPT_CLOSED = 100;

export type BotLessonAddInput = Omit<BotLesson, "id" | "botId" | "createdAt" | "status" | "decidedAt"> & { status: "proposed" | "active" };

export interface BotLessonStore {
  add(botId: string, input: BotLessonAddInput): Promise<{ ok: true; lesson: BotLesson; retired: BotLesson[] } | { ok: false; code: "blocked" | "full" | "invalid" | "duplicate"; error: string }>;
  setStatus(botId: string, id: string, status: BotLessonStatus): Promise<BotLesson | undefined>;
  list(botId: string, filter?: { scope?: BotLessonScope; status?: BotLessonStatus }): Promise<BotLesson[]>;
  revision(botId: string): Promise<string>;
  forgetRoutine(botId: string, routineId: string): Promise<void>;
}

function sameScope(a: BotLessonScope, b: BotLessonScope): boolean {
  return a.kind === b.kind && (a.kind === "bot" || (b.kind === "routine" && a.routineId === b.routineId));
}

function normalized(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function createBotLessonStore(options: { profileDir(): string; now?(): number; newId?(): string }): BotLessonStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir(), botId), BOT_LESSONS_FILE);

  async function load(botId: string): Promise<BotLesson[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as BotLesson[]).filter((lesson) => lesson?.botId === botId && typeof lesson.id === "string") : [];
    } catch {
      return [];
    }
  }

  async function save(botId: string, lessons: BotLesson[]): Promise<void> {
    const open = lessons.filter((lesson) => lesson.status === "active" || lesson.status === "proposed");
    const closed = lessons.filter((lesson) => !open.includes(lesson)).slice(-KEPT_CLOSED);
    await writeJsonAtomic(fileOf(botId), lessons.filter((lesson) => open.includes(lesson) || closed.includes(lesson)), { mode: 0o600, mkdirMode: 0o700 });
  }

  return {
    add(botId, input) {
      return serial(botId, async () => {
        const cue = input.cue.trim();
        const lesson = input.lesson.trim();
        if (!lesson || [...lesson].length > BOT_LESSON_LIMITS.lessonChars || [...cue].length > BOT_LESSON_LIMITS.cueChars) {
          return { ok: false, code: "invalid", error: `A lesson is at most ${BOT_LESSON_LIMITS.lessonChars} characters, its cue at most ${BOT_LESSON_LIMITS.cueChars}.` };
        }
        if (!BOT_LESSON_COMPONENTS.includes(input.component)) return { ok: false, code: "invalid", error: "Unknown lesson component." };
        for (const text of [cue, lesson]) {
          const scan = scanMemoryText(text);
          if (!scan.ok) return { ok: false, code: "blocked", error: `This lesson was blocked: ${scan.threat}.` };
        }
        const lessons = await load(botId);
        const open = lessons.filter((entry) => (entry.status === "active" || entry.status === "proposed") && sameScope(entry.scope, input.scope));
        if (open.some((entry) => normalized(entry.lesson) === normalized(lesson))) return { ok: false, code: "duplicate", error: "That lesson is already noted." };
        if (input.status === "proposed" && lessons.filter((entry) => entry.status === "proposed").length >= BOT_LESSON_LIMITS.proposedPerBot) {
          return { ok: false, code: "full", error: "The person has lessons to answer already." };
        }
        const created: BotLesson = {
          ...input,
          id: newId(),
          botId,
          cue,
          lesson,
          evidence: input.evidence.slice(0, BOT_LESSON_LIMITS.evidence),
          createdAt: now(),
          ...(input.status === "active" ? { decidedAt: now() } : {}),
        };
        const retired: BotLesson[] = [];
        let next = [...lessons, created];
        if (input.status === "active") {
          const cap = input.scope.kind === "routine" ? BOT_LESSON_LIMITS.activePerRoutine : BOT_LESSON_LIMITS.activeBotWide;
          const active = next.filter((entry) => entry.status === "active" && sameScope(entry.scope, input.scope));
          for (const old of active.slice(0, Math.max(0, active.length - cap))) {
            const done = { ...old, status: "retired" as const, decidedAt: now() };
            retired.push(done);
            next = next.map((entry) => (entry.id === old.id ? done : entry));
          }
        }
        await save(botId, next);
        return { ok: true, lesson: created, retired };
      });
    },

    setStatus(botId, id, status) {
      return serial(botId, async () => {
        const lessons = await load(botId);
        const index = lessons.findIndex((lesson) => lesson.id === id);
        if (index < 0) return undefined;
        const next = { ...lessons[index]!, status, decidedAt: now() };
        lessons[index] = next;
        await save(botId, lessons);
        return next;
      });
    },

    async list(botId, filter = {}) {
      return (await load(botId)).filter((lesson) =>
        (!filter.status || lesson.status === filter.status) && (!filter.scope || sameScope(lesson.scope, filter.scope)));
    },

    async revision(botId) {
      const active = (await load(botId)).filter((lesson) => lesson.status === "active").map((lesson) => `${lesson.id}\0${lesson.lesson}`).sort();
      return createHash("sha256").update(active.join("\n")).digest("hex").slice(0, 16);
    },

    forgetRoutine(botId, routineId) {
      return serial(botId, async () => {
        const lessons = await load(botId);
        await save(botId, lessons.filter((lesson) => !(lesson.scope.kind === "routine" && lesson.scope.routineId === routineId)));
      });
    },
  };
}
