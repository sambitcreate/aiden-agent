// Compaction steering for Bot conversations (spec 2026-10-09 §9), run from
// Pi Durable's `beforeCompact` hook before the old part of the conversation is
// summarized away.
//
// 1. Flush: when `bot_memory` would be offered, an add-only review of the
//    messages being compacted (newest 16,000 characters, 20 s, 2 rounds)
//    saves facts that would otherwise only live in the summary. Any add is
//    recorded as an `aiden.memory-review { source: "compaction" }` entry. A
//    replay after a crash re-runs it harmlessly: duplicate adds are no-ops.
// 2. Steered summary: Pi Durable's own summarization prompt plus a focus on
//    what the person shared and what the Bot promised, through the Bot's own
//    model. Any failure or timeout returns `undefined`, so Pi summarizes as it
//    would have anyway.
// 3. Refresh: the memory snapshot is marked stale, so the first request after
//    compaction carries the current memory.

import type { Context } from "@earendil-works/chord";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { BOT_MEMORY_REVIEW_ENTRY_KIND, type BotMemoryReviewEntryData } from "../../../renderer/shared/bot-memory.js";
import type { BotCompaction } from "../bot-runtime/bot-extension.js";
import { runMemoryReview, serializeMessagesForReview, type MemoryReviewModel } from "./review.js";
import type { BotMemoryRuntime } from "./service.js";

/** What a Bot's compaction summary must keep. Also the `/new` instructions. */
export const BOT_COMPACTION_FOCUS =
  "Keep: facts the person shared about themselves and their life; decisions; promises or follow-ups you committed to; " +
  "routines discussed or proposed; open questions. Drop tool output details.";

export const BOT_COMPACTION_FLUSH_TIMEOUT_MS = 20_000;
export const BOT_COMPACTION_FLUSH_MAX_ROUNDS = 2;
export const BOT_COMPACTION_SUMMARY_TIMEOUT_MS = 60_000;
/** Pi Durable's default `reserveTokens`. */
const DEFAULT_RESERVE_TOKENS = 16_384;
const TOOL_RESULT_MAX_CHARS = 2_000;

// The two prompts below are borrowed from Pi Durable 1.0.3
// (`@earendil-works/pi-durable`, dist/harness/compaction.js, MIT licence,
// © Earendil Works) so a steered summary reads exactly like Pi's own. If Pi
// changes its summarizer, update these to match.
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [(part as TextContent).text] : [])).join("\n");
}

/** The summarizer's transcript, in the shape Pi Durable serializes it (system messages omitted). */
function serializeForSummary(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text) parts.push(`[User]: ${text}`);
    } else if (message.role === "assistant") {
      const thinking = message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : []));
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      const calls = message.content.flatMap((part) =>
        part.type === "toolCall"
          ? [`${part.name}(${Object.entries(part.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")})`]
          : [],
      );
      if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (message.role === "toolResult") {
      const text = textOf(message.content);
      if (text) {
        const shown = text.length <= TOOL_RESULT_MAX_CHARS ? text : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`;
        parts.push(`[Tool result]: ${shown}`);
      }
    }
  }
  return parts.join("\n\n");
}

export function steeredSummaryPrompt(messages: readonly Message[], instructions: string | undefined): string {
  const focus = [BOT_COMPACTION_FOCUS, ...(instructions && instructions !== BOT_COMPACTION_FOCUS ? [instructions] : [])].join("\n");
  return `<conversation>\n${serializeForSummary(messages)}\n</conversation>\n\n${SUMMARIZATION_PROMPT}\n\nAdditional focus: ${focus}`;
}

export interface BotCompactionSteeringDeps {
  memory: Pick<BotMemoryRuntime, "apply" | "view" | "markStale">;
  /** The Bot's own model, or null when it has none. */
  model(botId: string): Promise<MemoryReviewModel | null>;
  /** Append a bookkeeping entry to the Bot's conversation. */
  appendEntry(botId: string, kind: string, data: BotMemoryReviewEntryData): Promise<void>;
  /** The harness's `reserveTokens` (Pi Durable's default when absent). */
  reserveTokens?: number;
  onError?(botId: string, error: unknown): void;
  flushTimeoutMs?: number;
  summaryTimeoutMs?: number;
}

export type BotCompactionSteering = (
  botId: string,
  compaction: BotCompaction,
  offer: { memoryOffered: boolean },
  context: Context,
) => Promise<{ summary: string } | undefined>;

export function createBotCompactionSteering(deps: BotCompactionSteeringDeps): BotCompactionSteering {
  return async (botId, compaction, offer, context) => {
    try {
      const model = await deps.model(botId).catch(() => null);
      if (model === null) return undefined;

      if (offer.memoryOffered) {
        try {
          const flushed = await runMemoryReview({
            botId,
            memory: deps.memory,
            model,
            transcript: serializeMessagesForReview(compaction.messages),
            maxRounds: BOT_COMPACTION_FLUSH_MAX_ROUNDS,
            timeoutMs: deps.flushTimeoutMs ?? BOT_COMPACTION_FLUSH_TIMEOUT_MS,
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          });
          if (flushed.added > 0) {
            await deps.appendEntry(botId, BOT_MEMORY_REVIEW_ENTRY_KIND, {
              source: "compaction",
              added: flushed.added,
              targets: flushed.targets,
            });
          }
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          deps.onError?.(botId, error);
        }
      }

      try {
        const reserve = deps.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
        const maxTokens = Math.min(
          Math.floor(0.8 * reserve),
          model.model.maxTokens > 0 ? model.model.maxTokens : Number.POSITIVE_INFINITY,
        );
        const signal = AbortSignal.any([
          AbortSignal.timeout(deps.summaryTimeoutMs ?? BOT_COMPACTION_SUMMARY_TIMEOUT_MS),
          ...(context.abortSignal === undefined ? [] : [context.abortSignal]),
        ]);
        const answer = await model.models.completeSimple(
          model.model,
          {
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: steeredSummaryPrompt(compaction.messages, compaction.instructions) }],
                timestamp: Date.now(),
              },
            ],
          },
          { maxTokens, signal },
        );
        if (answer.stopReason !== "stop" || answer.content.some((part) => part.type === "toolCall")) return undefined;
        const summary = answer.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .trim();
        return summary.length === 0 ? undefined : { summary };
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        deps.onError?.(botId, error);
        return undefined;
      }
    } finally {
      deps.memory.markStale(botId);
    }
  };
}
