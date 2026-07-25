// Aiden's home inside the main window: a panel docked to the bottom-right that
// collapses to a circular app mark. It is anchored to the window rather than to
// the chat pane, so it survives route changes and follows the window's size.

import * as React from "react";
import { onNotification } from "../../lib/ipc";
import { assistantPreviewText } from "../../lib/assistant-dock";
import { AssistantBubble } from "./assistant-bubble";
import { AssistantPanel } from "./assistant-panel";
import { useAssistantChat } from "./use-assistant-chat";

/** How long a reply preview stays beside the collapsed mark. */
const PREVIEW_VISIBLE_MS = 8_000;

export function AssistantDock(): React.ReactElement {
  const chat = useAssistantChat();
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(0);
  const [preview, setPreview] = React.useState<string | null>(null);
  // Replies that land while the panel is open are already visible; only count
  // the ones the user could have missed.
  const openRef = React.useRef(open);
  openRef.current = open;
  const lastSeenReplyRef = React.useRef<number | null>(null);

  React.useEffect(
    () =>
      onNotification("assistant:open-panel", () => {
        setOpen(true);
        setUnread(0);
        setPreview(null);
      }),
    [],
  );

  React.useEffect(() => {
    const reply = chat.lastReply;
    if (!reply || reply.at === lastSeenReplyRef.current) return;
    lastSeenReplyRef.current = reply.at;
    if (openRef.current) return;
    setUnread((count) => count + 1);
    setPreview(assistantPreviewText(reply.content));
  }, [chat.lastReply]);

  React.useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), PREVIEW_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [preview]);

  const openPanel = React.useCallback(() => {
    setOpen(true);
    setUnread(0);
    setPreview(null);
  }, []);

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-40 flex flex-col items-end">
      {open ? (
        <AssistantPanel chat={chat} onMinimize={() => setOpen(false)} />
      ) : (
        <AssistantBubble
          unread={unread}
          preview={preview}
          onOpen={openPanel}
          onDismissPreview={() => setPreview(null)}
        />
      )}
    </div>
  );
}
