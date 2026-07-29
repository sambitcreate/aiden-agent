import * as React from "react";
import { unreadBadgeLabel } from "../../lib/assistant-dock";

const AIDEN_MARK_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;

/**
 * The minimized Aiden affordance: the app mark cropped to a circle, with an
 * unread badge and an optional one-line preview of the latest reply.
 *
 * The mark is the macOS icon, which carries transparent padding around its
 * squircle. Scaling it past the circular mask lets the artwork bleed to the
 * edge instead of leaving a ring of empty pixels.
 */
interface AssistantBubbleProps {
  unread: number;
  preview: string | null;
  onOpen: () => void;
}

export const AssistantBubble = React.forwardRef<HTMLButtonElement, AssistantBubbleProps>(
  function AssistantBubble({ unread, preview, onOpen }, ref): React.ReactElement {
    const badge = unreadBadgeLabel(unread);
    return (
      <div className="assistant-dock-bubble pointer-events-none flex items-end justify-end gap-2">
        {preview ? (
          <button
            type="button"
            onClick={onOpen}
            className="pointer-events-auto mb-1 max-w-64 rounded-2xl rounded-br-md bg-popover px-3 py-2 text-left text-xs leading-snug text-secondary shadow-composer outline outline-1 outline-field/80 transition-opacity duration-150 ease-out"
          >
            {preview}
          </button>
        ) : null}
        <button
          ref={ref}
          type="button"
          aria-label={badge ? `Open Aiden (${badge} unread)` : "Open Aiden"}
          onClick={onOpen}
          className="pointer-events-auto relative size-12 shrink-0 rounded-full shadow-composer outline outline-1 outline-field/60 transition-transform duration-150 ease-out hover:scale-105 active:scale-95"
        >
          <span className="block size-full overflow-hidden rounded-full">
            <img src={AIDEN_MARK_URL} alt="" className="size-full scale-[1.32] object-cover" />
          </span>
          {badge ? (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-5 items-center justify-center rounded-full bg-support-red px-1 text-[11px] font-semibold leading-5 text-support-red-foreground">
              {badge}
            </span>
          ) : null}
        </button>
      </div>
    );
  },
);
