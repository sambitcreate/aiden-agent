// Chat state for the Aiden assistant window. Threads live in the reserved
// "assistant" workspace so the main window's sidebar never lists them, and every
// generation carries mode: "assistant" so main swaps in the Aiden persona and
// tool set.

import * as React from "react";
import {
  chatsApi,
  onNotification,
  settingsApi,
  startGeneration,
  type GenerationHandle,
} from "../lib/ipc";
import type { Chat, ChatMeta } from "../lib/types";
import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";

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

interface AssistantModel {
  providerId: string;
  model: string;
}

export interface AssistantChat {
  messages: AssistantMessage[];
  streaming: boolean;
  error: string | null;
  ready: boolean;
  threads: ChatMeta[];
  activeChatId: string | null;
  send: (text: string) => void;
  stop: () => void;
  openThread: (chatId: string) => void;
  newThread: () => void;
}

export function useAssistantChat(): AssistantChat {
  const [messages, setMessages] = React.useState<AssistantMessage[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<AssistantModel | null>(null);
  const [threads, setThreads] = React.useState<ChatMeta[]>([]);
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const handleRef = React.useRef<GenerationHandle | null>(null);

  const refreshThreads = React.useCallback(() => {
    void chatsApi
      .list(ASSISTANT_WORKSPACE_ID)
      .then(setThreads)
      .catch(() => undefined);
  }, []);

  // The window follows the user's current model rather than pinning its own;
  // the pin in settings exists for unattended proactivity, not for this chat.
  React.useEffect(() => {
    void settingsApi
      .get()
      .then((settings) => {
        if (settings.lastProviderId && settings.lastModel) {
          setSelection({ providerId: settings.lastProviderId, model: settings.lastModel });
        }
      })
      .catch(() => undefined);
    refreshThreads();
  }, [refreshThreads]);

  React.useEffect(() => onNotification("chats:metadata-updated", refreshThreads), [refreshThreads]);

  const loadThread = React.useCallback((chatId: string) => {
    setActiveChatId(chatId);
    setError(null);
    void chatsApi
      .get(chatId)
      .then((chat: Chat | null) => {
        setMessages(
          (chat?.messages ?? [])
            .filter(
              (message): message is typeof message & { role: "user" | "assistant" } =>
                message.role === "user" || message.role === "assistant",
            )
            .map((message) => ({ role: message.role, content: message.content })),
        );
      })
      .catch(() => setMessages([]));
  }, []);

  // A delivered nudge asks the window to surface its thread.
  React.useEffect(
    () =>
      onNotification<{ chatId?: string }>("assistant:open-thread", (payload) => {
        if (payload.chatId) loadThread(payload.chatId);
      }),
    [loadThread],
  );

  const newThread = React.useCallback(() => {
    handleRef.current?.cancel("lifecycle");
    handleRef.current = null;
    setStreaming(false);
    setMessages([]);
    setError(null);
    setActiveChatId(null);
  }, []);

  const send = React.useCallback(
    (text: string) => {
      if (!canSendAssistantMessage(text, { streaming, ready: selection !== null })) return;
      const content = text.trim();
      const model = selection as AssistantModel;
      setError(null);
      setStreaming(true);
      setMessages((current) => [
        ...current,
        { role: "user", content },
        { role: "assistant", content: "" },
      ]);

      const appendDelta = (delta: string) => {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === "assistant")
            next[next.length - 1] = {
              role: "assistant",
              content: last.content + delta,
            };
          return next;
        });
      };

      const run = (chatId: string, history: AssistantMessage[]) => {
        handleRef.current = startGeneration(
          {
            chatId,
            workspaceId: ASSISTANT_WORKSPACE_ID,
            providerId: model.providerId,
            model: model.model,
            mode: "assistant",
            messages: [...history, { role: "user", content }],
          },
          {
            onDelta: appendDelta,
            onDone: () => {
              setStreaming(false);
              handleRef.current = null;
              refreshThreads();
            },
            onError: (message) => {
              setStreaming(false);
              handleRef.current = null;
              setError(message);
            },
          },
        );
      };

      const history = messages;
      if (activeChatId) {
        run(activeChatId, history);
        return;
      }
      void chatsApi
        .create({
          title: "Aiden",
          workspaceId: ASSISTANT_WORKSPACE_ID,
          providerId: model.providerId,
          model: model.model,
        })
        .then((chat) => {
          setActiveChatId(chat.id);
          run(chat.id, history);
        })
        .catch((cause: unknown) => {
          setStreaming(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [activeChatId, messages, refreshThreads, selection, streaming],
  );

  const stop = React.useCallback(() => {
    handleRef.current?.cancel("user_stop");
    handleRef.current = null;
    setStreaming(false);
  }, []);

  return {
    messages,
    streaming,
    error,
    ready: selection !== null,
    threads,
    activeChatId,
    send,
    stop,
    openThread: loadThread,
    newThread,
  };
}
