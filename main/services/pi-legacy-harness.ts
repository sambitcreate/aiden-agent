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
  TODO_CONTEXT,
  branchTip,
  calculateContextTokens,
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  entryLabel,
  estimateContextTokens,
  estimateTokens,
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  insertEntry,
  prepareCompaction,
  sessionName,
  setValue,
  shouldCompact,
  value,
  withAbortSignal
} from "@aiden/pi-legacy-harness";
export type {
  Session,
  AgentHarnessResources,
  AgentHarnessStreamOptions,
  AgentHarnessStreamOptionsPatch,
  CompactResult,
  CompactionPreparation,
  CompactionSettings,
  Entry,
  JsonValue,
  JsonlSessionMetadata
} from "@aiden/pi-legacy-harness";
export { NodeExecutionEnv } from "@aiden/pi-legacy-harness/node";
export { uuidv7 } from "@earendil-works/pi-ai";

import type {
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "@aiden/pi-legacy-harness";

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

import { compact as legacyCompact } from "@aiden/pi-legacy-harness";
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
