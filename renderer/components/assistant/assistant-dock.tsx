// Aiden's home inside the main window: a panel docked to the bottom-right that
// collapses to a circular app mark. It is anchored to the window rather than to
// the chat pane, so it survives route changes and follows the window's size.

import * as React from "react";
import { assistantPreviewText } from "../../lib/assistant-dock";
import { AssistantBubble } from "./assistant-bubble";
import { AssistantPanel } from "./assistant-panel";
import { useAssistantChat } from "./use-assistant-chat";
import { useCommandHandler } from "../../lib/command-system";

/** How long a reply preview stays beside the collapsed mark. */
const PREVIEW_VISIBLE_MS = 8_000;
/** Must match aiden-assistant-dock-out in styles.css. */
const PANEL_EXIT_MS = 120;

export function AssistantDock({
  interactionBlocked = false,
}: {
  interactionBlocked?: boolean;
}): React.ReactElement {
  const chat = useAssistantChat();
  const [open, setOpen] = React.useState(false);
  const [present, setPresent] = React.useState(false);
  const [unread, setUnread] = React.useState(0);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const bubbleRef = React.useRef<HTMLButtonElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const restoreFocusPendingRef = React.useRef(false);
  const lastSeenReplyRef = React.useRef<number | null>(null);

  const openPanel = React.useCallback(() => {
    if (interactionBlocked) return;
    if (!open) {
      const activeElement = document.activeElement;
      restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
      restoreFocusPendingRef.current = false;
    } else {
      inputRef.current?.focus();
    }
    setOpen(true);
    setUnread(0);
    setPreview(null);
  }, [interactionBlocked, open]);

  const minimizePanel = React.useCallback(() => {
    restoreFocusPendingRef.current = true;
    setOpen(false);
  }, []);
  useCommandHandler("assistant.open", openPanel, !interactionBlocked);

  // Keep the panel mounted through its exit animation, exactly as the
  // environment summary card does, so minimizing settles instead of vanishing.
  React.useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    if (document.documentElement.dataset.reduceMotion === "true") {
      setPresent(false);
      return;
    }
    const timeout = window.setTimeout(() => setPresent(false), PANEL_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [open, present]);

  React.useLayoutEffect(() => {
    if (open && present) {
      inputRef.current?.focus();
      return;
    }
    if (!open && !present && restoreFocusPendingRef.current) {
      restoreFocusPendingRef.current = false;
      const priorFocus = restoreFocusRef.current;
      if (priorFocus?.isConnected) priorFocus.focus();
      else bubbleRef.current?.focus();
    }
  }, [open, present]);

  // Replies AND failures both badge. An error raised while minimized is
  // otherwise invisible — the panel that renders it is unmounted — so the user
  // sits watching nothing, believing Aiden is still thinking.
  React.useEffect(() => {
    const notice = chat.lastNotice;
    if (!notice || notice.at === lastSeenReplyRef.current) return;
    lastSeenReplyRef.current = notice.at;
    if (open) return;
    setUnread((count) => count + 1);
    setPreview(assistantPreviewText(notice.text));
  }, [chat.lastNotice, open]);

  React.useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), PREVIEW_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [preview]);

  return (
    <div
      inert={interactionBlocked ? true : undefined}
      aria-hidden={interactionBlocked ? true : undefined}
      data-environment-modal-background="assistant"
      className="pointer-events-none absolute bottom-4 right-4 z-40 flex flex-col items-end"
      style={{ visibility: interactionBlocked ? "hidden" : undefined }}
    >
      {present ? (
        <div
          className="assistant-dock-panel"
          data-state={open ? "open" : "closed"}
          inert={!open ? true : undefined}
          aria-hidden={!open ? true : undefined}
          style={{ pointerEvents: open ? "auto" : "none" }}
        >
          <AssistantPanel
            chat={chat}
            draft={draft}
            inputRef={inputRef}
            onDraftChange={setDraft}
            onMinimize={minimizePanel}
          />
        </div>
      ) : (
        // Held back until the panel has finished leaving, so the two surfaces
        // hand over in the same corner rather than overlapping mid-animation.
        <AssistantBubble ref={bubbleRef} unread={unread} preview={preview} onOpen={openPanel} />
      )}
    </div>
  );
}
