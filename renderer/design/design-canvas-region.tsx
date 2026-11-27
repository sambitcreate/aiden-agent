import * as React from "react";
import { cn } from "../lib/ui-utils";

const DesignCanvas = React.lazy(() => import("./design-canvas"));

/**
 * The canvas side of design mode. Split, it sits beside the chat column.
 * Stacked (content too narrow for both), it fills the chat area below the top
 * bar while the Chat | Canvas switch shows it, and is hidden from sight, focus
 * and assistive tech while the chat is shown. It stays mounted either way, so
 * the canvas keeps its viewport. The canvas inside names the landmark, so this
 * wrapper adds none of its own.
 */
export function DesignCanvasRegion({
  chatId,
  workspaceId,
  width,
  placement,
  hidden,
  stackedTopInset = 0,
}: {
  chatId: string;
  /** The chat's workspace (normalized: a legacy chat's is "default"), whose canvas this shows. */
  workspaceId: string;
  width: number;
  placement: "split" | "stacked";
  hidden: boolean;
  /** Extra room below the top bar when stacked, such as the top bar's design mode banner. */
  stackedTopInset?: number;
}) {
  // A save can find the chat moved to another workspace before the chat's
  // metadata says so. The canvas then opens on that workspace at once, until
  // the metadata names a workspace of its own, which is newer.
  // It belongs to the chat it was found for: another chat of the same workspace opens on its own.
  const [moved, setMoved] = React.useState<{ chatId: string; from: string; to: string } | null>(null);
  const current = moved && moved.chatId === chatId && moved.from === workspaceId ? moved : null;
  if (moved && !current) setMoved(null);
  const shownWorkspace = current ? current.to : workspaceId;
  const onMoved = React.useCallback(
    (to: string) => setMoved(to === workspaceId ? null : { chatId, from: workspaceId, to }),
    [chatId, workspaceId],
  );
  return (
    <section
      data-design-canvas-region={placement}
      data-chat-id={chatId}
      inert={hidden}
      aria-hidden={hidden || undefined}
      className={cn(
        "design-canvas-region min-h-0 overflow-hidden bg-background",
        placement === "stacked" ? "absolute inset-x-0 bottom-0 top-13 z-20" : "relative h-full shrink-0",
        hidden && "invisible",
      )}
      style={
        placement === "split"
          ? { width }
          : stackedTopInset > 0
            ? { top: `calc(3.25rem + ${stackedTopInset}px)` }
            : undefined
      }
    >
      <React.Suspense fallback={<DesignCanvasLoading />}>
        {/* Each chat has its own view of its workspace's canvas, so its tool and view never carry over. */}
        <DesignCanvas
          key={`${shownWorkspace}\n${chatId}`}
          chatId={chatId}
          workspaceId={shownWorkspace}
          onMoved={onMoved}
        />
      </React.Suspense>
    </section>
  );
}

/**
 * Shown while the canvas chunk loads. Deliberately neutral: it must not look
 * like an empty canvas that is missing its tools.
 */
function DesignCanvasLoading() {
  return (
    <div role="status" aria-label="Loading canvas" className="flex h-full items-center justify-center">
      <div aria-hidden className="h-24 w-40 animate-pulse rounded-button bg-control motion-reduce:animate-none" />
    </div>
  );
}
