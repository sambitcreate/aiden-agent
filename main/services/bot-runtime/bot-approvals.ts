// Profile-owned approval waits. Durable identity and provenance stay in main;
// only the explicitly copied public card fields cross IPC.
import { botApprovalRuleKey } from "../../../renderer/shared/tool-approval-scope.js";
import { ToolApprovalCoordinator, type ToolApprovalOutcome } from "../tool-approval.js";
import type { BotApprovalDecision, BotApprovalOwner, BotApprovalRequest, BotAllowListRelease } from "./bot-extension.js";

export type BotApprovalDecisionSource = BotApprovalDecision["source"];
export type BotApprovalRequestOutcome = BotApprovalDecision;
export interface BotApprovalPrompt {
  owner?: BotApprovalOwner;
  decisionSource?: BotApprovalDecisionSource;
  authorizationFingerprint?: string;
  allowList?: BotApprovalRequest["allowList"];
  always?: { key: string; count: number };
  botId: string;
  waitId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
}
export function publicBotApprovalPrompt(prompt: BotApprovalPrompt): Pick<BotApprovalPrompt, "botId" | "waitId" | "toolCallId" | "toolName" | "summary" | "always"> {
  return { botId: prompt.botId, waitId: prompt.waitId, toolCallId: prompt.toolCallId, toolName: prompt.toolName, summary: prompt.summary,
    ...(prompt.always ? { always: { key: prompt.always.key, count: prompt.always.count } } : {}) };
}
export interface BotApprovals {
  request(request: BotApprovalRequest): Promise<BotApprovalDecision>;
  requestOutcome(request: BotApprovalRequest): Promise<BotApprovalDecision>;
  decide(waitId: string, decision: "allow" | "deny", scope?: "always", source?: BotApprovalDecisionSource): boolean;
  releaseFromAllowList(waitId: string, grant: BotAllowListRelease): Promise<boolean>;
  pending(botId?: string): BotApprovalPrompt[];
  onChange(listener: (botId: string) => void): () => void;
}
export type BotApprovalDecisionLookup = (botId: string, id: string, authorizationFingerprint: string) => Promise<BotApprovalDecision | undefined>;
export interface BotApprovalsOptions {
  publish(prompt: BotApprovalPrompt): void;
  withdraw?(prompt: BotApprovalPrompt, outcome: ToolApprovalOutcome): void;
  lookupDecision?: BotApprovalDecisionLookup;
}
interface Waiting {
  request: BotApprovalRequest;
  prompt?: BotApprovalPrompt;
  controller: AbortController;
  claimed: boolean;
  source?: BotApprovalDecisionSource;
  replacement?: BotApprovalDecision;
  result: Promise<BotApprovalDecision>;
}
const STREAM_PREFIX = "bot:";
function assertActive(request: BotApprovalRequest) { request.signal?.throwIfAborted(); }
function clearCallbacks(state: Waiting) {
  state.request.assertCurrent = undefined;
  state.request.prepareAllowListRelease = undefined;
}
export function createBotApprovals(options: BotApprovalsOptions): BotApprovals {
  const requests = new Map<string, Waiting>(), waiting = new Map<string, Waiting>();
  const listeners = new Set<(botId: string) => void>();
  const changed = (botId: string) => { for (const listener of listeners) listener(botId); };
  const coordinator = new ToolApprovalCoordinator(prompt => {
    const state = requests.get(prompt.approvalId);
    if (!state) throw new Error("The approval request was withdrawn.");
    const request = state.request;
    const published: BotApprovalPrompt = { botId: request.botId, waitId: request.waitId, toolCallId: request.toolCallId,
      toolName: request.toolName, summary: request.summary, authorizationFingerprint: request.authorizationFingerprint,
      ...(request.owner ? { owner: structuredClone(request.owner) } : {}), ...(request.always ? { always: { ...request.always } } : {}),
      ...(request.allowList ? { allowList: structuredClone(request.allowList) } : {}) };
    state.prompt = published; waiting.set(request.waitId, state);
    options.publish(published); changed(request.botId);
  }, (id, outcome) => {
    const state = waiting.get(id); waiting.delete(id);
    if (state?.prompt) {
      clearCallbacks(state);
      options.withdraw?.(state.prompt, outcome); changed(state.prompt.botId);
    }
  });
  async function request(input: BotApprovalRequest): Promise<BotApprovalDecision> {
    const captured = { ...input, owner: structuredClone(input.owner), always: structuredClone(input.always), allowList: structuredClone(input.allowList) };
    assertActive(captured);
    if (captured.assertCurrent) await captured.assertCurrent();
    assertActive(captured);
    // Lookup here follows scope-proven allow-list metadata. Rule-made and
    // Computer Use cards without it must not depend on this ledger.
    if (captured.allowList && options.lookupDecision) {
      const saved = await options.lookupDecision(captured.botId, captured.waitId, captured.authorizationFingerprint);
      await captured.assertCurrent?.(); assertActive(captured);
      if (saved) {
        if (saved.id !== captured.waitId || saved.authorizationFingerprint !== captured.authorizationFingerprint)
          throw new Error("The saved approval decision identity or fingerprint changed.");
        return structuredClone(saved);
      }
    }
    const previous = requests.get(captured.waitId);
    if (previous && !previous.controller.signal.aborted && previous.request.botId === captured.botId &&
        previous.request.authorizationFingerprint === captured.authorizationFingerprint) return previous.result;
    previous?.controller.abort(new Error("The approval was replaced."));
    let resolve!: (value: BotApprovalDecision) => void, reject!: (reason: unknown) => void;
    const result = new Promise<BotApprovalDecision>((yes, no) => { resolve = yes; reject = no; });
    const state: Waiting = { request: captured, controller: new AbortController(), claimed: false, result };
    const abort = () => state.controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    requests.set(captured.waitId, state);
    const complete = async (): Promise<BotApprovalDecision> => {
      try {
        const streamId = `${STREAM_PREFIX}${captured.botId}`;
        const outcome = await coordinator.request({
          streamId,
          approvalId: captured.waitId,
          // Payloads are keyed by this private attempt ID, not a reused provider call ID.
          toolCallId: captured.waitId,
          toolName: captured.toolName,
          summary: captured.summary,
          ...(captured.always ? { scopes: ["once", "always"] as const } : {}),
        }, state.controller.signal);
        state.controller.signal.throwIfAborted();
        assertActive(captured);
        const payload = coordinator.takeDecisionPayload(streamId, captured.waitId);
        if (state.replacement) return state.replacement;
        if ((outcome !== "allowed" && outcome !== "denied") || !state.source) {
          throw new Error("The approval was withdrawn or unavailable.");
        }
        return {
          id: captured.waitId,
          authorizationFingerprint: captured.authorizationFingerprint,
          answer: outcome === "denied" ? "deny" : payload?.scope === "always" ? "allow_always" : "allow",
          source: state.source,
        };
      } finally {
        clearCallbacks(state);
        input.signal?.removeEventListener("abort", abort);
        if (requests.get(captured.waitId) === state) requests.delete(captured.waitId);
        if (waiting.get(captured.waitId) === state) {
          waiting.delete(captured.waitId);
          if (state.prompt) {
            try { options.withdraw?.(state.prompt, "unavailable"); }
            catch { /* Presentation failure cannot retain an authorization capability. */ }
            changed(captured.botId);
          }
        }
      }
    };
    void complete().then(resolve, reject);
    return result;
  }
  return {
    request, requestOutcome: request,
    decide(id, decision, scope, source = "person") {
      const state = waiting.get(id);
      if (!state || state.claimed) return false;
      state.claimed = true; state.source = source;
      if (state.prompt) state.prompt.decisionSource = source;
      return coordinator.decideAsHost(id, decision === "allow", scope ? { scope } : undefined);
    },
    async releaseFromAllowList(id, input) {
      const state = waiting.get(id), grant = structuredClone(input);
      if (!state || state.claimed || !state.request.prepareAllowListRelease || !state.request.allowList ||
          botApprovalRuleKey(state.request.allowList.target) !== botApprovalRuleKey(grant.target)) return false;
      state.claimed = true;
      try {
        const prepare = state.request.prepareAllowListRelease;
        if (state.request.assertCurrent) await state.request.assertCurrent();
        if (waiting.get(id) !== state || state.controller.signal.aborted) return false;
        const result = await prepare(grant);
        if (waiting.get(id) !== state || state.controller.signal.aborted || !result || result.id === id ||
            result.source !== "allow_list" || result.answer !== "allow" || !result.authorizationFingerprint) return false;
        if (state.request.assertCurrent) await state.request.assertCurrent();
        if (waiting.get(id) !== state || state.controller.signal.aborted) return false;
        state.replacement = structuredClone(result); state.source = "allow_list";
        if (state.prompt) state.prompt.decisionSource = "allow_list";
        return coordinator.decideAsHost(id, true);
      } catch { return false; }
      finally { if (waiting.get(id) === state) state.claimed = false; }
    },
    pending(botId) { return [...waiting.values()].flatMap(state => state.prompt && (botId === undefined || state.prompt.botId === botId) ? [state.prompt] : []); },
    onChange(listener) { listeners.add(listener); return () => void listeners.delete(listener); },
  };
}
