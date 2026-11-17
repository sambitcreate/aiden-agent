// The shared budget on a Bot's own suggestions (docs/plans/bot-ux-simplification.md
// §4.7): routines, skills and lessons it offers on its own count together, at
// most three in any rolling 24 hours per Bot. Each kind keeps its own waiting
// limit and back-off; this caps how often the chat is offered anything at all.
// One the person asked for in their own message (`always`) is never held back
// but still counts; a follow-up the host queued for a promise is not offered
// through the budget at all.

import { promises as fs } from "node:fs";
import path from "node:path";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_SUGGESTION_BUDGET = { perWindow: 3, windowMs: 24 * 60 * 60 * 1000 } as const;

/** What the Bot's tool hears when the window is full. */
export const BOT_SUGGESTION_LIMIT_MESSAGE =
  "You've reached today's limit on your own suggestions. Don't offer another routine, skill or lesson today; the person can add one themselves in your profile.";

export type BotSuggestionKind = "routine" | "skill" | "lesson";

export interface BotSuggestionBudget {
  /**
   * Runs `offer` only while the Bot has a suggestion left; `offer` reports
   * whether one was actually shown, and only then is it counted. Returns
   * false, without calling `offer`, when the window is full. With `always`
   * (the person asked for it) it runs even when the window is full, and a
   * shown one still counts.
   */
  offer(botId: string, kind: BotSuggestionKind, offer: () => Promise<boolean>, options?: { always?: boolean }): Promise<boolean>;
  /** How many the Bot may still offer now. */
  remaining(botId: string): Promise<number>;
}

const FILE = "suggestion-budget.json";

export function createBotSuggestionBudget(deps: { profileDir(): string; now(): number }): BotSuggestionBudget {
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(deps.profileDir(), botId), FILE);

  /**
   * When each counted suggestion was shown, inside the window only. A time
   * after now (the clock was moved back) is read as now, so it stays counted
   * until the clock passes it and a window more, never refilling the budget.
   */
  async function load(botId: string): Promise<number[]> {
    const now = deps.now();
    const since = now - BOT_SUGGESTION_BUDGET.windowMs;
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as { shown?: unknown };
      if (Array.isArray(parsed.shown)) {
        return parsed.shown
          .filter((at): at is number => typeof at === "number" && Number.isFinite(at))
          .map((at) => Math.min(at, now))
          .filter((at) => at > since);
      }
    } catch {
      // A missing or unreadable file starts a fresh window.
    }
    return [];
  }

  return {
    offer(botId, _kind, offer, options) {
      return serial(botId, async () => {
        const shown = await load(botId);
        if (shown.length >= BOT_SUGGESTION_BUDGET.perWindow && options?.always !== true) return false;
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
