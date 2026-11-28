/**
 * The goal reviewer: one call to the chat's own model asking whether the goal
 * is done.
 *
 * - It is sent as a side call that continues the chat's last request (same
 *   tools, system prompt and reasoning, with the reviewer's instructions as
 *   the last user message), so the provider reads the prefix the chat already
 *   cached. Short cache retention, 400 output tokens, 60 seconds, no retries.
 *   The thinking settings are the chat's own (changing them would miss the
 *   cache), so when the chat thinks, the output cap adds that thinking budget
 *   (bounded) on top of the 400, or reasoning would use up the answer.
 * - When that prefix is gone (lapsed, another model, a newer request) or the
 *   continuation fails, it falls back to a tool-free, isolated projection of
 *   the conversation, the one the advisor uses.
 * - It never runs a tool: a reply that calls one is no verdict. The reply is
 *   never journaled.
 * - Every request is checked against the chat's spending limit first, counted
 *   toward it after, and recorded as "goal-review" usage.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type TextContent,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";

import type { GoalRecordV1 } from "../../../renderer/shared/goal.js";
import { projectAdvisorContext } from "../advisor-context.js";
import {
  oneOffCallOptions,
  sideCallContinuation,
  sideCallModelKey,
  type SideCallPrefix,
} from "../side-call-prefix.js";
import type { StoredProvider } from "../types.js";
import {
  assistantUsageRecord,
  isLocalModelProvider,
  unreportedUsageRecord,
} from "../usage-accounting.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { goalReviewerPrompt } from "./goal-prompts.js";
import { parseGoalVerdict, type GoalVerdict } from "./goal-verdict.js";

/** Visible answer tokens a review may write. */
export const GOAL_REVIEW_MAX_TOKENS = 400;
/** The most thinking a continued review makes room for on top of its answer. */
export const GOAL_REVIEW_MAX_THINKING_TOKENS = 16_384;
/** pi-ai's default thinking budgets, used when the chat's request named none. */
const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};
export const GOAL_REVIEW_TIMEOUT_MS = 60_000;
/** The isolated review's system prompt; the continuation keeps the chat's own. */
export const GOAL_REVIEWER_SYSTEM_PROMPT =
  "You check whether a goal set in a chat is done, judging only on the evidence in the conversation. You have no tools. Answer with one JSON object.";

export interface GoalReviewerRuntime {
  model: Model<Api>;
  provider: StoredProvider;
  apiKey?: string;
  headers?: ProviderHeaders;
  streams: Pick<Models, "streamSimple">;
}

export interface GoalReviewerDependencies {
  /** The chat's own model, resolved for this chat. */
  runtime: GoalReviewerRuntime;
  /** The chat's last foreground request while its cache is live (`chatSideCallPrefixes.latest`). */
  prefix(): Promise<SideCallPrefix | undefined>;
  /** The chat's messages, read only for the isolated fallback. */
  messages(): Promise<readonly AgentMessage[]>;
  /** Why the next request would break the chat's spending limit, if it would. */
  spendingRefusal(): Promise<string | undefined>;
  /** A response's cost → the chat's spending limit. */
  countSpend(message: AssistantMessage): void;
  recordUsage(record: UsageRequestRecord): Promise<void> | void;
  reportFailure?(area: "dispatch" | "context" | "usage", error: unknown): void;
  now?(): number;
}

export type GoalReviewPath = "continuation" | "isolated";

export type GoalReviewOutcome =
  | { kind: "verdict"; verdict: GoalVerdict; via: GoalReviewPath }
  /** Counts as no verdict: two in a row pause the goal. */
  | { kind: "unusable"; why: "tool-call" | "no-verdict" | "failed"; via: GoalReviewPath }
  /** The caller's signal ended it. */
  | { kind: "cancelled" }
  /** Over the chat's spending limit: nothing was sent. */
  | { kind: "refused"; message: string };

type Sent =
  | { state: "completed"; response: AssistantMessage }
  | { state: "failed" }
  /** Ran out of time: the time is spent, so no fallback follows. */
  | { state: "timed-out" }
  | { state: "cancelled" };

export async function reviewGoal(
  dependencies: GoalReviewerDependencies,
  input: {
    goal: Pick<GoalRecordV1, "objective" | "rounds" | "maxRounds" | "check">;
    allowWait: boolean;
    signal: AbortSignal;
  },
): Promise<GoalReviewOutcome> {
  const { runtime } = dependencies;
  const now = dependencies.now ?? Date.now;
  const instruction: UserMessage = {
    role: "user",
    content: [
      { type: "text", text: goalReviewerPrompt(input.goal, { allowWait: input.allowWait }) },
    ],
    timestamp: now(),
  };
  const call = {
    apiKey: runtime.apiKey,
    ...(runtime.headers ? { headers: runtime.headers } : {}),
    maxTokens: GOAL_REVIEW_MAX_TOKENS,
    timeoutMs: GOAL_REVIEW_TIMEOUT_MS,
    maxRetries: 0,
    maxRetryDelayMs: 0,
  };

  const send = async (request: {
    context: TranscriptContext;
    options: SimpleStreamOptions;
  }): Promise<Sent | { state: "refused"; message: string }> => {
    const refusal = await dependencies.spendingRefusal();
    if (refusal) return { state: "refused", message: refusal };
    if (input.signal.aborted) return { state: "cancelled" };
    let response: AssistantMessage;
    try {
      response = await runtime.streams
        .streamSimple(runtime.model, request.context, { ...request.options, signal: input.signal })
        .result();
    } catch (error) {
      dependencies.reportFailure?.("dispatch", error);
      await record(
        dependencies,
        unreported(runtime, input.signal.aborted ? "cancelled" : "failed"),
      );
      return input.signal.aborted ? { state: "cancelled" } : { state: "failed" };
    }
    dependencies.countSpend(response);
    await record(
      dependencies,
      assistantUsageRecord({
        message: response,
        provider: runtime.provider,
        model: runtime.model,
        source: "goal-review",
      }),
    );
    if (input.signal.aborted) return { state: "cancelled" };
    if (response.stopReason === "aborted") return { state: "timed-out" };
    if (response.stopReason === "error") return { state: "failed" };
    return { state: "completed", response };
  };

  const answer = (
    sent: Sent | { state: "refused"; message: string },
    via: GoalReviewPath,
  ): GoalReviewOutcome => {
    if (sent.state === "refused") return { kind: "refused", message: sent.message };
    if (sent.state === "cancelled") return { kind: "cancelled" };
    if (sent.state !== "completed") return { kind: "unusable", why: "failed", via };
    if (sent.response.content.some((part) => part.type === "toolCall"))
      return { kind: "unusable", why: "tool-call", via };
    const verdict = parseGoalVerdict(replyText(sent.response), { allowWait: input.allowWait });
    return verdict
      ? { kind: "verdict", verdict, via }
      : { kind: "unusable", why: "no-verdict", via };
  };

  const prefix = await dependencies.prefix().catch(() => undefined);
  // A chat request that forced a tool call would force one in its continuation
  // too, and a tool call is never a verdict: such a review starts isolated.
  if (
    prefix &&
    prefix.modelKey === sideCallModelKey(runtime.model) &&
    !forcesToolCall(prefix.options.toolChoice)
  ) {
    const continued = await send(
      sideCallContinuation(prefix, [instruction], {
        ...call,
        maxTokens: goalReviewMaxTokens(prefix.options, runtime.model),
      }),
    );
    // A failed continuation falls back to the isolated review; anything else answers.
    if (continued.state !== "failed") return answer(continued, "continuation");
  }

  let isolated: { context: TranscriptContext; options: SimpleStreamOptions };
  try {
    const projection = projectAdvisorContext({
      liveMessages: [...(await dependencies.messages()), instruction],
      inflightToolCallId: "",
      executorTools: [],
      reviewerContextWindow: runtime.model.contextWindow,
      reviewerSupportsImages: runtime.model.input.includes("image"),
      reviewerSystemPrompt: GOAL_REVIEWER_SYSTEM_PROMPT,
      timestamp: now(),
    });
    isolated = {
      context: normalizeContext({
        systemPrompt: GOAL_REVIEWER_SYSTEM_PROMPT,
        messages: projection.messages,
        tools: [],
      }),
      options: oneOffCallOptions(call),
    };
  } catch (error) {
    dependencies.reportFailure?.("context", error);
    return { kind: "unusable", why: "failed", via: "isolated" };
  }
  return answer(await send(isolated), "isolated");
}

/**
 * The output cap for a review that continues the chat's request: 400 visible
 * tokens, plus the request's thinking budget when it thinks (its own budgets,
 * else the defaults), bounded, and never above the model's own cap.
 */
export function goalReviewMaxTokens(
  replay: Pick<SideCallPrefix["options"], "reasoning" | "thinkingBudgets">,
  model: Pick<Model<Api>, "maxTokens">,
): number {
  const level = replay.reasoning;
  if (!level || (level as string) === "off") return GOAL_REVIEW_MAX_TOKENS;
  const named = level === "xhigh" || (level as string) === "max" ? "high" : level;
  const budgets = {
    ...DEFAULT_THINKING_BUDGETS,
    ...(replay.thinkingBudgets as Record<string, number> | undefined),
  };
  const thinking = Math.min(Math.max(0, budgets[named] ?? 0), GOAL_REVIEW_MAX_THINKING_TOKENS);
  const cap = GOAL_REVIEW_MAX_TOKENS + thinking;
  return model.maxTokens > 0 ? Math.min(cap, model.maxTokens) : cap;
}

/** A tool choice other than leaving it to the model ("auto") or ruling tools out ("none"). */
function forcesToolCall(toolChoice: unknown): boolean {
  return toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none";
}

function replyText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function unreported(
  runtime: GoalReviewerRuntime,
  status: "failed" | "cancelled",
): UsageRequestRecord {
  return unreportedUsageRecord({
    source: "goal-review",
    providerId: runtime.provider.id,
    providerLabel: runtime.provider.label,
    modelId: runtime.model.id,
    modelLabel: runtime.model.name,
    local: isLocalModelProvider(runtime.provider),
    status,
  });
}

async function record(
  dependencies: GoalReviewerDependencies,
  usage: UsageRequestRecord,
): Promise<void> {
  try {
    await dependencies.recordUsage(usage);
  } catch (error) {
    dependencies.reportFailure?.("usage", error);
  }
}
