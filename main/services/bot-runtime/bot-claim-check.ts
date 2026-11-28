// The false-success claim check for Bots (spec §5 S5). Chats already flag a
// reply that says a step worked when it failed; Bot transcripts are Pi Durable
// entries, so this builds the check's timeline from a turn's projected
// entries and reuses the same detector. No patterns are copied here.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
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
import { BOT_PEER_INPUT_KIND, isBotInputEntryKind } from "./bot-input-entry.js";
import { projectBotTranscript } from "./live-projection.js";

export const BOT_ROUTINE_UNVERIFIED_LINE = "One step didn't work: {step}. Check the chat.";

export interface BotEntryPageReader {
  entries(
    query: { readonly order?: "ascending" | "descending" },
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
}

const DEFAULT_TURN_SLICE_PAGE_SIZE = 32;

function isTurnOpeningInput(record: EntryRecord): boolean {
  if (record.kind === BOT_PEER_INPUT_KIND) return true;
  if (!isBotInputEntryKind(record.kind)) return false;
  const first = Array.isArray(record.model) ? record.model[0] : undefined;
  return (first as { role?: unknown } | undefined)?.role === "user";
}

function hasVisibleTurnOpening(entries: readonly BotTranscriptEntry[]): boolean {
  return entries.some((entry) => entry.type === "user" || entry.type === "routine");
}

/**
 * Read only the newest active turn's entries in descending order and project
 * that bounded slice. Stops as soon as the projected slice includes the newest
 * visible `user` or `routine` opening (after reading any preceding notices up
 * to the prior input boundary), while respecting active head markers.
 */
export async function projectNewestBotTurnEntries(
  conversation: BotEntryPageReader,
  options: { pageSize?: number; context?: Context } = {},
): Promise<BotTranscriptEntry[]> {
  const pageSize = options.pageSize ?? DEFAULT_TURN_SLICE_PAGE_SIZE;
  const context = options.context ?? BACKGROUND_CONTEXT;
  let headMarker: EntryRecord | undefined;
  let minActiveId: number | undefined;
  const reverseNonHead: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  let sawCandidateUserInput = false;

  const toChronologicalSlice = (): EntryRecord[] => {
    const ordered: EntryRecord[] = [];
    if (headMarker) ordered.push(headMarker);
    for (let i = reverseNonHead.length - 1; i >= 0; i -= 1) {
      ordered.push(reverseNonHead[i]!);
    }
    return ordered;
  };

  for (;;) {
    const page = await conversation.entries({ order: "descending" }, pageSize, cursor, context);
    let reachedCutoff = false;
    for (const entry of page.items) {
      if (minActiveId !== undefined && Number(entry.id) < minActiveId) {
        reachedCutoff = true;
        break;
      }
      if (entry.head !== undefined) {
        if (headMarker === undefined) {
          headMarker = entry;
          minActiveId = Number(entry.head);
        }
        continue;
      }
      if (sawCandidateUserInput && isTurnOpeningInput(entry)) {
        const projected = projectBotTranscript(toChronologicalSlice());
        if (hasVisibleTurnOpening(projected)) return projected;
        sawCandidateUserInput = false;
      }
      reverseNonHead.push(entry);
      if (entry.kind === "pi.user" && isTurnOpeningInput(entry)) {
        sawCandidateUserInput = true;
      }
    }
    if (reachedCutoff || !page.next || page.items.length === 0) break;
    cursor = page.next;
  }

  return projectBotTranscript(toChronologicalSlice());
}

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
