// A route of the workspace's running web app (design mode v2 Phase 3a, D16).
// Until the live body lands (Task 11), every app frame draws as a static card
// over its last snapshot, with a sentence that is true in both flag states.

import type { NodeProps } from "@xyflow/react";
import { CanvasNodeChrome } from "../../canvas";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { designMinSize, type DesignFrame } from "../../shared/design-canvas/schema";
import type { DesignNode } from "../canvas-adapter-core";
import { useFrameSnapshot } from "../frame-snapshots";
import { FrameActions } from "./frame-actions";
import { DesignNodeResizer, FrameSkeleton } from "./frame-parts";
import { FrameTitle } from "./frame-title";

/** A fixed sentence over the frame's last picture: the app isn't live here. */
export function AppFrameCard({ title, snapshot, children }: { title: string; snapshot: string | undefined; children: React.ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-b-button">
      {snapshot ? (
        <img src={snapshot} alt={title} draggable={false} className="block h-full w-full object-cover object-top opacity-60" />
      ) : (
        <FrameSkeleton title={title} />
      )}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-popover/80 p-4 text-center">{children}</div>
    </div>
  );
}

/** An app frame's body: its last picture and why it isn't live. */
export function AppFrameBody({ frame }: { frame: DesignFrame }) {
  const { designLive } = useAppCapabilities();
  const { snapshot } = useFrameSnapshot(frame.id, 0);
  return (
    <AppFrameCard title={frame.title} snapshot={snapshot}>
      <span className="text-strong text-secondary">{designLive ? "Not live on the canvas yet" : "Live apps are off"}</span>
    </AppFrameCard>
  );
}

export function AppNode({ data, selected }: NodeProps<DesignNode>) {
  const { frame } = data;
  return (
    <>
      <DesignNodeResizer selected={selected} minSize={designMinSize("app")} />
      <div className="h-full w-full">
        <CanvasNodeChrome
          title={frame.title}
          titleSlot={<FrameTitle frame={frame} />}
          selected={selected}
          flush
          toolbar={<FrameActions frame={frame} />}
        >
          <AppFrameBody frame={frame} />
        </CanvasNodeChrome>
      </div>
    </>
  );
}
