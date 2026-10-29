// How-to lessons a Bot learned (spec 2026-10-27 §7 L1, L3), kept apart from
// facts about the person. Routine lessons come from reviewing its runs and
// need the person's OK; Bot-wide lessons come from the person's corrections.

export type BotLessonScope = { kind: "routine"; routineId: string } | { kind: "bot" };
export type BotLessonComponent = "routine_prompt" | "procedure" | "tool_use" | "output_format";
export type BotLessonVerdict = "helped" | "hurt" | "no_effect" | "confounded";
export type BotLessonSource = "reflection" | "correction";
export type BotLessonStatus = "proposed" | "active" | "dismissed" | "retired";

export interface BotLesson {
  id: string;
  botId: string;
  scope: BotLessonScope;
  cue: string;
  lesson: string;
  component: BotLessonComponent;
  /** Run or entry ids the lesson rests on. */
  evidence: string[];
  verdict: BotLessonVerdict;
  source: BotLessonSource;
  status: BotLessonStatus;
  createdAt: number;
  decidedAt?: number;
  /** A "stop doing this" lesson names the lesson it retires. */
  retires?: string;
}

export const BOT_LESSON_LIMITS = { cueChars: 160, lessonChars: 300, evidence: 8, activePerRoutine: 6, activeBotWide: 12, proposedPerBot: 2 } as const;
export const BOT_LESSON_PROPOSAL_ENTRY_KIND = "aiden.lesson-proposal";
export const BOT_LESSON_STATUS_ENTRY_KIND = "aiden.lesson-status";
export const BOT_LESSON_LEARNED_ENTRY_KIND = "aiden.lesson-learned";
export const BOT_LESSON_COMPONENTS: readonly BotLessonComponent[] = ["routine_prompt", "procedure", "tool_use", "output_format"];

/** What a lesson card or Learned line shows. */
export interface BotLessonCardData {
  lessonId: string;
  lesson: string;
  routineName?: string;
  runs?: number;
}

export function botLessonCardOf(value: unknown): BotLessonCardData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.lessonId !== "string" || typeof data.lesson !== "string") return null;
  return {
    lessonId: data.lessonId,
    lesson: data.lesson.slice(0, 400),
    ...(typeof data.routineName === "string" ? { routineName: data.routineName.slice(0, 200) } : {}),
    ...(typeof data.runs === "number" && Number.isInteger(data.runs) ? { runs: data.runs } : {}),
  };
}

export function botLessonStatusOf(value: unknown): { lessonId: string; status: "active" | "dismissed" | "retired" } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.lessonId !== "string") return null;
  if (data.status !== "active" && data.status !== "dismissed" && data.status !== "retired") return null;
  return { lessonId: data.lessonId, status: data.status };
}
