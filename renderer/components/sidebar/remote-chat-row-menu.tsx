import * as React from "react";
import { CHAT_ROW_INBOX_ACTIONS, type ChatRowInboxAction, type ChatRowMenu } from "./chat-row";
import type { RemoteChatRowAction } from "../../lib/sidebar-remote-groups";

export interface RemoteChatRowMenuHandlers {
  onOpen: () => void;
  onMarkRead: () => void;
  onRename: () => void;
  /**
   * Inbox rows only: the row's one action (its hover icon), which takes Mark
   * read's place after Open, or `null` for none. The menu and the icon then
   * name the same action.
   */
  inboxAction?: ChatRowInboxAction | null;
  /**
   * Inbox rows on a host that takes triage: Pin, Mark done and Snooze, right
   * after the row's one action and before Rename, as on this Mac's rows.
   */
  triage?: (...parts: Parameters<ChatRowMenu>) => React.ReactNode;
}

/** A remote chat row's menu: one item per action its host grants, in the actions' order. */
export function remoteChatRowMenu(
  actions: readonly RemoteChatRowAction[],
  handlers: RemoteChatRowMenuHandlers,
): ChatRowMenu {
  const inbox = handlers.inboxAction;
  const { triage } = handlers;
  return (Item, Separator, SubMenu) =>
    actions.flatMap((action) => {
      switch (action.id) {
        case "open":
          return [
            <Item key="open" disabled={action.disabled} onSelect={handlers.onOpen}>
              Open
            </Item>,
            ...(inbox
              ? [
                  <Item key="inboxAction" icon={CHAT_ROW_INBOX_ACTIONS[inbox.kind].menuIcon} onSelect={inbox.onSelect}>
                    {CHAT_ROW_INBOX_ACTIONS[inbox.kind].label}
                  </Item>,
                ]
              : []),
            ...(triage
              ? [
                  <React.Fragment key="triage">{triage(Item, Separator, SubMenu)}</React.Fragment>,
                  ...(actions.some((other) => other.id === "rename") ? [<Separator key="triageSeparator" />] : []),
                ]
              : []),
          ];
        case "markRead":
          if (inbox !== undefined) return [];
          return [
            <Item key="markRead" disabled={action.disabled} onSelect={handlers.onMarkRead}>
              Mark read
            </Item>,
          ];
        case "rename":
          return [
            <Item key="rename" icon="pencil" disabled={action.disabled} onSelect={handlers.onRename}>
              Rename
            </Item>,
          ];
      }
    });
}
