import type { ChatRowMenu } from "./chat-row";
import type { RemoteChatRowAction } from "../../lib/sidebar-remote-groups";

export interface RemoteChatRowMenuHandlers {
  onOpen: () => void;
  onMarkRead: () => void;
  onRename: () => void;
}

/** A remote chat row's menu: one item per action its host grants, in the actions' order. */
export function remoteChatRowMenu(
  actions: readonly RemoteChatRowAction[],
  handlers: RemoteChatRowMenuHandlers,
): ChatRowMenu {
  return (Item) =>
    actions.map((action) => {
      switch (action.id) {
        case "open":
          return (
            <Item key="open" disabled={action.disabled} onSelect={handlers.onOpen}>
              Open
            </Item>
          );
        case "markRead":
          return (
            <Item key="markRead" disabled={action.disabled} onSelect={handlers.onMarkRead}>
              Mark read
            </Item>
          );
        case "rename":
          return (
            <Item key="rename" icon="pencil" disabled={action.disabled} onSelect={handlers.onRename}>
              Rename
            </Item>
          );
      }
    });
}
