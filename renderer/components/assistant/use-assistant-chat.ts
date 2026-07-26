// Chat state for the Aiden assistant window. Threads live in the reserved
// "assistant" workspace so the main window's sidebar never lists them, and every
// generation carries mode: "assistant" so main swaps in the Aiden persona and
// tool set.

import * as React from "react";
import { chatsApi, onNotification, startGeneration, type GenerationHandle } from "../../lib/ipc";
import type { Chat, ChatMeta } from "../../lib/types";
import { useProviders } from "../../lib/queries";
import { readModelSelection } from "../../lib/use-model-selection";
import { ASSISTANT_WORKSPACE_ID } from "../../shared/assistant";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
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

/** Something the collapsed mark should surface: a finished reply or a failure. */
export interface AssistantNotice {
  kind: "reply" | "error";
  text: string;
  /** Monotonic marker so consumers can tell a new notice from a re-render. */
  at: number;
}

/** Why the composer is unavailable, so the panel can say something true. */
export type AssistantReadiness = "ready" | "loading" | "unavailable" | "unset";

export interface AssistantChat {
  messages: AssistantMessage[];
  streaming: boolean;
  error: string | null;
  ready: boolean;
  readiness: AssistantReadiness;
  threads: ChatMeta[];
  activeChatId: string | null;
  lastNotice: AssistantNotice | null;
  send: (text: string) => void;
  stop: () => void;
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
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastNotice, setLastNotice] = React.useState<AssistantNotice | null>(null);
  // Aiden follows the app-wide model selection rather than owning one. Mounting
  // useModelSelection here would fork it: that hook keeps per-instance state
  // seeded once at mount, so the dock would never see the composer switch
  // models. Read storage at the point of use instead.
  const providers = useProviders();
  const [selection, setSelection] = React.useState(readModelSelection);
  const ready = Boolean(selection.providerId && selection.model);
  const readiness: AssistantReadiness = ready
    ? "ready"
    : providers.isLoading
      ? "loading"
      : providers.isError
        ? "unavailable"
        : "unset";
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

  const fail = React.useCallback((message: string) => {
    setError(message);
    setLastNotice({ kind: "error", text: message, at: Date.now() });
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

  React.useEffect(() => onNotification("chats:metadata-updated", refreshThreads), [refreshThreads]);

  // The composer can change the model while the dock sits idle.
  React.useEffect(() => {
    const sync = () => setSelection(readModelSelection());
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  /** Abandon any running generation and invalidate its pending callbacks. */
  const abandonTurn = React.useCallback((origin: "lifecycle" | "user_stop") => {
    turnRef.current += 1;
    handleRef.current?.cancel(origin);
    handleRef.current = null;
  }, []);

  React.useEffect(() => () => abandonTurn("lifecycle"), [abandonTurn]);

  const loadThread = React.useCallback(
    (chatId: string) => {
      // Switching threads mid-stream would otherwise keep appending the old
      // thread's deltas onto the new transcript while main persisted them to
      // the old chat — what you saw would not be what was on disk.
      abandonTurn("lifecycle");
      setStreaming(false);
      const token = ++loadTokenRef.current;
      setError(null);
      void chatsApi
        .get(chatId)
        .then((chat: Chat | null) => {
          if (token !== loadTokenRef.current) return;
          // chats:get answers null for "unreadable" as well as "missing", and a
          // thread we just listed is not missing. Adopting the id here would let
          // the next send append to a conversation we could not read, so refuse
          // the thread rather than silently opening it empty.
          if (!chat) {
            fail("Aiden could not open that conversation.");
            return;
          }
          setActiveChatId(chatId);
          setMessages(visibleMessages(chat));
        })
        .catch((cause: unknown) => {
          if (token !== loadTokenRef.current) return;
          fail(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [abandonTurn, fail],
  );

  const newThread = React.useCallback(() => {
    abandonTurn("lifecycle");
    loadTokenRef.current += 1;
    setStreaming(false);
    setMessages([]);
    setError(null);
    setActiveChatId(null);
  }, [abandonTurn]);

  const send = React.useCallback(
    (text: string) => {
      // Read the selection fresh: the composer may have switched models since
      // the last focus sync.
      const current = readModelSelection();
      if (
        !canSendAssistantMessage(text, {
          streaming,
          ready: Boolean(current.providerId && current.model),
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
      setStreaming(true);
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

      const appendDelta = (delta: string) => {
        if (!isCurrent()) return;
        setMessages((existing) => {
          const next = [...existing];
          const last = next[next.length - 1];
          if (last?.role === "assistant")
            next[next.length - 1] = { role: "assistant", content: last.content + delta };
          return next;
        });
      };

      const run = (chatId: string, history: AssistantMessage[]) => {
        if (!isCurrent()) return;
        handleRef.current = startGeneration(
          {
            chatId,
            workspaceId: ASSISTANT_WORKSPACE_ID,
            providerId,
            model,
            mode: "assistant",
            messages: [...history, { role: "user", content }],
          },
          {
            onDelta: appendDelta,
            onDone: (fullContent) => {
              if (!isCurrent()) return;
              setStreaming(false);
              handleRef.current = null;
              // A cancelled generation still reports done, with no content.
              if (fullContent.trim()) {
                setLastNotice({ kind: "reply", text: fullContent, at: Date.now() });
              } else {
                dropEmptyPlaceholder();
              }
              refreshThreads();
            },
            onError: (message) => {
              if (!isCurrent()) return;
              setStreaming(false);
              handleRef.current = null;
              dropEmptyPlaceholder();
              fail(message);
            },
            // Aiden's tool set is built without anything that can pause for
            // approval (see llm-client's assistantMode gate). If one ever slips
            // through, deny it: an unanswered approval never times out, and the
            // panel would sit on an ellipsis forever with no way to explain it.
            onApproval: (prompt) => {
              void chatsApi.approve(prompt.approvalId, "deny");
              if (isCurrent()) fail(`Aiden cannot approve ${prompt.toolName} here; it was denied.`);
            },
          },
        );
      };

      // Persist the user's turn first, exactly as the main window's composer
      // does. Main only ever appends the assistant side, so skipping this wrote
      // reply-only transcripts to disk and every reopened thread came back with
      // its questions missing.
      const persist = async (): Promise<Chat> => {
        if (activeChatId) {
          return chatsApi.appendMessage(
            activeChatId,
            { role: "user", content },
            { providerId, model, autoTitle: true },
          );
        }
        // No title: the chat store's default is what lets background
        // auto-titling replace it later. A literal "Aiden" would stick, and
        // every Recent row would read the same.
        const created = await chatsApi.create({
          workspaceId: ASSISTANT_WORKSPACE_ID,
          providerId,
          model,
        });
        return chatsApi.appendMessage(
          created.id,
          { role: "user", content },
          { providerId, model, autoTitle: true },
        );
      };

      void persist()
        .then((chat) => {
          if (!isCurrent()) return;
          setActiveChatId(chat.id);
          // History is everything already persisted minus the turn just added,
          // which `run` appends itself.
          run(chat.id, visibleMessages(chat).slice(0, -1));
        })
        .catch((cause: unknown) => {
          if (!isCurrent()) return;
          setStreaming(false);
          dropEmptyPlaceholder();
          fail(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [activeChatId, fail, refreshThreads, streaming],
  );

  const stop = React.useCallback(() => {
    abandonTurn("user_stop");
    setStreaming(false);
    setMessages((existing) => {
      const last = existing[existing.length - 1];
      return last?.role === "assistant" && last.content === "" ? existing.slice(0, -1) : existing;
    });
  }, [abandonTurn]);

  return {
    messages,
    streaming,
    error,
    ready,
    readiness,
    threads,
    activeChatId,
    lastNotice,
    send,
    stop,
    openThread: loadThread,
    newThread,
  };
}
