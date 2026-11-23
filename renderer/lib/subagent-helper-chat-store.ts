import * as React from "react";
import type { ApprovalPrompt } from "./ipc";
import type { ChatApprovalDecisionOptions } from "../components/chat-approval-card";
import type { SubagentHelperChatApproval } from "../components/subagent-helper-chat";
import { stageComposerText } from "./composer-draft-store";
import { focusRegion } from "./focus-regions";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import {
  mergeSubagentTranscript,
  type LiveSubagentTranscripts,
  type MergedSubagentTranscript,
} from "../shared/subagent-transcript";
import type { SubagentTranscriptV1 } from "../shared/subagent-transcript";
import {
  rememberSubagentHelperTranscript,
  subagentHelperApprovalFor,
  type SavedSubagentHelperTranscripts,
} from "./subagent-helper-chat-state";

export type SubagentHelperApprovalDecide = (
  prompt: ApprovalPrompt,
  decision: "allow" | "deny",
  options?: ChatApprovalDecisionOptions,
) => void | Promise<void>;

/** What one window knows about the presented chat's helper conversations. */
export interface SubagentHelperChatState {
  chatId: string | null;
  saved: SavedSubagentHelperTranscripts;
  live: LiveSubagentTranscripts;
  approvals: readonly ApprovalPrompt[];
  decidingApprovalId: string | null;
  /** The helper whose chat fills the main pane, or null. */
  expandedRunId: string | null;
}

const NO_SAVED: SavedSubagentHelperTranscripts = new Map();
const NO_LIVE: LiveSubagentTranscripts = new Map();
const NO_APPROVALS: readonly ApprovalPrompt[] = [];

export const EMPTY_SUBAGENT_HELPER_CHAT_STATE: SubagentHelperChatState = {
  chatId: null,
  saved: NO_SAVED,
  live: NO_LIVE,
  approvals: NO_APPROVALS,
  decidingApprovalId: null,
  expandedRunId: null,
};

/**
 * Per run, the live updates with the newer revision. The chat's own stream
 * and a detached run's projection can both hold updates for a helper.
 */
export function combineLiveSubagentTranscripts(
  first: LiveSubagentTranscripts | undefined,
  second: LiveSubagentTranscripts | undefined,
): LiveSubagentTranscripts {
  if (!second || second.size === 0) return first ?? NO_LIVE;
  if (!first || first.size === 0) return second;
  const next = new Map(first);
  for (const [runId, update] of second) {
    const current = next.get(runId);
    if (!current || update.revision > current.revision) next.set(runId, update);
  }
  return next;
}

/** The saved copy merged with what has streamed since, for one helper. */
export function subagentHelperChatTranscript(
  state: SubagentHelperChatState,
  runId: string,
): MergedSubagentTranscript {
  return mergeSubagentTranscript(state.saved.get(runId), state.live.get(runId));
}

/** The pending approval this helper waits on, answered from inside its chat. */
export function subagentHelperChatApproval(
  store: SubagentHelperChatStore,
  state: SubagentHelperChatState,
  run: Pick<SubagentRunSnapshot, "runId" | "label">,
  activeRuns: ReadonlyArray<Pick<SubagentRunSnapshot, "runId" | "label">>,
): SubagentHelperChatApproval | null {
  const prompt = subagentHelperApprovalFor(run, state.approvals, activeRuns);
  if (!prompt) return null;
  return {
    prompt,
    deciding: state.decidingApprovalId === prompt.approvalId,
    onDecide: (decision, options) => store.decide(prompt, decision, options),
  };
}

/**
 * Ask main chat to retry: return to the main chat and put the request in its
 * message box, without sending it.
 */
export function askMainChatToRetrySubagent(
  store: SubagentHelperChatStore,
  chatId: string,
  text: string,
): void {
  store.collapse({ restoreFocus: false });
  stageComposerText(chatId, text, { notice: null });
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => focusRegion("composer"));
}

export interface SubagentHelperChatStore {
  getState(): SubagentHelperChatState;
  subscribe(listener: () => void): () => void;
  /** Forget everything when the presented chat changes. */
  reset(chatId: string | null): void;
  rememberSaved(chatId: string, transcript: SubagentTranscriptV1): void;
  syncLive(chatId: string, live: LiveSubagentTranscripts): void;
  syncApprovals(
    chatId: string,
    approvals: readonly ApprovalPrompt[],
    decidingApprovalId: string | null,
    decide: SubagentHelperApprovalDecide | null,
  ): void;
  decide(prompt: ApprovalPrompt, decision: "allow" | "deny", options?: ChatApprovalDecisionOptions): void;
  /** Fill the main pane with this helper's chat. `opener` gets focus back on collapse. */
  expand(runId: string, opener: HTMLElement | null): void;
  /** Return to the main chat; focus goes back to whatever opened the expanded chat. */
  collapse(options?: { restoreFocus?: boolean }): void;
}

export function createSubagentHelperChatStore(): SubagentHelperChatStore {
  let state = EMPTY_SUBAGENT_HELPER_CHAT_STATE;
  let decideHandler: SubagentHelperApprovalDecide | null = null;
  let opener: HTMLElement | null = null;
  const listeners = new Set<() => void>();

  const commit = (next: SubagentHelperChatState) => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const scoped = (chatId: string): SubagentHelperChatState => {
    if (state.chatId === chatId) return state;
    decideHandler = null;
    opener = null;
    return { ...EMPTY_SUBAGENT_HELPER_CHAT_STATE, chatId };
  };
  // Each complete merge is kept as the saved copy, so the conversation stays
  // after the live updates are dropped at the end of the turn.
  const absorb = (
    saved: SavedSubagentHelperTranscripts,
    live: LiveSubagentTranscripts,
  ): SavedSubagentHelperTranscripts => {
    let next = saved;
    for (const [runId, update] of live) {
      const merged = mergeSubagentTranscript(next.get(runId), update);
      if (merged.complete && merged.transcript) {
        next = rememberSubagentHelperTranscript(next, merged.transcript);
      }
    }
    return next;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset(chatId) {
      if (state.chatId === chatId) return;
      decideHandler = null;
      opener = null;
      commit({ ...EMPTY_SUBAGENT_HELPER_CHAT_STATE, chatId });
    },
    rememberSaved(chatId, transcript) {
      const base = scoped(chatId);
      const saved = rememberSubagentHelperTranscript(base.saved, transcript);
      if (base === state && saved === base.saved) return;
      commit({ ...base, saved });
    },
    syncLive(chatId, live) {
      const base = scoped(chatId);
      const saved = absorb(base.saved, live);
      if (base === state && saved === base.saved && live === base.live) return;
      commit({ ...base, saved, live });
    },
    syncApprovals(chatId, approvals, decidingApprovalId, decide) {
      const base = scoped(chatId);
      decideHandler = decide;
      if (
        base === state &&
        approvals === base.approvals &&
        decidingApprovalId === base.decidingApprovalId
      ) {
        return;
      }
      commit({ ...base, approvals, decidingApprovalId });
    },
    decide(prompt, decision, options) {
      void decideHandler?.(prompt, decision, options);
    },
    expand(runId, nextOpener) {
      if (!state.chatId) return;
      if (state.expandedRunId !== runId || nextOpener) opener = nextOpener;
      if (state.expandedRunId === runId) return;
      commit({ ...state, expandedRunId: runId });
    },
    collapse(options) {
      const target = opener;
      opener = null;
      if (state.expandedRunId !== null) commit({ ...state, expandedRunId: null });
      if (options?.restoreFocus !== false && target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    },
  };
}

export const SubagentHelperChatStoreContext = React.createContext<SubagentHelperChatStore | null>(
  null,
);

/** The window's helper chat store, or null outside the environment panel. */
export function useSubagentHelperChatStore(): SubagentHelperChatStore | null {
  return React.useContext(SubagentHelperChatStoreContext);
}

/** Subscribe to the helper chat state; the empty state when there is no store. */
export function useSubagentHelperChatState(): SubagentHelperChatState {
  const store = useSubagentHelperChatStore();
  const subscribe = React.useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store],
  );
  const getState = React.useCallback(
    () => store?.getState() ?? EMPTY_SUBAGENT_HELPER_CHAT_STATE,
    [store],
  );
  return React.useSyncExternalStore(subscribe, getState, getState);
}
