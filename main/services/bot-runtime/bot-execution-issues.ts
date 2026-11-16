import type { BotIssueService } from "../bot-issues/service.js";
import type { SpendingService } from "../spending-service.js";
import type { BotExecutionClaim } from "../bot-routine-models.js";
import { botExecutionSpendingOwner } from "./bot-execution-spending.js";

/**
 * Quiet tries before a blocked run asks the person. A model or sign-in that
 * isn't ready yet (often just after Aiden opens) usually is a few seconds
 * later, so the run is resumed on its own three times over about two minutes.
 * Only then does "Review this run before resuming" appear.
 */
export const BOT_EXECUTION_RETRY_DELAYS_MS = [20_000, 40_000, 60_000] as const;

/** What one quiet try found. */
export type BotExecutionRetryResult =
  /** Resume went through; if the run blocks again, that counts as the next try. */
  | "resumed"
  /** The run is no longer waiting on this block (resumed, dismissed, paused, gone): stop trying. */
  | "moot"
  /** Resume was refused: the block still stands. */
  | "failed";

export interface BotExecutionIssueOptions {
  /** Resume the Bot's interrupted run once, as the person's Resume would. */
  retry?(botId: string, claim: BotExecutionClaim, attempt: number): Promise<BotExecutionRetryResult>;
  setTimer?(fn: () => void, ms: number): { cancel(): void };
  onError?(botId: string, error: unknown): void;
}

/** One actionable cost obligation can block later work without creating duplicate cards. */
export function createBotExecutionIssues(
  issues: Pick<BotIssueService, "raise" | "resolve">,
  spending: Pick<SpendingService, "pendingDispatch">,
  options: BotExecutionIssueOptions = {},
) {
  /** Per claim: quiet tries already scheduled, and the one waiting to run. */
  const retries = new Map<string, { attempts: number; timer?: { cancel(): void } }>();

  function forget(claimId: string): void {
    retries.get(claimId)?.timer?.cancel();
    retries.delete(claimId);
  }

  async function raise(botId: string, claim: BotExecutionClaim, message: string, dispatchId?: string): Promise<void> {
    await issues.raise({ botId, kind: "preflight_failed", dedupeKey: dispatchId ? `execution-cost:${dispatchId}` : `execution:${claim.id}`, title: "Review this run before resuming", body: message, ...(claim.routineId ? { routineId: claim.routineId } : {}), actions: [{ kind: "open_chat" }] });
  }

  async function blocked(botId: string, claim: BotExecutionClaim, message: string, kind: "spending_unknown" | "unavailable"): Promise<void> {
    const pending = kind === "spending_unknown" ? await spending.pendingDispatch(botExecutionSpendingOwner(claim)) : undefined;
    // An uncertain provider cost is the person's decision: it is never retried.
    if (pending || !options.retry || !options.setTimer) {
      forget(claim.id);
      await raise(botId, claim, message, pending?.dispatchId);
      return;
    }
    const state = retries.get(claim.id) ?? { attempts: 0 };
    state.timer?.cancel();
    const attempt = state.attempts;
    if (attempt >= BOT_EXECUTION_RETRY_DELAYS_MS.length) {
      forget(claim.id);
      await raise(botId, claim, message);
      return;
    }
    state.attempts = attempt + 1;
    retries.set(claim.id, state);
    state.timer = options.setTimer(() => {
      if (retries.get(claim.id) !== state) return;
      delete state.timer;
      void options.retry!(botId, claim, attempt + 1)
        .then((result) => {
          if (retries.get(claim.id) !== state) return;
          if (result === "moot") forget(claim.id);
          // Refused outright: the block still stands, so it counts as the next try.
          else if (result === "failed") return blocked(botId, claim, message, kind);
          return undefined;
        })
        .catch((error: unknown) => {
          options.onError?.(botId, error);
          if (retries.get(claim.id) === state) return blocked(botId, claim, message, kind);
          return undefined;
        })
        .catch((error: unknown) => options.onError?.(botId, error));
    }, BOT_EXECUTION_RETRY_DELAYS_MS[attempt]!);
  }

  return {
    blocked,
    async settled(botId: string, claim: BotExecutionClaim) { forget(claim.id); await issues.resolve(botId, `execution:${claim.id}`, "fixed"); },
    async dismissed(botId: string, claim: BotExecutionClaim) { forget(claim.id); await issues.resolve(botId, `execution:${claim.id}`, "dismissed"); },
    async acknowledged(botId: string, dispatchId: string) { await issues.resolve(botId, `execution-cost:${dispatchId}`, "fixed"); },
  };
}
