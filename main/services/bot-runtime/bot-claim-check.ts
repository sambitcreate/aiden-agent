// The false-success claim check for Bots (spec §5 S5). Chats already flag a
// reply that says a step worked when it failed; Bot transcripts are Pi Durable
// entries, so this builds the check's timeline from a turn's projected
// entries and reuses the same detector. No patterns are copied here.

import {
  detectUnverifiedSuccessClaim,
  type ClaimCheckOptions,
} from "../../../renderer/shared/claim-check.js";
import type { BotToolResultStatus, BotTranscriptEntry } from "../../../renderer/shared/bot-live.js";
import {
  GENERATION_TIMELINE_VERSION,
  type AgentStepStatus,
  type AgentToolStep,
  type GenerationClaimCheck,
  type GenerationTimeline,
} from "../../../renderer/shared/generation-timeline.js";

export const BOT_ROUTINE_UNVERIFIED_LINE = "One step didn't work: {step}. Check the chat.";

const STEP_STATUS: Record<BotToolResultStatus, AgentStepStatus> = {
  ok: "completed",
  failed: "failed",
  blocked: "blocked",
  stopped: "cancelled",
};

/** The newest turn: everything after the last person or routine input. */
export function latestBotTurn(entries: readonly BotTranscriptEntry[]): BotTranscriptEntry[] {
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const type = entries[index]!.type;
    if (type === "user" || type === "routine") {
      start = index + 1;
      break;
    }
  }
  return entries.slice(start);
}

/** A finished timeline of the turn's tool steps, one per tool result. */
export function botTurnTimeline(turn: readonly BotTranscriptEntry[]): GenerationTimeline {
  const steps: AgentToolStep[] = [];
  for (const entry of turn) {
    if (entry.type !== "tool_result") continue;
    const at = entry.at ?? 0;
    steps.push({
      id: entry.id,
      order: steps.length,
      kind: "tool",
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      label: entry.toolName,
      status: STEP_STATUS[entry.status] ?? (entry.isError ? "failed" : "completed"),
      startedAt: at,
      updatedAt: at,
      finishedAt: at,
    });
  }
  return { version: GENERATION_TIMELINE_VERSION, generationId: "bot-turn", status: "completed", startedAt: 0, steps };
}

/** The turn's visible reply: its assistant text, in order. */
function turnText(turn: readonly BotTranscriptEntry[]): string {
  return turn
    .filter((entry): entry is Extract<BotTranscriptEntry, { type: "assistant" }> => entry.type === "assistant")
    .map((entry) => entry.text)
    .filter((text) => text.trim())
    .join("\n\n");
}

export interface BotTurnClaimCheck {
  claimCheck: GenerationClaimCheck;
  toolNames: string[];
}

/**
 * Check the newest turn's reply against its own tool steps. Earlier turns are
 * ignored: a failure the Bot already moved past is not this reply's claim.
 */
export function checkBotTurnClaims(
  entries: readonly BotTranscriptEntry[],
  options: ClaimCheckOptions = {},
): BotTurnClaimCheck | undefined {
  const turn = latestBotTurn(entries);
  const timeline = botTurnTimeline(turn);
  const claimCheck = detectUnverifiedSuccessClaim(turnText(turn), timeline, options);
  if (!claimCheck) return undefined;
  const flagged = new Set(claimCheck.stepIds);
  const toolNames = [...new Set(timeline.steps.flatMap((step) =>
    step.kind === "tool" && flagged.has(step.id) ? [step.toolName] : []))];
  return { claimCheck, toolNames };
}

/** The fixed line a flagged routine result gets, naming the failed step. */
export function unverifiedRoutineLine(toolNames: readonly string[]): string {
  return BOT_ROUTINE_UNVERIFIED_LINE.replace("{step}", toolNames[0] ?? "a step");
}
