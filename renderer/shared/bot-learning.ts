// What a Bot learned, as one history with Undo (spec 2026-10-27 §7 L5).

export type BotLearningChangeKind = "memory_review" | "memory_tidy" | "lesson_added" | "lesson_removed" | "skill_added";
export type BotLearningTarget =
  | { kind: "memory" }
  | { kind: "lesson"; lessonId: string }
  | { kind: "skill"; name: string };

export interface BotLearningChange {
  id: string;
  botId: string;
  at: number;
  kind: BotLearningChangeKind;
  summary: string;
  target: BotLearningTarget;
  before: string | null;
  after: string | null;
  fingerprintBefore: string;
  fingerprintAfter: string;
  undoneAt?: number;
  undoOf?: string;
}

export const BOT_LEARNING_HISTORY_LIMITS = { changes: 100, bytes: 1_048_576, summaryChars: 160 } as const;
export const BOT_LEARNING_DAILY_LIMITS = { requests: 12, outputTokens: 24_000 } as const;

export const BOT_LEARNING_CHANNELS = {
  get: "bots:learning:get",
  undo: "bots:learning:undo",
  respondLesson: "bots:lessons:respond",
  removeLesson: "bots:lessons:remove",
} as const;
