import * as React from "react";
import type { ApprovalPrompt } from "./ipc";
import type { ChatApprovalDecisionOptions } from "../components/chat-approval-card";
import { stageComposerText } from "./composer-draft-store";
import { focusRegion } from "./focus-regions";
import {
  mergeSubagentTranscript,
  type LiveSubagentTranscripts,
  type MergedSubagentTranscript,
} from "../shared/subagent-transcript";
import type { SubagentTranscriptV1 } from "../shared/subagent-transcript";
import {
  rememberSubagentHelperTranscript,
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
  /** The main chat has a question waiting for the person. */
  questionPending: boolean;
}

/** Marks the side panel helper chat's Expand button, the usual opener of the expanded chat; its value is the helper's runId. */
export const HELPER_EXPAND_ATTRIBUTE = "data-subagent-helper-expand";

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
  questionPending: false,
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
/**
 * Of these runs, the ones whose conversation just arrived whole: their saved
 * copy or live updates changed and now merge into a complete transcript.
 * A failed read for such a run no longer matters.
 */
export function subagentHelperTranscriptsRecovered(
  previous: SubagentHelperChatState,
  next: SubagentHelperChatState,
  runIds: readonly string[],
): string[] {
  if (previous.chatId !== next.chatId) return [];
  return runIds.filter((runId) => {
    const changed =
      previous.saved.get(runId) !== next.saved.get(runId) ||
      previous.live.get(runId) !== next.live.get(runId);
    if (!changed) return false;
    const merged = subagentHelperChatTranscript(next, runId);
    return merged.complete && merged.transcript !== null;
  });
}

/** What the main chat waits on that this helper's chat cannot answer. */
export type MainChatWaitingKind = "approval" | "question";

/**
 * What the main chat waits on beyond this helper's own approvals, or null.
 * The main chat's card shows the first approval, so a question comes first
 * when that card is this helper's own.
 */
export function mainChatWaitingFor(
  state: Pick<SubagentHelperChatState, "approvals" | "questionPending">,
  ownApprovalIds: ReadonlySet<string>,
): MainChatWaitingKind | null {
  const first = state.approvals[0];
  if (first && !ownApprovalIds.has(first.approvalId)) return "approval";
  if (state.questionPending) return "question";
  return state.approvals.some((prompt) => !ownApprovalIds.has(prompt.approvalId))
    ? "approval"
    : null;
}

/**
 * Ask the main chat to retry: return to the main chat and put the request in its
 * message box, without sending it. A request already in the box is not added again.
 */
export function askMainChatToRetrySubagent(
  store: SubagentHelperChatStore,
  chatId: string,
  text: string,
): void {
  store.collapse({ restoreFocus: false });
  stageComposerText(chatId, text, { notice: null, once: true });
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
  /** The main chat says whether a question is waiting and how to bring focus to what waits. */
  syncMainWaiting(
    chatId: string,
    questionPending: boolean,
    focusWaiting: ((kind: MainChatWaitingKind) => void) | null,
  ): void;
  /** Return to the main chat and put focus on the approval or question waiting there. */
  returnToMainWaiting(kind: MainChatWaitingKind): void;
  /** Put focus on the main chat's approval or question without collapsing anything. */
  focusMainWaiting(kind: MainChatWaitingKind): void;
}

export function createSubagentHelperChatStore(): SubagentHelperChatStore {
  let state = EMPTY_SUBAGENT_HELPER_CHAT_STATE;
  let decideHandler: SubagentHelperApprovalDecide | null = null;
  let opener: HTMLElement | null = null;
  let focusWaitingHandler: ((kind: MainChatWaitingKind) => void) | null = null;
  const listeners = new Set<() => void>();

  const commit = (next: SubagentHelperChatState) => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  // On a chat switch, the old chat's maps can arrive once more (from whichever
  // sync runs second) before the new chat's own replace them; they are never
  // the new chat's.
  let staleLive: LiveSubagentTranscripts | null = null;
  let staleApprovals: readonly ApprovalPrompt[] | null = null;
  const forgetChat = () => {
    staleLive = state.live === NO_LIVE ? null : state.live;
    staleApprovals = state.approvals === NO_APPROVALS ? null : state.approvals;
    decideHandler = null;
    focusWaitingHandler = null;
    opener = null;
  };
  const scoped = (chatId: string): SubagentHelperChatState => {
    if (state.chatId === chatId) return state;
    forgetChat();
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
      forgetChat();
      commit({ ...EMPTY_SUBAGENT_HELPER_CHAT_STATE, chatId });
    },
    rememberSaved(chatId, transcript) {
      // A late answer for a chat that is no longer presented is dropped.
      if (state.chatId !== null && state.chatId !== chatId) return;
      const base = scoped(chatId);
      const saved = rememberSubagentHelperTranscript(base.saved, transcript);
      if (base === state && saved === base.saved) return;
      commit({ ...base, saved });
    },
    syncLive(chatId, nextLive) {
      const base = scoped(chatId);
      const live = nextLive === staleLive ? NO_LIVE : nextLive;
      const saved = absorb(base.saved, live);
      if (base === state && saved === base.saved && live === base.live) return;
      commit({ ...base, saved, live });
    },
    syncApprovals(chatId, nextApprovals, decidingApprovalId, decide) {
      const base = scoped(chatId);
      const approvals = nextApprovals === staleApprovals ? NO_APPROVALS : nextApprovals;
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
      const runId = state.expandedRunId;
      opener = null;
      if (runId !== null) commit({ ...state, expandedRunId: null });
      if (options?.restoreFocus === false || !target) return;
      if (target.isConnected) {
        target.focus({ preventScroll: true });
        return;
      }
      // The side panel swaps its helper chat for a placeholder while expanded, so
      // its Expand button is a new element after collapse. Focus that one once it
      // renders, but only if it is the same helper's: the side panel may show
      // another helper by then. Otherwise the message box takes focus.
      if (typeof window === "undefined" || typeof document === "undefined") return;
      const replaceable = runId !== null && target.getAttribute(HELPER_EXPAND_ATTRIBUTE) === runId;
      window.requestAnimationFrame(() => {
        const replacement = replaceable
          ? Array.from(document.querySelectorAll<HTMLElement>(`[${HELPER_EXPAND_ATTRIBUTE}]`)).find(
              (element) => element.getAttribute(HELPER_EXPAND_ATTRIBUTE) === runId,
            )
          : undefined;
        if (replacement) replacement.focus({ preventScroll: true });
        else focusRegion("composer");
      });
    },
    syncMainWaiting(chatId, questionPending, focusWaiting) {
      const base = scoped(chatId);
      focusWaitingHandler = focusWaiting;
      if (base === state && questionPending === base.questionPending) return;
      commit({ ...base, questionPending });
    },
    returnToMainWaiting(kind) {
      const focusWaiting = focusWaitingHandler;
      this.collapse({ restoreFocus: false });
      if (typeof window === "undefined") return;
      window.requestAnimationFrame(() => focusWaiting?.(kind));
    },
    focusMainWaiting(kind) {
      focusWaitingHandler?.(kind);
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
  return useSubagentHelperChatSelector(selectWholeState);
}

const selectWholeState = (state: SubagentHelperChatState) => state;

/**
 * Subscribe to one slice of the helper chat state. The component re-renders only
 * when the slice changes, so a streamed token does not redraw what ignores it.
 * `select` should return a primitive or a value the state already holds.
 */
export function useSubagentHelperChatSelector<T>(select: (state: SubagentHelperChatState) => T): T {
  const store = useSubagentHelperChatStore();
  const subscribe = React.useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store],
  );
  const getSlice = () => select(store?.getState() ?? EMPTY_SUBAGENT_HELPER_CHAT_STATE);
  return React.useSyncExternalStore(subscribe, getSlice, getSlice);
}
