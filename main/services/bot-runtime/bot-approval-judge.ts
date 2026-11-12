// The Auto judge for Bots (docs/plans/bot-ux-simplification.md §3.2): the
// workspace judge (`approval-judge/`) with a Bot's job as context, the Bot's
// own model (or the approval model the person named in Advanced), verdicts
// cached per effect within one run, and each call's cost counted against the
// Bot's spending as "approval-judge" usage. Fails closed: no model, an error,
// a timeout or an unsure reply defers to the card.

import { createApprovalJudge, type ApprovalJudge, type ApprovalJudgeComplete } from "../approval-judge/judge.js";
import { approvalJudgeComplete, type ApprovalJudgeRuntime } from "../approval-judge/model-complete.js";
import { responseCostUsd } from "../spending-service.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import type { BotApprovalJudgeInput, BotToolAssemblyPorts } from "./bot-tool-assembly.js";

export interface BotApprovalJudgeDeps {
  /** The Bot's instructions, as its job. */
  job(botId: string): Promise<string | undefined>;
  /**
   * The model that judges for this Bot, and whether its requests cost money
   * (an API key, not a sign-in or a model on this Mac), or `undefined` when
   * no model can judge (an ACP agent).
   */
  runtime(botId: string, signal?: AbortSignal): Promise<{ judge: ApprovalJudgeRuntime; countsSpend(): Promise<boolean> } | undefined>;
  recordUsage(record: UsageRequestRecord): Promise<void> | void;
  /** A judge call's cost, toward the Bot's (and a routine run's) spending. */
  recordSpend(botId: string, requestIds: readonly (string | undefined)[], usd: number): Promise<void>;
  /** A cost that couldn't be counted. */
  onSpendError?(botId: string, error: unknown): void;
  timeoutMs?: number;
  /** Runs whose verdicts are kept at once. */
  runsKept?: number;
}

export function createBotApprovalJudge(deps: BotApprovalJudgeDeps): NonNullable<BotToolAssemblyPorts["judge"]> {
  const runs = new Map<string, ApprovalJudge>();
  const kept = deps.runsKept ?? 100;
  const judgeFor = (botId: string, input: BotApprovalJudgeInput): ApprovalJudge => {
    const key = `${botId}\u0000${input.run}`;
    const existing = runs.get(key);
    if (existing) {
      runs.delete(key);
      runs.set(key, existing);
      return existing;
    }
    const complete: ApprovalJudgeComplete = async (request, signal) => {
      const resolved = await deps.runtime(botId, signal);
      if (!resolved) throw new Error("No model can judge for this Bot.");
      let spent: Promise<void> = Promise.resolve();
      const reply = await approvalJudgeComplete(resolved.judge, {
        recordUsage: (record) => deps.recordUsage(record),
        countSpend: (message) => {
          const usd = responseCostUsd(message);
          if (usd <= 0) return;
          spent = resolved.countsSpend()
            .catch(() => true)
            .then((counts) => (counts ? deps.recordSpend(botId, input.requestIds, usd) : undefined))
            .catch((error: unknown) => deps.onSpendError?.(botId, error));
        },
      })(request, signal);
      await spent;
      return reply;
    };
    const judge = createApprovalJudge({ complete, ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) });
    runs.set(key, judge);
    while (runs.size > kept) runs.delete(runs.keys().next().value!);
    return judge;
  };
  return async (botId, input, signal) => {
    try {
      const job = (await deps.job(botId).catch(() => undefined)) ?? "";
      const verdict = await judgeFor(botId, input).judge(
        { effect: input.effect, action: input.action, request: input.request, ...(job.trim() ? { job } : {}) },
        signal,
      );
      return verdict.verdict;
    } catch {
      return "defer";
    }
  };
}
