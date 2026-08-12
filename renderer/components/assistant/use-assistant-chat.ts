// Chat state for the Aiden assistant window. Threads live in the reserved
// "assistant" workspace so the main window's sidebar never lists them, and every
// generation carries mode: "assistant" so main swaps in the Aiden persona and
// tool set.

import * as React from "react";
import {
  chatsApi,
  createChatTurnId,
  onNotification,
  startGeneration,
  type ApprovalPrompt,
  type GenerationHandle,
  type StreamCallbacks,
} from "../../lib/ipc";
import type { Chat, ChatMeta } from "../../lib/types";
import { useProviders } from "../../lib/queries";
import {
  isModelSelectionAvailable,
  readModelSelection,
  subscribeModelSelection,
} from "../../lib/use-model-selection";
import { STREAMING_REVEAL_FALLBACK_MS } from "../../lib/streaming-reveal";
import {
  ASSISTANT_AUTOMATION_EDIT_TOOL_NAME,
  ASSISTANT_AUTOMATION_TOOL_NAME,
  ASSISTANT_WORKSPACE_ID,
  isAssistantAutomationApprovalDetails,
} from "../../shared/assistant";
import { appendReconciliationFailureKind } from "../../shared/chat-message-contract";
import { useAppendReconciliationRequired } from "../../lib/append-reconciliation";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export type AssistantGenerationPhase = "idle" | "streaming" | "stopping";

export function assistantGenerationIsActive(
  phase: AssistantGenerationPhase,
): boolean {
  return phase !== "idle";
}

export function assistantGenerationPhaseAfterStop(
  phase: AssistantGenerationPhase,
  hasActiveGeneration: boolean,
): AssistantGenerationPhase {
  return phase === "streaming" && hasActiveGeneration ? "stopping" : phase;
}

export function canChangeAssistantThread(state: {
  conversationLoading: boolean;
  streaming: boolean;
  rendering: boolean;
  turnSaving: boolean;
}): boolean {
  return (
    !state.conversationLoading &&
    !state.streaming &&
    !state.rendering &&
    !state.turnSaving
  );
}

/**
 * Pure send guard, kept separate from the hook so its rules are unit-testable
 * without a DOM or an IPC bridge.
 */
export function canSendAssistantMessage(
  draft: string,
  state: { streaming: boolean; ready: boolean },
): boolean {
  return draft.trim().length > 0 && !state.streaming && state.ready;
}

/** Reconcile a terminal response even when the transport emitted no deltas. */
export function settleAssistantMessages(
  messages: AssistantMessage[],
  fullContent: string,
): AssistantMessage[] {
  if (!fullContent.trim()) return messages;
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") {
    return [...messages, { role: "assistant", content: fullContent }];
  }
  if (last.content === fullContent) return messages;
  return [
    ...messages.slice(0, -1),
    { role: "assistant", content: fullContent },
  ];
}

/** Preserve the best partial reply when a generation terminates with an error. */
export function settleFailedAssistantMessages(
  messages: AssistantMessage[],
  partialContent: string | undefined,
  bufferedDelta: string,
): AssistantMessage[] {
  if (partialContent?.trim())
    return settleAssistantMessages(messages, partialContent);
  if (bufferedDelta) {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      return [
        ...messages.slice(0, -1),
        { role: "assistant", content: last.content + bufferedDelta },
      ];
    }
  }
  const last = messages[messages.length - 1];
  return last?.role === "assistant" && last.content === ""
    ? messages.slice(0, -1)
    : messages;
}

/** Remove a user turn that never reached durable chat history and its placeholder. */
export function rollbackOptimisticAssistantTurn(
  messages: AssistantMessage[],
  userContent: string,
): AssistantMessage[] {
  let end = messages.length;
  const last = messages[end - 1];
  if (last?.role === "assistant" && last.content === "") end -= 1;
  const user = messages[end - 1];
  if (user?.role === "user" && user.content === userContent) end -= 1;
  return end === messages.length ? messages : messages.slice(0, end);
}

/**
 * An indeterminate append may already be durable, so preserve its user row
 * and remove only the unsent assistant placeholder. Ordinary pre-commit
 * failures remain safe to roll back completely.
 */
export function settleAssistantAppendFailure(
  messages: AssistantMessage[],
  userContent: string,
  reconciliationRequired: boolean,
): AssistantMessage[] {
  if (!reconciliationRequired)
    return rollbackOptimisticAssistantTurn(messages, userContent);
  const last = messages[messages.length - 1];
  return last?.role === "assistant" && last.content === ""
    ? messages.slice(0, -1)
    : messages;
}

export function enqueueAssistantApproval(
  approvals: ApprovalPrompt[],
  prompt: ApprovalPrompt,
): ApprovalPrompt[] {
  return approvals.some((approval) => approval.approvalId === prompt.approvalId)
    ? approvals
    : [...approvals, prompt];
}

export function isAssistantAutomationApproval(prompt: ApprovalPrompt): boolean {
  if (!isAssistantAutomationApprovalDetails(prompt.details)) return false;
  return prompt.details.action === "create"
    ? prompt.toolName === ASSISTANT_AUTOMATION_TOOL_NAME
    : prompt.toolName === ASSISTANT_AUTOMATION_EDIT_TOOL_NAME;
}

export function assistantStreamHandoffFallbackMs(
  reducedMotion: boolean,
): number {
  return reducedMotion ? 0 : STREAMING_REVEAL_FALLBACK_MS;
}

/** Something the collapsed mark should surface: a reply, failure, or approval. */
export interface AssistantNotice {
  kind: "reply" | "error" | "approval";
  text: string;
  /** Monotonic marker so consumers can tell a new notice from a re-render. */
  at: number;
}

/** Why the composer is unavailable, so the panel can say something true. */
export type AssistantReadiness =
  | "ready"
  | "loading"
  | "conversation-loading"
  | "stopping"
  | "rendering"
  | "turn-saving"
  | "reload-required"
  | "unavailable"
  | "unset";

export interface AssistantChat {
  messages: AssistantMessage[];
  streaming: boolean;
  streamComplete: boolean;
  error: string | null;
  ready: boolean;
  readiness: AssistantReadiness;
  canChangeThread: boolean;
  threads: ChatMeta[];
  activeChatId: string | null;
  lastNotice: AssistantNotice | null;
  approvals: ApprovalPrompt[];
  decidingApprovalId: string | null;
  send: (text: string, restoreDraft?: (text: string) => void) => void;
  stop: () => void;
  finishStreamHandoff: () => void;
  decideApproval: (
    prompt: ApprovalPrompt,
    decision: "allow" | "deny",
  ) => Promise<void>;
  openThread: (chatId: string) => void;
  newThread: () => void;
}

function visibleMessages(chat: Chat | null): AssistantMessage[] {
  return (chat?.messages ?? [])
    .filter(
      (message): message is typeof message & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({ role: message.role, content: message.content }));
}

export function useAssistantChat(): AssistantChat {
  const [messages, setMessages] = React.useState<AssistantMessage[]>([]);
  const [generationPhase, setGenerationPhase] =
    React.useState<AssistantGenerationPhase>("idle");
  const streaming = assistantGenerationIsActive(generationPhase);
  const [streamComplete, setStreamComplete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastNotice, setLastNotice] = React.useState<AssistantNotice | null>(
    null,
  );
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<
    string | null
  >(null);
  // Aiden follows the app-wide model selection rather than owning one. Mounting
  // useModelSelection here would fork it: that hook keeps per-instance state
  // seeded once at mount, so the dock would never see the composer switch
  // models. Read storage at the point of use instead.
  const providers = useProviders();
  const [selection, setSelection] = React.useState(readModelSelection);
  const [conversationLoading, setConversationLoading] = React.useState(false);
  const conversationLoadingRef = React.useRef(false);
  const [turnSaving, setTurnSaving] = React.useState(false);
  const [appendReconciliationRequired, setAppendReconciliationRequired] =
    React.useState(false);
  const documentAppendReconciliationRequired =
    useAppendReconciliationRequired();
  const reloadRequired =
    appendReconciliationRequired || documentAppendReconciliationRequired;
  const modelReady = isModelSelectionAvailable(selection, providers.data);
  const ready =
    modelReady &&
    !conversationLoading &&
    !turnSaving &&
    !reloadRequired &&
    !streamComplete &&
    generationPhase !== "stopping";
  const readiness: AssistantReadiness = reloadRequired
    ? "reload-required"
    : conversationLoading
      ? "conversation-loading"
      : turnSaving
        ? "turn-saving"
        : generationPhase === "stopping"
          ? "stopping"
          : streamComplete
            ? "rendering"
            : modelReady
              ? "ready"
              : providers.isLoading
                ? "loading"
                : providers.isError
                  ? "unavailable"
                  : "unset";
  const canChangeThread =
    canChangeAssistantThread({
      conversationLoading,
      streaming,
      rendering: streamComplete,
      turnSaving,
    }) && !reloadRequired;
  const [threads, setThreads] = React.useState<ChatMeta[]>([]);
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const handleRef = React.useRef<GenerationHandle | null>(null);
  // Every async continuation below checks this before touching state. Without
  // it, a cancelled turn's late chat:done clears `streaming` for the turn that
  // replaced it, and a create() that resolves after New/Stop starts a
  // generation nothing can reach.
  const turnRef = React.useRef(0);
  // Guards a slow chats:get landing after a newer one, which would otherwise
  // leave thread A's transcript sitting under thread B's id.
  const loadTokenRef = React.useRef(0);
  // Stop can arrive while the first turn is still being written. Remember that
  // boundary so the durable chat is adopted without starting generation.
  const persistingTurnRef = React.useRef<number | null>(null);
  const stoppedPersistingTurnRef = React.useRef<number | null>(null);
  const stoppingTurnRef = React.useRef<number | null>(null);
  const noticeSequenceRef = React.useRef(0);
  const decidingApprovalRef = React.useRef<string | null>(null);

  const fail = React.useCallback((message: string) => {
    setError(message);
    setLastNotice({
      kind: "error",
      text: message,
      at: ++noticeSequenceRef.current,
    });
  }, []);

  const refreshThreads = React.useCallback(() => {
    void chatsApi
      .list(ASSISTANT_WORKSPACE_ID)
      .then(setThreads)
      // Best effort: a background refresh must not interrupt the user. A stale
      // list is the cost, and the next metadata update retries.
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    refreshThreads();
  }, [refreshThreads]);

  React.useEffect(
    () => onNotification("chats:metadata-updated", refreshThreads),
    [refreshThreads],
  );

  React.useEffect(() => {
    const removeApproval = onNotification<ApprovalPrompt & { streamId: string }>(
      "chat:approval",
      (prompt) => {
        if (!prompt.streamId.startsWith("live:") || prompt.toolName !== "computer_use") return;
        setApprovals((existing) => enqueueAssistantApproval(existing, prompt));
        setLastNotice({
          kind: "approval",
          text: "Computer Use needs your confirmation",
          at: ++noticeSequenceRef.current,
        });
      },
    );
    const removeWithdrawal = onNotification<{ approvalId: string }>(
      "chat:approval-withdrawn",
      ({ approvalId }) => {
        setApprovals((existing) =>
          existing.filter((approval) => approval.approvalId !== approvalId),
        );
        if (decidingApprovalRef.current === approvalId) {
          decidingApprovalRef.current = null;
          setDecidingApprovalId(null);
        }
      },
    );
    return () => {
      removeApproval();
      removeWithdrawal();
    };
  }, []);

  // The composer can change the model while the dock sits idle.
  React.useEffect(() => subscribeModelSelection(setSelection), []);

  /** Abandon any running generation and invalidate its pending callbacks. */
  const abandonTurn = React.useCallback((origin: "lifecycle" | "user_stop") => {
    turnRef.current += 1;
    handleRef.current?.cancel(origin);
    handleRef.current = null;
    stoppingTurnRef.current = null;
  }, []);

  React.useEffect(() => () => abandonTurn("lifecycle"), [abandonTurn]);

  // A formatting/highlighting failure replaces the streaming renderer with its
  // raw-text fallback, so its normal handoff callback cannot fire. Match the
  // main transcript's bounded escape hatch to keep the dock usable.
  React.useEffect(() => {
    if (!streamComplete) return;
    const reducedMotion =
      document.documentElement.dataset.reduceMotion === "true";
    const timer = window.setTimeout(
      () => setStreamComplete(false),
      assistantStreamHandoffFallbackMs(reducedMotion),
    );
    return () => window.clearTimeout(timer);
  }, [streamComplete]);

  const loadThread = React.useCallback(
    (chatId: string) => {
      if (
        !canChangeThread ||
        persistingTurnRef.current !== null ||
        handleRef.current
      ) {
        return;
      }
      // Switching threads mid-stream would otherwise keep appending the old
      // thread's deltas onto the new transcript while main persisted them to
      // the old chat — what you saw would not be what was on disk.
      abandonTurn("lifecycle");
      stoppedPersistingTurnRef.current = null;
      stoppingTurnRef.current = null;
      setTurnSaving(false);
      setGenerationPhase("idle");
      setStreamComplete(false);
      setApprovals([]);
      setDecidingApprovalId(null);
      decidingApprovalRef.current = null;
      const token = ++loadTokenRef.current;
      conversationLoadingRef.current = true;
      setConversationLoading(true);
      setError(null);
      setActiveChatId(null);
      setMessages([]);
      void chatsApi
        .get(chatId)
        .then((chat: Chat | null) => {
          if (token !== loadTokenRef.current) return;
          // chats:get answers null for "unreadable" as well as "missing", and a
          // thread we just listed is not missing. Adopting the id here would let
          // the next send append to a conversation we could not read, so refuse
          // the thread rather than silently opening it empty.
          if (!chat) {
            conversationLoadingRef.current = false;
            setConversationLoading(false);
            fail("Aiden could not open that conversation.");
            return;
          }
          setActiveChatId(chatId);
          setMessages(visibleMessages(chat));
          conversationLoadingRef.current = false;
          setConversationLoading(false);
        })
        .catch((cause: unknown) => {
          if (token !== loadTokenRef.current) return;
          conversationLoadingRef.current = false;
          setConversationLoading(false);
          fail(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [abandonTurn, canChangeThread, fail],
  );

  const newThread = React.useCallback(() => {
    if (
      !canChangeThread ||
      persistingTurnRef.current !== null ||
      handleRef.current
    ) {
      return;
    }
    abandonTurn("lifecycle");
    stoppedPersistingTurnRef.current = null;
    stoppingTurnRef.current = null;
    setTurnSaving(false);
    loadTokenRef.current += 1;
    conversationLoadingRef.current = false;
    setConversationLoading(false);
    setGenerationPhase("idle");
    setStreamComplete(false);
    setApprovals([]);
    setDecidingApprovalId(null);
    decidingApprovalRef.current = null;
    setMessages([]);
    setError(null);
    setActiveChatId(null);
  }, [abandonTurn, canChangeThread]);

  const send = React.useCallback(
    (text: string, restoreDraft?: (text: string) => void) => {
      // Read the selection fresh: the composer may have switched models since
      // the last focus sync.
      const current = readModelSelection();
      if (
        conversationLoadingRef.current ||
        stoppedPersistingTurnRef.current === turnRef.current ||
        !canSendAssistantMessage(text, {
          streaming,
          ready:
            isModelSelectionAvailable(current, providers.data) &&
            !streamComplete &&
            !turnSaving &&
            !reloadRequired,
        })
      ) {
        return;
      }
      setSelection(current);
      const { providerId, model } = current;
      const content = text.trim();
      const turn = ++turnRef.current;
      const isCurrent = () => turn === turnRef.current;
      setError(null);
      setStreamComplete(false);
      setApprovals([]);
      setDecidingApprovalId(null);
      decidingApprovalRef.current = null;
      setGenerationPhase("streaming");
      setMessages((existing) => [
        ...existing,
        { role: "user", content },
        { role: "assistant", content: "" },
      ]);

      /** Drop the optimistic placeholder so a failed turn cannot poison history. */
      const dropEmptyPlaceholder = () => {
        setMessages((existing) => {
          const last = existing[existing.length - 1];
          return last?.role === "assistant" && last.content === ""
            ? existing.slice(0, -1)
            : existing;
        });
      };

      let pendingDelta = "";
      let deltaFrame: number | null = null;
      const clearPendingDelta = () => {
        if (deltaFrame !== null) cancelAnimationFrame(deltaFrame);
        deltaFrame = null;
        pendingDelta = "";
      };
      const flushDelta = () => {
        deltaFrame = null;
        if (!isCurrent() || !pendingDelta) {
          pendingDelta = "";
          return;
        }
        const contentDelta = pendingDelta;
        pendingDelta = "";
        setMessages((existing) => {
          const next = [...existing];
          const last = next[next.length - 1];
          if (last?.role === "assistant")
            next[next.length - 1] = {
              role: "assistant",
              content: last.content + contentDelta,
            };
          return next;
        });
      };
      const appendDelta = (delta: string) => {
        if (!isCurrent() || stoppingTurnRef.current === turn) return;
        pendingDelta += delta;
        if (deltaFrame === null) deltaFrame = requestAnimationFrame(flushDelta);
      };

      const messageTurnId = createChatTurnId();
      const run = (chatId: string) => {
        if (!isCurrent()) return;
        const callbacks: StreamCallbacks = {
          onDelta: appendDelta,
          onDone: (fullContent) => {
            if (!isCurrent()) return;
            clearPendingDelta();
            if (stoppingTurnRef.current === turn)
              stoppingTurnRef.current = null;
            setGenerationPhase("idle");
            handleRef.current = null;
            setApprovals([]);
            setDecidingApprovalId(null);
            decidingApprovalRef.current = null;
            // A cancelled generation still reports done, with no content.
            if (fullContent.trim()) {
              setMessages((existing) =>
                settleAssistantMessages(existing, fullContent),
              );
              setStreamComplete(true);
              setLastNotice({
                kind: "reply",
                text: fullContent,
                at: ++noticeSequenceRef.current,
              });
            } else {
              setStreamComplete(false);
              dropEmptyPlaceholder();
            }
            refreshThreads();
          },
          onError: (message, partialContent) => {
            if (!isCurrent()) return;
            const stoppedByUser = stoppingTurnRef.current === turn;
            if (stoppedByUser) stoppingTurnRef.current = null;
            const bufferedDelta = pendingDelta;
            clearPendingDelta();
            setGenerationPhase("idle");
            setStreamComplete(false);
            handleRef.current = null;
            setApprovals([]);
            setDecidingApprovalId(null);
            decidingApprovalRef.current = null;
            setMessages((existing) =>
              settleFailedAssistantMessages(
                existing,
                partialContent,
                bufferedDelta,
              ),
            );
            if (stoppedByUser) refreshThreads();
            fail(message);
          },
          onApproval: (prompt) => {
            if (!isAssistantAutomationApproval(prompt)) {
              void chatsApi
                .approve(prompt.approvalId, "deny")
                .catch((cause: unknown) => {
                  if (!isCurrent()) return;
                  fail(
                    cause instanceof Error
                      ? cause.message
                      : "Aiden could not deny an unexpected tool request, so the response was stopped.",
                  );
                  handleRef.current?.cancel("user_stop");
                });
              if (isCurrent()) {
                fail(
                  `Aiden blocked the unexpected ${prompt.toolName} approval request.`,
                );
              }
              return;
            }
            if (!isCurrent()) {
              void chatsApi
                .approve(prompt.approvalId, "deny")
                .catch(() => undefined);
              return;
            }
            setApprovals((existing) =>
              enqueueAssistantApproval(existing, prompt),
            );
            setLastNotice({
              kind: "approval",
              text: "Automation needs your confirmation",
              at: ++noticeSequenceRef.current,
            });
          },
        };
        handleRef.current = startGeneration(
          {
            chatId,
            workspaceId: ASSISTANT_WORKSPACE_ID,
            providerId,
            model,
            mode: "assistant",
          },
          callbacks,
          messageTurnId,
        );
      };

      // Persist the user's turn first, exactly as the main window's composer
      // does. Main only ever appends the assistant side, so skipping this wrote
      // reply-only transcripts to disk and every reopened thread came back with
      // its questions missing.
      let persistenceChatId = activeChatId;
      let createdChatId: string | undefined;
      const persist = async (): Promise<Chat> => {
        if (activeChatId) {
          return chatsApi.appendMessage(
            activeChatId,
            { role: "user", content },
            { providerId, model, autoTitle: true, turnId: messageTurnId },
          );
        }
        // No title: the chat store's default is what lets background
        // auto-titling replace it later. A literal "Aiden" would stick, and
        // every Recent row would read the same.
        const created = await chatsApi.createAssistant({
          providerId,
          model,
        });
        createdChatId = created.id;
        persistenceChatId = created.id;
        return chatsApi.appendMessage(
          created.id,
          { role: "user", content },
          { providerId, model, autoTitle: true, turnId: messageTurnId },
        );
      };

      persistingTurnRef.current = turn;
      void persist()
        .then((chat) => {
          const stoppedDuringPersistence =
            stoppedPersistingTurnRef.current === turn;
          if (persistingTurnRef.current === turn)
            persistingTurnRef.current = null;
          if (stoppedPersistingTurnRef.current === turn)
            stoppedPersistingTurnRef.current = null;
          if (!isCurrent()) {
            void chatsApi.abandonTurn(chat.id, messageTurnId);
            refreshThreads();
            return;
          }
          setTurnSaving(false);
          setActiveChatId(chat.id);
          if (stoppedDuringPersistence) {
            void chatsApi.abandonTurn(chat.id, messageTurnId);
            refreshThreads();
            return;
          }
          // History is everything already persisted minus the turn just added,
          // which `run` appends itself.
          run(chat.id);
        })
        .catch((cause: unknown) => {
          if (persistingTurnRef.current === turn)
            persistingTurnRef.current = null;
          if (stoppedPersistingTurnRef.current === turn)
            stoppedPersistingTurnRef.current = null;
          if (!isCurrent()) return;
          setTurnSaving(false);
          setGenerationPhase("idle");
          setStreamComplete(false);
          setApprovals([]);
          setDecidingApprovalId(null);
          decidingApprovalRef.current = null;
          const reconciliationKind = appendReconciliationFailureKind(cause);
          if (reconciliationKind) {
            setAppendReconciliationRequired(true);
            if (persistenceChatId) setActiveChatId(persistenceChatId);
            const mayBeDurable = reconciliationKind === "current";
            setMessages((existing) =>
              settleAssistantAppendFailure(existing, content, mayBeDurable),
            );
            if (!mayBeDurable) restoreDraft?.(text);
            fail(
              "Message save status is unknown. Reload Aiden before sending another message.",
            );
          } else {
            if (createdChatId) {
              setActiveChatId(createdChatId);
              refreshThreads();
            }
            setMessages((existing) =>
              settleAssistantAppendFailure(existing, content, false),
            );
            restoreDraft?.(text);
            fail(cause instanceof Error ? cause.message : String(cause));
          }
        });
    },
    [
      activeChatId,
      reloadRequired,
      fail,
      providers.data,
      refreshThreads,
      streamComplete,
      streaming,
      turnSaving,
    ],
  );

  const stop = React.useCallback(() => {
    if (persistingTurnRef.current === turnRef.current) {
      stoppedPersistingTurnRef.current = turnRef.current;
      setTurnSaving(true);
      setGenerationPhase("idle");
      setStreamComplete(false);
      setApprovals([]);
      setDecidingApprovalId(null);
      decidingApprovalRef.current = null;
      setMessages((existing) => {
        const last = existing[existing.length - 1];
        return last?.role === "assistant" && last.content === ""
          ? existing.slice(0, -1)
          : existing;
      });
      return;
    }
    const handle = handleRef.current;
    const nextPhase = assistantGenerationPhaseAfterStop(
      generationPhase,
      Boolean(handle),
    );
    if (!handle || nextPhase !== "stopping") return;
    stoppingTurnRef.current = turnRef.current;
    setGenerationPhase(nextPhase);
    handle.cancel("user_stop");
  }, [generationPhase]);

  const finishStreamHandoff = React.useCallback(() => {
    setStreamComplete(false);
  }, []);

  const decideApproval = React.useCallback(
    async (prompt: ApprovalPrompt, decision: "allow" | "deny") => {
      if (
        decidingApprovalRef.current ||
        !approvals.some((approval) => approval.approvalId === prompt.approvalId)
      ) {
        return;
      }
      decidingApprovalRef.current = prompt.approvalId;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatsApi.approve(prompt.approvalId, decision);
        setError(null);
        setApprovals((existing) =>
          existing.filter(
            (approval) => approval.approvalId !== prompt.approvalId,
          ),
        );
      } catch (cause) {
        fail(
          cause instanceof Error
            ? cause.message
            : "Aiden could not send that automation decision. Try again or stop the response.",
        );
      } finally {
        if (decidingApprovalRef.current === prompt.approvalId) {
          decidingApprovalRef.current = null;
          setDecidingApprovalId(null);
        }
      }
    },
    [approvals, fail],
  );

  return {
    messages,
    streaming,
    streamComplete,
    error,
    ready,
    readiness,
    canChangeThread,
    threads,
    activeChatId,
    lastNotice,
    approvals,
    decidingApprovalId,
    send,
    stop,
    finishStreamHandoff,
    decideApproval,
    openThread: loadThread,
    newThread,
  };
}
