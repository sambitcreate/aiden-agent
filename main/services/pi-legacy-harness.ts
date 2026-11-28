/**
 * Frozen Pi 0.87.1 journal and compaction compatibility boundary.
 *
 * Pi 1.0 removed its experimental harness exports. Keep existing journal bytes,
 * recovery, and compaction semantics until an independently evaluated migration.
 * Live agents and Models MUST use the current @earendil-works packages; this
 * module deliberately does not expose the legacy Agent or provider factories.
 */
export {
  CompactionError,
  DEFAULT_COMPACTION_SETTINGS,
  JsonlSessionRepo,
  MemorySessionRepo,
  branchTip,
  calculateContextTokens,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  entryLabel,
  estimateTokens,
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  sessionName,
  setValue,
  shouldCompact,
  value
} from "@aiden/pi-legacy-harness";
export type {
  Session,
  AgentHarnessResources,
  AgentHarnessStreamOptions,
  AgentHarnessStreamOptionsPatch,
  CompactResult,
  CompactionPreparation,
  CompactionSettings,
  JsonValue,
  JsonlSessionMetadata
} from "@aiden/pi-legacy-harness";
export { NodeExecutionEnv } from "@aiden/pi-legacy-harness/node";
export { uuidv7 } from "@earendil-works/pi-ai";

import {
  convertToLlm as legacyConvertToLlm,
  estimateContextTokens as legacyEstimateContextTokens,
  insertEntry as legacyInsertEntry,
  prepareCompaction as legacyPrepareCompaction,
  type BashExecutionMessage,
  type BranchSummaryMessage,
  type CompactionSettings,
  type CompactionSummaryMessage,
  type CustomMessage,
  type Entry as LegacyEntry,
} from "@aiden/pi-legacy-harness";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";

type LegacyEntryVariant<TEntry extends LegacyEntry> = TEntry extends { type: "message" }
  ? Omit<TEntry, "message"> & { message: AgentMessage }
  : TEntry extends { type: "compaction" }
    ? Omit<TEntry, "retainedTail" | "usage"> & {
        retainedTail: AgentMessage[];
        usage?: Usage;
      }
    : TEntry extends { type: "branch_summary" }
      ? Omit<TEntry, "usage"> & {
          usage?: Usage;
        }
      : TEntry extends { type: "custom" }
        ? Omit<TEntry, "data"> & { data?: unknown }
        : never;

export type Entry = LegacyEntryVariant<LegacyEntry>;
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry
  ? Omit<TEntry, "seq" | "timestamp">
  : never;

export const convertToLlm = legacyConvertToLlm as unknown as (messages: AgentMessage[]) => Message[];
export const estimateContextTokens = legacyEstimateContextTokens as unknown as (
  messages: AgentMessage[],
) => ReturnType<typeof legacyEstimateContextTokens>;
export const insertEntry = legacyInsertEntry as unknown as (
  entry: NewEntry,
) => ReturnType<typeof legacyInsertEntry>;
export const prepareCompaction = legacyPrepareCompaction as unknown as (
  pathEntries: Entry[],
  settings: CompactionSettings,
) => ReturnType<typeof legacyPrepareCompaction>;

// Legacy helper augmentation targets its own core copy. Register the persisted
// Aiden message roles with the current agent too, without widening to unknown.
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage;
    custom: CustomMessage;
    branchSummary: BranchSummaryMessage;
    compactionSummary: CompactionSummaryMessage;
  }
}

import {
  TODO_CONTEXT as legacyTodoContext,
  withAbortSignal as legacyWithAbortSignal,
  type Session as LegacySession,
} from "@aiden/pi-legacy-harness";

/**
 * The context the frozen helpers' declarations ask for. They name chord's
 * `Context`, which the root tsconfig's catch-all path resolves to the current
 * chord (whose `Context` has a required `telemetry` since 1.4), while the
 * contexts below come from the harness's own 0.87.1 chord. Both stay inside
 * this boundary: they are only ever handed back to the frozen helpers, which
 * never read `telemetry`, and never to a current Pi API.
 */
export type LegacyContext = Parameters<LegacySession["close"]>[0];
export const TODO_CONTEXT = legacyTodoContext as unknown as LegacyContext;
export const withAbortSignal = legacyWithAbortSignal as unknown as (
  signal: AbortSignal,
  context: LegacyContext,
) => LegacyContext;

import { compact as legacyCompact } from "@aiden/pi-legacy-harness";
import { generateBranchSummary as legacyGenerateBranchSummary } from "@aiden/pi-legacy-harness";
import type { Models } from "@earendil-works/pi-ai";

type LegacyCompactArguments = Parameters<typeof legacyCompact>;

/**
 * The old summarizer uses only completeSimple. Its broad Models parameter also
 * includes provider stream methods with a package-private TranscriptContext
 * brand, which cannot cross installations. Expose only the actual call seam:
 * current Models keeps normalization, credentials and request dispatch owned
 * by Pi 1.0; no old provider registry or stream is admitted here.
 */
export function compact(
  preparation: LegacyCompactArguments[0],
  models: Pick<Models, "completeSimple">,
  ...args: [
    model: LegacyCompactArguments[2],
    customInstructions: LegacyCompactArguments[3],
    thinkingLevel: LegacyCompactArguments[4],
    retry: LegacyCompactArguments[5],
    callbacks: LegacyCompactArguments[6],
    context: LegacyCompactArguments[7],
  ]
): ReturnType<typeof legacyCompact> {
  const summaryModels = {
    completeSimple: (...request: Parameters<Models["completeSimple"]>) => models.completeSimple(...request),
  };
  return legacyCompact(preparation, summaryModels as unknown as LegacyCompactArguments[1], ...args);
}

type LegacyBranchSummaryArguments = Parameters<typeof legacyGenerateBranchSummary>;

/** Fork summaries use the same current-provider seam as compaction. */
export function generateBranchSummary(
  entries: Entry[],
  options: Omit<LegacyBranchSummaryArguments[1], "models"> & { models: Pick<Models, "completeSimple"> },
  context: LegacyBranchSummaryArguments[2],
): ReturnType<typeof legacyGenerateBranchSummary> {
  const summaryModels = {
    completeSimple: (...request: Parameters<Models["completeSimple"]>) => options.models.completeSimple(...request),
  };
  return legacyGenerateBranchSummary(entries as unknown as LegacyBranchSummaryArguments[0], {
    ...options,
    models: summaryModels as unknown as LegacyBranchSummaryArguments[1]["models"],
  }, context);
}
