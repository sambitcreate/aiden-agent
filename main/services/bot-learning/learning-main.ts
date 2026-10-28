// Production wiring of Bot learning (spec 2026-10-27 §7): lessons, the
// learning history with Undo, the daily budget, routine reflection,
// corrections and memory tidying. Everything runs on the Bot's own admitted
// model; nothing runs at startup.

import { app, logger } from "../../platform.js";
import type { BotMemoryTarget } from "../../../renderer/shared/bot-memory.js";
import {
  BOT_LESSON_STATUS_ENTRY_KIND,
  type BotLesson,
} from "../../../renderer/shared/bot-lessons.js";
import type { BotLearningTarget } from "../../../renderer/shared/bot-learning.js";
import { botMemory } from "../bot-memory/bot-memory-main.js";
import { storeView } from "../bot-memory/store.js";
import type { MemoryReviewExtras } from "../bot-memory/review.js";
import { BOT_MEMORY_TIDY, needsMemoryTidy, proposeMemoryTidy } from "../bot-memory/tidy.js";
import { createNoteHowToTool, NOTE_HOW_TO_INSTRUCTIONS } from "../bot-lessons/how-to-tool.js";
import { createBotLessonStore } from "../bot-lessons/store.js";
import { botSessionDirectory } from "../bot-routine-notes.js";
import { scheduleStore } from "../schedule-store.js";
import type { ScheduledRun, ScheduledTask } from "../types.js";
import { createBotLearningBudget } from "./budget.js";
import { botBehaviorFingerprint } from "./fingerprint.js";
import { createBotLearningHistory } from "./history.js";
import { restoreSkillFile } from "./restore-skill.js";
import { createRoutineReflection } from "./routine-reflection.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const profileDir = () => app.getPath("userData");
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const botLessons = createBotLessonStore({ profileDir });
export const botLearningBudget = createBotLearningBudget({ profileDir, timeZone, now: Date.now });

async function appendEntry(botId: string, kind: string, data: Record<string, unknown>): Promise<void> {
  const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
  await (await botSessionRuntime()).appendEntry(botId, kind, data as never);
}

/** The Bot's behavior fingerprint now (spec §4.4). */
export async function botFingerprint(botId: string): Promise<string> {
  const [{ botStore }, { botSkillApprovals }, view, lessonsRevision] = await Promise.all([
    import("../bot-store.js"),
    import("../bot-capability-services-main.js"),
    botMemory.view(botId),
    botLessons.revision(botId),
  ]);
  const bot = await botStore.get(botId);
  const approved = await botSkillApprovals.list(botId);
  return botBehaviorFingerprint({
    botRevision: bot?.revision ?? "",
    memoryRevision: view.revision,
    lessonsRevision,
    skills: Object.keys(approved).map((fingerprint) => ({ name: fingerprint.slice(0, 12), contentFingerprint: fingerprint })),
    appVersion: app.getVersion(),
  });
}

function memoryText(view: Awaited<ReturnType<typeof botMemory.view>>): string {
  return JSON.stringify({ memory: view.memory.entries.map(({ text }) => text), user: view.user.entries.map(({ text }) => text) });
}

type MemorySnapshot = Record<BotMemoryTarget, string[]>;

function parseSnapshot(content: string | null): MemorySnapshot {
  const parsed = content ? (JSON.parse(content) as Partial<MemorySnapshot>) : {};
  return { memory: parsed.memory ?? [], user: parsed.user ?? [] };
}

/**
 * Turn memory from `expected` back into `content`, one store at a time. Each
 * store is checked against `expected` under the memory write lock, so an
 * edit made since is never overwritten: that store (and any after it) is
 * left alone and the restore reports false.
 */
async function restoreMemory(botId: string, content: string | null, expected: string | null, assertCurrent?: () => Promise<void>): Promise<boolean> {
  const desired = parseSnapshot(content);
  const seen = parseSnapshot(expected);
  for (const target of ["memory", "user"] as const) {
    const current = seen[target];
    const want = desired[target];
    if (JSON.stringify(current) === JSON.stringify(want)) continue;
    const removals = current.filter((text) => !want.includes(text)).map((text) => ({ action: "remove" as const, match: text }));
    const additions = want.filter((text) => !current.includes(text)).map((text) => ({ action: "add" as const, content: text }));
    if (!removals.length && !additions.length) continue;
    const result = await botMemory.apply(botId, target, [...removals, ...additions], { expectTexts: current, ...(assertCurrent ? { assertCurrent } : {}) });
    if (!result.ok) {
      if (result.code === "changed") return false;
      throw new Error(result.error);
    }
  }
  botMemory.markStale(botId);
  return true;
}

async function skillFile(botId: string, name: string): Promise<string> {
  const { botManagedWorkspace } = await import("../bot-capability-services-main.js");
  return path.join((await botManagedWorkspace.resolve(botId)).homePath, ".aiden", "skills", name, "SKILL.md");
}

export const botLearningHistory = createBotLearningHistory({
  profileDir,
  fingerprint: botFingerprint,
  async current(botId, target) {
    if (target.kind === "memory") return memoryText(await botMemory.view(botId));
    if (target.kind === "lesson") {
      const lesson = (await botLessons.list(botId)).find((entry) => entry.id === target.lessonId);
      return lesson?.status === "active" ? lesson.lesson : null;
    }
    return fs.readFile(await skillFile(botId, target.name), "utf8").catch(() => null);
  },
  async apply(botId, target, content, expected) {
    if (target.kind === "memory") return restoreMemory(botId, content, expected);
    if (target.kind === "lesson") {
      const status = content === null ? "retired" : "active";
      await botLessons.setStatus(botId, target.lessonId, status);
      // The chat's Learned line and lesson card follow the page.
      await appendEntry(botId, BOT_LESSON_STATUS_ENTRY_KIND, { lessonId: target.lessonId, status }).catch(() => undefined);
      return true;
    }
    const file = await skillFile(botId, target.name);
    const { invalidateBotSkills } = await import("../bot-capability-services-main.js");
    if (!(await restoreSkillFile(file, content, expected))) return false;
    invalidateBotSkills();
    return true;
  },
});

/** A memory review add, recorded so it can be undone. */
export async function recordMemoryChange(botId: string, kind: "memory_review" | "memory_tidy", before: string, summary: string): Promise<void> {
  const after = memoryText(await botMemory.view(botId));
  if (after === before) return;
  await botLearningHistory.record({ botId, kind, summary, target: { kind: "memory" }, before, after });
}

export async function memorySnapshotText(botId: string): Promise<string> {
  return memoryText(await botMemory.view(botId));
}

async function recordLesson(botId: string, lesson: BotLesson, retired: readonly BotLesson[]): Promise<void> {
  await botLearningHistory.record({ botId, kind: "lesson_added", summary: `Learned: ${lesson.lesson}`, target: { kind: "lesson", lessonId: lesson.id }, before: null, after: lesson.lesson });
  for (const old of retired) {
    await botLearningHistory.record({ botId, kind: "lesson_removed", summary: `Retired: ${old.lesson}`, target: { kind: "lesson", lessonId: old.id }, before: old.lesson, after: null });
  }
}

/** A Bot-proposed skill was added: one undoable change. */
export async function recordBotSkillAdded(botId: string, change: { name: string; before: string | null; after: string }): Promise<void> {
  await botLearningHistory.record({ botId, kind: "skill_added", summary: `Added skill ${change.name}`, target: { kind: "skill", name: change.name }, before: change.before, after: change.after });
}

/** The memory review's extra tool for corrections. */
export function howToReviewExtras(botId: string): MemoryReviewExtras {
  return {
    tools: [createNoteHowToTool({ botId, lessons: botLessons, appendEntry, recorded: recordLesson })],
    instructions: [...NOTE_HOW_TO_INSTRUCTIONS],
  };
}

const reflectionState = {
  async lastReflected(taskId: string): Promise<number | undefined> {
    return reflectionMarks.get(taskId);
  },
  async set(taskId: string, at: number): Promise<void> {
    reflectionMarks.set(taskId, at);
    await persistMarks();
  },
};
const reflectionMarks = new Map<string, number>();
const marksFile = () => path.join(profileDir(), "bots", ".routine-reflections.json");
let marksLoaded: Promise<void> | undefined;
async function loadMarks(): Promise<void> {
  marksLoaded ??= fs.readFile(marksFile(), "utf8").then((text) => {
    for (const [taskId, at] of Object.entries(JSON.parse(text) as Record<string, unknown>)) {
      if (typeof at === "number") reflectionMarks.set(taskId, at);
    }
  }).catch(() => undefined);
  await marksLoaded;
}
async function persistMarks(): Promise<void> {
  const { writeJsonAtomic } = await import("../durable-fs.js");
  await writeJsonAtomic(marksFile(), Object.fromEntries(reflectionMarks), { mode: 0o600, mkdirMode: 0o700 });
}

const reflection = createRoutineReflection({
  runs: (taskId) => scheduleStore.runs(taskId),
  notes: async (botId, taskId) => (await import("../scheduled-bot-routines-main.js")).botRoutineNotes.render(botId, taskId),
  lessons: botLessons,
  budget: botLearningBudget,
  admit: async (botId) => (await import("../bot-runtime/bot-session-main.js")).admitMemoryWork(botId),
  appendEntry,
  state: reflectionState,
});

/** After a routine run is recorded: maybe reflect on its recent runs. */
export async function afterRoutineRunForLearning(task: ScheduledTask, run: ScheduledRun): Promise<void> {
  await loadMarks();
  const outcome = await reflection.afterRun(task, run);
  if (outcome === "failed") logger.warn("bots", `Routine ${task.id} reflection did not finish.`);
}

/** The person answered a lesson card: keep it (or, for "stop", retire its target). */
export async function respondToLesson(botId: string, lessonId: string, decision: "keep" | "dismiss"): Promise<"active" | "dismissed"> {
  const lesson = (await botLessons.list(botId)).find((entry) => entry.id === lessonId);
  if (!lesson) throw new Error("This lesson is no longer available.");
  if (lesson.status !== "proposed") return lesson.status === "active" ? "active" : "dismissed";
  const status = decision === "keep" ? "active" : "dismissed";
  if (decision === "keep" && lesson.retires) {
    const target = await botLessons.setStatus(botId, lesson.retires, "retired");
    if (target) await botLearningHistory.record({ botId, kind: "lesson_removed", summary: `Stopped: ${target.lesson}`, target: { kind: "lesson", lessonId: target.id }, before: target.lesson, after: null });
    await botLessons.setStatus(botId, lessonId, "dismissed");
  } else {
    await botLessons.setStatus(botId, lessonId, status);
    if (status === "active") await recordLesson(botId, { ...lesson, status: "active" }, []);
  }
  await appendEntry(botId, BOT_LESSON_STATUS_ENTRY_KIND, { lessonId, status });
  return status;
}

/** Remove an active lesson from the learning page. */
export async function removeLesson(botId: string, lessonId: string): Promise<void> {
  const lesson = await botLessons.setStatus(botId, lessonId, "retired");
  if (lesson) await botLearningHistory.record({ botId, kind: "lesson_removed", summary: `Removed: ${lesson.lesson}`, target: { kind: "lesson", lessonId }, before: lesson.lesson, after: null });
  await appendEntry(botId, BOT_LESSON_STATUS_ENTRY_KIND, { lessonId, status: "retired" }).catch(() => undefined);
}

const lastTidy = new Map<string, number>();
const tidying = new Set<string>();

/** When memory is nearly full: one tidy pass, at most once a day, within the budget. */
export async function maybeTidyMemory(botId: string): Promise<"not_needed" | "too_soon" | "busy" | "budget" | "tidied" | "unchanged" | "failed"> {
  if (tidying.has(botId)) return "busy";
  const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
  if ((await (await botSessionRuntime()).state(botId)).kind !== "idle") return "busy";
  if (Date.now() - (lastTidy.get(botId) ?? 0) < BOT_MEMORY_TIDY.minIntervalMs) return "too_soon";
  const view = await botMemory.view(botId);
  const targets = needsMemoryTidy(view);
  if (!targets.length) return "not_needed";
  tidying.add(botId);
  try {
    const reserved = await botLearningBudget.reserve(botId, "tidy", BOT_MEMORY_TIDY.maxTokens);
    if (!reserved.ok) return "budget";
    lastTidy.set(botId, Date.now());
    const { admitMemoryWork } = await import("../bot-runtime/bot-session-main.js");
    const admission = await admitMemoryWork(botId);
    if (!admission.ok) {
      await reserved.settle(0);
      return "failed";
    }
    try {
      const target = targets[0]!;
      const operations = await proposeMemoryTidy(admission, view, target, AbortSignal.any([AbortSignal.timeout(60_000), admission.lease.signal]));
      await reserved.settle(undefined);
      if (!operations) return "unchanged";
      await admission.lease.revalidate();
      // The person may have edited memory during the model call: never tidy
      // (or later undo) over their change. Abandon when it moved.
      const fresh = await botMemory.view(botId);
      if (fresh.revision !== view.revision) return "unchanged";
      const usedBefore = fresh[target].usedChars;
      const fence = () => admission.lease.revalidate();
      // Checked again under the write lock: an edit since `fresh` wins.
      const result = await botMemory.apply(botId, target, operations, {
        expectTexts: fresh[target].entries.map(({ text }) => text),
        assertCurrent: fence,
      });
      if (!result.ok) return "unchanged";
      // The state the guarded write produced, read inside the same write
      // lock: a later edit must never become part of what Undo restores over.
      const written = JSON.stringify({ memory: result.loaded.stores.memory.texts, user: result.loaded.stores.user.texts });
      if (storeView(result.loaded, target).usedChars >= usedBefore) {
        // Not smaller: put back what was there, unless someone edited since.
        await restoreMemory(botId, memoryText(fresh), written, fence);
        return "unchanged";
      }
      const change = await botLearningHistory.record({ botId, kind: "memory_tidy", summary: "Tidied memory", target: { kind: "memory" }, before: memoryText(fresh), after: written });
      await appendEntry(botId, "aiden.memory-tidy", { targets: [target], changeId: change.id }).catch(() => undefined);
      return "tidied";
    } finally {
      admission.lease.release();
    }
  } catch (error) {
    logger.warn("bots", `Bot ${botId} memory tidy failed.`, error);
    return "failed";
  } finally {
    tidying.delete(botId);
  }
}

export type { BotLearningOverview } from "../../../renderer/shared/bot-learning-overview.js";
import type { BotLearningOverview } from "../../../renderer/shared/bot-learning-overview.js";

export async function botLearningOverview(botId: string): Promise<BotLearningOverview> {
  const { botCommitments } = await import("../bot-commitments/commitments-main.js");
  const [lessons, changes, commitments, budget] = await Promise.all([
    botLessons.list(botId, { status: "active" }),
    botLearningHistory.list(botId),
    botCommitments.list(botId),
    botLearningBudget.today(botId),
  ]);
  return {
    lessons,
    changes: changes.slice(0, 20),
    followUps: commitments.filter((entry) => entry.status === "waiting" || entry.status === "proposed").map(({ id, text, dueDate, status }) => ({ id, text, dueDate, status })),
    budget,
  };
}

export async function undoBotLearning(botId: string, changeId: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const result = await botLearningHistory.undo(botId, changeId);
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}

/** For the Learning page's Bot folder (kept here so the page never needs a path). */
export function botLearningDirectory(botId: string): string {
  return botSessionDirectory(profileDir(), botId);
}

export type { BotLearningTarget };
