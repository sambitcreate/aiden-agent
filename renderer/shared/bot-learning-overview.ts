// The "What I've learned" page's data (spec 2026-10-27 §7 L5).

import type { BotLearningChange } from "./bot-learning.js";
import type { BotLesson } from "./bot-lessons.js";

export interface BotLearningOverview {
  lessons: BotLesson[];
  changes: BotLearningChange[];
  followUps: Array<{ id: string; text: string; dueDate: string; status: string }>;
  budget: { requests: number; outputTokens: number };
}
