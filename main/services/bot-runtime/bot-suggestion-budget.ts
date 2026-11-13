// The shared budget on a Bot's own suggestions (docs/plans/bot-ux-simplification.md
// §4.7): routines, skills and lessons it offers on its own count together, at
// most three in any rolling 24 hours per Bot. Each kind keeps its own waiting
// limit and back-off; this caps how often the chat is offered anything at all.
// A suggestion the person asked for, and a follow-up the host queued for a
// promise, never count and are never held back.

import { promises as fs } from "node:fs";
import path from "node:path";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_SUGGESTION_BUDGET = { perWindow: 3, windowMs: 24 * 60 * 60 * 1000 } as const;

/** What the Bot's tool hears when the window is full. */
export const BOT_SUGGESTION_LIMIT_MESSAGE =
  "You've made enough suggestions for now. Don't suggest a routine, skill or lesson again today unless the person asks; they can add one themselves in your profile.";

export type BotSuggestionKind = "routine" | "skill" | "lesson";

export interface BotSuggestionBudget {
  /**
   * Runs `offer` only while the Bot has a suggestion left; `offer` reports
   * whether one was actually shown, and only then is it counted. Returns
   * false, without calling `offer`, when the window is full.
   */
  offer(botId: string, kind: BotSuggestionKind, offer: () => Promise<boolean>): Promise<boolean>;
  /** How many the Bot may still offer now. */
  remaining(botId: string): Promise<number>;
}

const FILE = "suggestion-budget.json";

export function createBotSuggestionBudget(deps: { profileDir(): string; now(): number }): BotSuggestionBudget {
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(deps.profileDir(), botId), FILE);

  /** When each counted suggestion was shown, inside the window only. */
  async function load(botId: string): Promise<number[]> {
    const since = deps.now() - BOT_SUGGESTION_BUDGET.windowMs;
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as { shown?: unknown };
      if (Array.isArray(parsed.shown)) {
        return parsed.shown.filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at > since && at <= deps.now());
      }
    } catch {
      // A missing or unreadable file starts a fresh window.
    }
    return [];
  }

  return {
    offer(botId, _kind, offer) {
      return serial(botId, async () => {
        const shown = await load(botId);
        if (shown.length >= BOT_SUGGESTION_BUDGET.perWindow) return false;
        if (!(await offer())) return false;
        await writeJsonAtomic(fileOf(botId), { shown: [...shown, deps.now()] }, { mode: 0o600, mkdirMode: 0o700 });
        return true;
      });
    },
    async remaining(botId) {
      return Math.max(0, BOT_SUGGESTION_BUDGET.perWindow - (await load(botId)).length);
    },
  };
}
