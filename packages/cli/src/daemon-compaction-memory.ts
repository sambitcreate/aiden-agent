// A workspace chat's compaction summary under `aiden serve`, with the same
// memory rule the desktop keeps (main/services/pi-compaction-core.ts): a
// summary is permanent and outlives the memory facts it could quote, so no
// fact line reaches the summarizer and no stored summary states a fact the
// chat was ever told, removed ones included. The filter is the desktop's own
// code in main/services/chat-frozen-state.ts.
//
// Pi only lets an extension replace a summary before it is written, so the
// server writes it here with Pi's own `compact()`: the session's stream
// function carries the model runtime's credentials, as Pi's default
// compaction does. Any failure cancels the compaction rather than letting
// Pi store an unfiltered summary.

import {
  compact,
  convertToLlm,
  type AgentSession,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { memoryFactLinesInBranch, withoutMemoryFacts, withoutStatedMemoryFacts } from "../../../main/services/chat-frozen-state.js";

export interface DaemonCompactionMemory {
  session: AgentSession;
  settings: SettingsManager;
  model: Model<Api> | undefined;
  /** Every fact line the always-on prompt told this chat, kept across its turns. */
  toldFacts: ReadonlySet<string>;
  /** The fact lines the chat may be told now; none when memory is off. */
  approvedFactLines?: () => Promise<string[]>;
}

/** Pi's virtual models route each request; a summary goes to the physical model the route picks. */
const VIRTUAL_MODEL_API = "pi-virtual";

export async function compactWithoutMemoryFacts(event: SessionBeforeCompactEvent, memory: DaemonCompactionMemory): Promise<SessionBeforeCompactResult> {
  try {
    const selected = memory.model;
    if (!selected) return { cancel: true };
    const approved = await memory.approvedFactLines?.().catch(() => []) ?? [];
    const facts = [...memoryFactLinesInBranch(event.branchEntries), ...memory.toldFacts, ...approved];
    const { preparation, signal } = event;
    const summaryPreparation = {
      ...preparation,
      messagesToSummarize: withoutMemoryFacts(preparation.messagesToSummarize),
      turnPrefixMessages: withoutMemoryFacts(preparation.turnPrefixMessages),
    };
    const { model, thinkingLevel } = selected.api === VIRTUAL_MODEL_API
      ? await memory.session.modelRuntime.resolveModel(selected, convertToLlm(memory.session.messages), { reason: "direct", thinkingLevel: memory.session.thinkingLevel, signal })
      : { model: selected, thinkingLevel: memory.session.thinkingLevel };
    const result = await compact(summaryPreparation, model, undefined, undefined, event.customInstructions, signal, thinkingLevel,
      memory.session.agent.streamFunction, undefined, memory.settings.getRetrySettings());
    // Whichever lines the summarizer wrote, none that states a fact is kept;
    // a fact split across kept lines fails the compaction.
    const kept = withoutStatedMemoryFacts(result.summary, facts);
    if (kept.restated || signal.aborted) return { cancel: true };
    return { compaction: { ...result, summary: kept.text } };
  } catch {
    return { cancel: true };
  }
}
