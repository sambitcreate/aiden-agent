import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui";
import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";
import { persistedChatWorkspaceId } from "../shared/chat-workspace";
import { useAppCapabilities } from "./app-capabilities";
import { chatsApi, onNotification } from "./ipc";
import { queryKeys, useChat, useWorkspaces } from "./queries";
import type { Chat, ChatDesignModeChanged, ChatMeta, Workspace } from "./types";

/** Where a design mode change came from; P1 only uses it to name the action. */
export type DesignModeSource = "toggle" | "shortcut" | "slash";

const DESIGN_MODE_FAILED = "Design mode could not be changed.";

/**
 * Whether this chat can open in design mode: the capability is on and the chat
 * is a project chat, not a Bot, Assistant or feature-owned chat. When the
 * chat's workspace is known it must have a folder or be a No workspace chat,
 * which lives in Aiden's own folder. Main checks the same rules again.
 */
export function designModeAvailable(
  chat: Pick<Chat, "workspaceId" | "botId" | "owner"> | null | undefined,
  capabilities: { designMode: boolean },
  workspace?: Pick<Workspace, "folderPath" | "noWorkspace"> | null,
): boolean {
  if (!capabilities.designMode || !chat) return false;
  if (chat.botId || chat.owner) return false;
  if (persistedChatWorkspaceId(chat.workspaceId) === ASSISTANT_WORKSPACE_ID) return false;
  if (workspace === undefined) return true;
  return Boolean(workspace && (workspace.folderPath || workspace.noWorkspace === true));
}

function withDesignMode<T extends ChatMeta>(chat: T, on: boolean): T {
  if (on) return { ...chat, designMode: true };
  if (chat.designMode === undefined) return chat;
  const { designMode: _cleared, ...rest } = chat;
  return rest as T;
}

/**
 * Write one chat's design mode into every cache that shows it: the open chat
 * and each sidebar list. Only `designMode` changes, so a title or order that
 * landed meanwhile stays as it is.
 */
export function applyDesignModeToCache(qc: QueryClient, chatId: string, on: boolean): void {
  qc.setQueryData<Chat | null>(queryKeys.chat(chatId), (current) =>
    current ? withDesignMode(current, on) : current,
  );
  qc.setQueriesData<ChatMeta[]>({ queryKey: queryKeys.chats }, (current) =>
    Array.isArray(current)
      ? current.map((chat) => (chat.id === chatId ? withDesignMode(chat, on) : chat))
      : current,
  );
}

/** A chat's row in any loaded sidebar list, used until the chat itself loads. */
function listedChat(qc: QueryClient, chatId: string): ChatMeta | undefined {
  for (const [, rows] of qc.getQueriesData<ChatMeta[]>({ queryKey: queryKeys.chats })) {
    if (!Array.isArray(rows)) continue;
    const row = rows.find((chat) => chat?.id === chatId);
    if (row) return row;
  }
  return undefined;
}

// The latest change per chat in this window, shared by every hook instance so
// an older answer or echo never replaces a newer change.
const changesInFlight = new Map<string, number>();

/**
 * Design mode for one chat. `set` and `toggle` change the layout at once and
 * save in the background; a refused save puts the previous value back and
 * shows one toast. Another window's change arrives on
 * `chats:design-mode-changed`.
 *
 * `settled` is false only while the chat is still loading and has no sidebar
 * row, so callers can wait instead of flashing the wrong layout.
 */
export function useDesignMode(chatId: string | undefined) {
  const qc = useQueryClient();
  const capabilities = useAppCapabilities();
  const chatQuery = useChat(chatId);
  const workspaces = useWorkspaces();
  // A chat that has not loaded yet still has its sidebar row, which carries
  // `designMode`, so switching chats never shows a guessed layout.
  const loaded = chatId && chatQuery.data?.id === chatId ? chatQuery.data : undefined;
  const chat: ChatMeta | undefined = loaded ?? (chatId ? listedChat(qc, chatId) : undefined);
  const workspace = React.useMemo(() => {
    if (!chat || !workspaces.data) return undefined;
    const id = persistedChatWorkspaceId(chat.workspaceId);
    return workspaces.data.find((entry) => entry.id === id) ?? null;
  }, [chat, workspaces.data]);
  const available = designModeAvailable(chat, capabilities, workspace);
  const on = available && chat?.designMode === true;
  // A finished read with no chat (a draft or a deleted chat) is settled too.
  const settled =
    !capabilities.designMode || !chatId || chat !== undefined || chatQuery.isSuccess || chatQuery.isError;

  React.useEffect(() => {
    if (!capabilities.designMode) return;
    return onNotification<ChatDesignModeChanged>("chats:design-mode-changed", (change) => {
      if (typeof change?.chatId !== "string" || typeof change.designMode !== "boolean") return;
      // A change of ours still in flight wins over an echo of an older one.
      if (changesInFlight.has(change.chatId)) return;
      applyDesignModeToCache(qc, change.chatId, change.designMode);
    });
  }, [capabilities.designMode, qc]);

  const set = React.useCallback(
    (enabled: boolean, _source: DesignModeSource) => {
      if (!chatId || !available) return;
      const current = qc.getQueryData<Chat | null>(queryKeys.chat(chatId)) ?? listedChat(qc, chatId);
      const previous = current?.designMode === true;
      if (previous === enabled) return;
      const change = (changesInFlight.get(chatId) ?? 0) + 1;
      changesInFlight.set(chatId, change);
      const isLatest = () => changesInFlight.get(chatId) === change;
      applyDesignModeToCache(qc, chatId, enabled);
      void (async () => {
        try {
          // A read started before this change must not land on top of it.
          // Cancelling puts that read's starting data back, so apply again.
          await qc.cancelQueries({ queryKey: queryKeys.chat(chatId), exact: true });
          if (isLatest()) applyDesignModeToCache(qc, chatId, enabled);
          const saved = await chatsApi.setDesignMode(chatId, enabled);
          if (isLatest() && saved) applyDesignModeToCache(qc, chatId, saved.designMode === true);
        } catch (error) {
          if (isLatest()) {
            applyDesignModeToCache(qc, chatId, previous);
            toast.error(error instanceof Error && error.message ? error.message : DESIGN_MODE_FAILED);
          }
        } finally {
          if (isLatest()) changesInFlight.delete(chatId);
        }
      })();
    },
    [available, chatId, qc],
  );

  const toggle = React.useCallback(
    (source: DesignModeSource) => {
      if (!chatId) return;
      const current = qc.getQueryData<Chat | null>(queryKeys.chat(chatId)) ?? listedChat(qc, chatId);
      set(current?.designMode !== true, source);
    },
    [chatId, qc, set],
  );

  // The workspace the chat lives in, so design mode can scope the sidebar to it.
  const workspaceId = chat ? persistedChatWorkspaceId(chat.workspaceId) : undefined;

  return { available, on, settled, workspaceId, set, toggle };
}
