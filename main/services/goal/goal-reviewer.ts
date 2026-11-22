/**
 * The goal reviewer: one call to the chat's own model asking whether the goal
 * is done.
 *
 * - It is sent as a side call that continues the chat's last request (same
 *   tools, system prompt and reasoning, with the reviewer's instructions as
 *   the last user message), so the provider reads the prefix the chat already
 *   cached. Short cache retention, 400 output tokens, 60 seconds, no retries.
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
import { oneOffCallOptions, sideCallContinuation, sideCallModelKey, type SideCallPrefix } from "../side-call-prefix.js";
import type { StoredProvider } from "../types.js";
import { assistantUsageRecord, isLocalModelProvider, unreportedUsageRecord } from "../usage-accounting.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { goalReviewerPrompt } from "./goal-prompts.js";
import { parseGoalVerdict, type GoalVerdict } from "./goal-verdict.js";

export const GOAL_REVIEW_MAX_TOKENS = 400;
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
  input: { goal: Pick<GoalRecordV1, "objective" | "rounds" | "maxRounds" | "check">; allowWait: boolean; signal: AbortSignal },
): Promise<GoalReviewOutcome> {
  const { runtime } = dependencies;
  const now = dependencies.now ?? Date.now;
  const instruction: UserMessage = {
    role: "user",
    content: [{ type: "text", text: goalReviewerPrompt(input.goal, { allowWait: input.allowWait }) }],
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

  const send = async (request: { context: TranscriptContext; options: SimpleStreamOptions }): Promise<Sent | { state: "refused"; message: string }> => {
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
      await record(dependencies, unreported(runtime, input.signal.aborted ? "cancelled" : "failed"));
      return input.signal.aborted ? { state: "cancelled" } : { state: "failed" };
    }
    dependencies.countSpend(response);
    await record(dependencies, assistantUsageRecord({ message: response, provider: runtime.provider, model: runtime.model, source: "goal-review" }));
    if (input.signal.aborted) return { state: "cancelled" };
    if (response.stopReason === "aborted") return { state: "timed-out" };
    if (response.stopReason === "error") return { state: "failed" };
    return { state: "completed", response };
  };

  const answer = (sent: Sent | { state: "refused"; message: string }, via: GoalReviewPath): GoalReviewOutcome => {
    if (sent.state === "refused") return { kind: "refused", message: sent.message };
    if (sent.state === "cancelled") return { kind: "cancelled" };
    if (sent.state !== "completed") return { kind: "unusable", why: "failed", via };
    if (sent.response.content.some((part) => part.type === "toolCall")) return { kind: "unusable", why: "tool-call", via };
    const verdict = parseGoalVerdict(replyText(sent.response), { allowWait: input.allowWait });
    return verdict ? { kind: "verdict", verdict, via } : { kind: "unusable", why: "no-verdict", via };
  };

  const prefix = await dependencies.prefix().catch(() => undefined);
  if (prefix && prefix.modelKey === sideCallModelKey(runtime.model)) {
    const continued = await send(sideCallContinuation(prefix, [instruction], call));
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
      context: normalizeContext({ systemPrompt: GOAL_REVIEWER_SYSTEM_PROMPT, messages: projection.messages, tools: [] }),
      options: oneOffCallOptions(call),
    };
  } catch (error) {
    dependencies.reportFailure?.("context", error);
    return { kind: "unusable", why: "failed", via: "isolated" };
  }
  return answer(await send(isolated), "isolated");
}

function replyText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function unreported(runtime: GoalReviewerRuntime, status: "failed" | "cancelled"): UsageRequestRecord {
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

async function record(dependencies: GoalReviewerDependencies, usage: UsageRequestRecord): Promise<void> {
  try {
    await dependencies.recordUsage(usage);
  } catch (error) {
    dependencies.reportFailure?.("usage", error);
  }
}
