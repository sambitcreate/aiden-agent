import * as React from "react";
import { cn } from "../lib/ui-utils";
import { DesignCanvasEmpty } from "./design-canvas-empty";

const DesignCanvas = React.lazy(() => import("./design-canvas"));

/**
 * The right-hand side of design mode. Inline it sits beside the chat column;
 * as an overlay (a window too narrow for both) it floats over the chat like a
 * floating Environment panel, leaving a strip of the chat uncovered.
 */
export function DesignCanvasRegion({
  chatId,
  width,
  overlay,
}: {
  chatId: string;
  width: number;
  overlay: boolean;
}) {
  return (
    <section
      aria-label="Design"
      data-design-canvas-region={overlay ? "overlay" : "inline"}
      data-chat-id={chatId}
      className={cn(
        "design-canvas-region min-h-0 overflow-hidden bg-background",
        overlay ? "absolute bottom-3 right-3 top-14 z-30 rounded-sheet shadow-dialog" : "relative h-full shrink-0",
      )}
      style={{ width }}
    >
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <DesignCanvasEmpty />
          </div>
        }
      >
        {/* Each chat has its own canvas, so its tool and viewport never carry over. */}
        <DesignCanvas key={chatId} />
      </React.Suspense>
    </section>
  );
}
