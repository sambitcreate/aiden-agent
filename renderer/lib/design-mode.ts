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

/**
 * Design mode for one chat. `set` and `toggle` change the layout at once and
 * save in the background; a refused save puts the previous value back and
 * shows one toast. Another window's change arrives on
 * `chats:design-mode-changed`.
 */
export function useDesignMode(chatId: string | undefined) {
  const qc = useQueryClient();
  const capabilities = useAppCapabilities();
  const chat = useChat(chatId);
  const workspaces = useWorkspaces();
  const workspace = React.useMemo(() => {
    if (!chat.data || !workspaces.data) return undefined;
    const id = persistedChatWorkspaceId(chat.data.workspaceId);
    return workspaces.data.find((entry) => entry.id === id) ?? null;
  }, [chat.data, workspaces.data]);
  const available = designModeAvailable(chat.data, capabilities, workspace);
  const on = available && chat.data?.designMode === true;

  // The latest change per chat, so an older answer never replaces a newer one.
  const changesRef = React.useRef(new Map<string, number>());

  React.useEffect(() => {
    if (!capabilities.designMode) return;
    return onNotification<ChatDesignModeChanged>("chats:design-mode-changed", (change) => {
      if (typeof change?.chatId !== "string" || typeof change.designMode !== "boolean") return;
      // A change of ours still in flight wins over an echo of an older one.
      if (changesRef.current.has(change.chatId)) return;
      applyDesignModeToCache(qc, change.chatId, change.designMode);
    });
  }, [capabilities.designMode, qc]);

  const set = React.useCallback(
    (enabled: boolean, _source: DesignModeSource) => {
      if (!chatId || !available) return;
      const current = qc.getQueryData<Chat | null>(queryKeys.chat(chatId));
      const previous = current?.designMode === true;
      if (previous === enabled) return;
      const change = (changesRef.current.get(chatId) ?? 0) + 1;
      changesRef.current.set(chatId, change);
      const isLatest = () => changesRef.current.get(chatId) === change;
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
          if (isLatest()) changesRef.current.delete(chatId);
        }
      })();
    },
    [available, chatId, qc],
  );

  const toggle = React.useCallback(
    (source: DesignModeSource) => {
      if (!chatId) return;
      set(qc.getQueryData<Chat | null>(queryKeys.chat(chatId))?.designMode !== true, source);
    },
    [chatId, qc, set],
  );

  return { available, on, set, toggle };
}
