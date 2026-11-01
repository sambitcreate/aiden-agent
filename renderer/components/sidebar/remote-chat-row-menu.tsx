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
}

/** A remote chat row's menu: one item per action its host grants, in the actions' order. */
export function remoteChatRowMenu(
  actions: readonly RemoteChatRowAction[],
  handlers: RemoteChatRowMenuHandlers,
): ChatRowMenu {
  const inbox = handlers.inboxAction;
  return (Item) =>
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
