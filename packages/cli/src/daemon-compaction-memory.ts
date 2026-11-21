// A workspace chat's compaction summary under `aiden serve`, with the same
// memory rule the desktop keeps (main/services/pi-compaction-core.ts): a
// summary is permanent and outlives the memory facts it could quote, so no
// fact line reaches the summarizer and no stored summary states a fact the
// chat was ever told, removed ones included. The filter is the desktop's own
// code in main/services/chat-frozen-state.ts.
//
// Pi only lets an extension replace a summary before it is written, so the
// server writes it here. A threshold or manual compaction of a chat that was
// never told a fact first continues the turn's cached request, as the
// desktop's coordinator does (`summaryOnCachedPrefix`); otherwise, and when
// that continuation cannot be used, it sends Pi's own isolated `compact()`.
// Pi still decides when to compact, retries an overflow and splits a turn.
// Both go through the session's stream function, which carries the model
// runtime's credentials and the payload hooks, as Pi's default compaction
// does. Any failure cancels the compaction rather than letting Pi store an
// unfiltered summary.

import {
  compact,
  convertToLlm,
  type AgentSession,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { memoryFactLinesInBranch, withoutMemoryFacts, withoutStatedMemoryFacts } from "../../../main/services/chat-frozen-state.js";
import { prefixContinuesContext, summaryOnCachedPrefix } from "../../../main/services/pi-compaction-core.js";
import type { SideCallPrefix } from "../../../main/services/side-call-prefix.js";

export interface DaemonCompactionMemory {
  session: AgentSession;
  settings: SettingsManager;
  model: Model<Api> | undefined;
  /** Every fact line the always-on prompt told this chat, kept across its turns. */
  toldFacts: ReadonlySet<string>;
  /** The fact lines the chat may be told now; none when memory is off. */
  approvedFactLines?: () => Promise<string[]>;
  /** The chat's last completed session request, while its cache is live. */
  cachedPrefix?: () => Promise<SideCallPrefix | undefined>;
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
    const { agent } = memory.session;
    const result = (facts.length === 0 && event.reason !== "overflow" ? await cachedCompaction(event, memory, model) : undefined)
      ?? await compact(summaryPreparation, model, undefined, undefined, event.customInstructions, signal, thinkingLevel,
        agent.streamFunction, undefined, memory.settings.getRetrySettings());
    // Whichever lines the summarizer wrote, none that states a fact is kept;
    // a fact split across kept lines fails the compaction.
    const kept = withoutStatedMemoryFacts(result.summary, facts);
    if (kept.restated || signal.aborted) return { cancel: true };
    return { compaction: { ...result, summary: kept.text } };
  } catch {
    return { cancel: true };
  }
}

/**
 * The summary as a continuation of the turn's request, or undefined for Pi's
 * isolated request. It is the turn's request bytes, through the session's
 * stream function and payload hook, with the instruction after the reply.
 * Only called once no fact was ever told the chat.
 */
async function cachedCompaction(event: SessionBeforeCompactEvent, memory: DaemonCompactionMemory, model: Model<Api>) {
  let prefix: SideCallPrefix | undefined;
  try { prefix = await memory.cachedPrefix?.(); } catch { return undefined; }
  if (!prefix || !prefixContinuesContext(prefix, model, memory.session.messages)) return undefined;
  const { agent } = memory.session;
  const { preparation } = event;
  const summary = await summaryOnCachedPrefix({
    prefix, model, fileOps: preparation.fileOps, reserveTokens: preparation.settings.reserveTokens,
    signal: event.signal, customInstructions: event.customInstructions,
    approvedMemoryFacts: async () => (await memory.approvedFactLines?.()) ?? [],
    complete: async (requestModel, context, options) =>
      // The continuation is the turn's own transcript context, replayed with the instruction appended.
      (await agent.streamFunction(requestModel, context as TranscriptContext, { ...options, onPayload: agent.onPayload })).result(),
  });
  return summary && { summary: summary.summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
    ...(summary.usage ? { usage: summary.usage } : {}), details: { readFiles: summary.readFiles, modifiedFiles: summary.modifiedFiles } };
}
