// The daily cap on background learning per Bot (spec §3 D6): 12 model
// requests and 24,000 output tokens per local day, shared by the memory
// review, routine reflection and memory tidying.

import { promises as fs } from "node:fs";
import path from "node:path";
import { BOT_LEARNING_DAILY_LIMITS } from "../../../renderer/shared/bot-learning.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export type BotLearningJob = "review" | "reflection" | "tidy";

export interface BotLearningBudget {
  reserve(botId: string, job: BotLearningJob, maxTokens: number): Promise<{ ok: true; settle(outputTokens: number | undefined): Promise<void> } | { ok: false; reason: "daily_limit" }>;
  today(botId: string): Promise<{ requests: number; outputTokens: number }>;
}

function dayKey(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

export function createBotLearningBudget(deps: { profileDir(): string; timeZone(): string; now(): number }): BotLearningBudget {
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(deps.profileDir(), botId), "learning-budget.json");

  async function load(botId: string): Promise<{ day: string; requests: number; outputTokens: number }> {
    const day = dayKey(deps.now(), deps.timeZone());
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as { day?: unknown; requests?: unknown; outputTokens?: unknown };
      if (parsed.day === day && typeof parsed.requests === "number" && typeof parsed.outputTokens === "number") {
        return { day, requests: parsed.requests, outputTokens: parsed.outputTokens };
      }
    } catch {
      // A missing or unreadable file is a fresh day.
    }
    return { day, requests: 0, outputTokens: 0 };
  }

  return {
    reserve(botId, _job, maxTokens) {
      return serial(botId, async () => {
        const state = await load(botId);
        if (state.requests >= BOT_LEARNING_DAILY_LIMITS.requests || state.outputTokens >= BOT_LEARNING_DAILY_LIMITS.outputTokens) {
          return { ok: false as const, reason: "daily_limit" as const };
        }
        // Count the request now; its tokens once it answers. Unknown usage counts as its cap.
        await writeJsonAtomic(fileOf(botId), { ...state, requests: state.requests + 1 }, { mode: 0o600, mkdirMode: 0o700 });
        return {
          ok: true as const,
          settle: (outputTokens: number | undefined) => serial(botId, async () => {
            const current = await load(botId);
            await writeJsonAtomic(fileOf(botId), { ...current, outputTokens: current.outputTokens + (outputTokens ?? maxTokens) }, { mode: 0o600, mkdirMode: 0o700 });
          }),
        };
      });
    },
    async today(botId) {
      const { requests, outputTokens } = await load(botId);
      return { requests, outputTokens };
    },
  };
}
