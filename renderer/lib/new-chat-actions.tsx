import * as React from "react";

/**
 * The app shell's single way to start a chat draft, shared by ⌘N, New Agent,
 * the sidebar's per-workspace actions and the New chat in… palette, so every
 * entry point reuses an empty draft and lands focus in its composer.
 */
export interface NewChatActions {
  /** Open (or reuse) an empty draft in this workspace and focus its composer. */
  openNewChatIn: (workspaceId: string) => Promise<void>;
  /** Register a folder as a workspace with the native picker, then open a draft there. */
  openFolderForNewChat: () => Promise<void>;
  /** Open the workspace menu's Clone view on the draft being viewed, or on a new draft. */
  cloneRepositoryForNewChat: () => Promise<void>;
}

const NewChatActionsContext = React.createContext<NewChatActions | null>(null);

export const NewChatActionsProvider = NewChatActionsContext.Provider;

export function useNewChatActions(): NewChatActions {
  const actions = React.useContext(NewChatActionsContext);
  if (!actions) throw new Error("useNewChatActions must be used inside NewChatActionsProvider");
  return actions;
}
