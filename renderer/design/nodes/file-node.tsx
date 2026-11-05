// A workspace HTML page on the design canvas. Live, it runs in a sandboxed
// iframe (scripts, never same-origin) laid out at its design width and scaled
// to the frame's box. Not live, it shows its last snapshot. The page takes
// pointer and wheel input only once the person enters the frame.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { CanvasNodeChrome } from "../../canvas";
import { FrameTitle } from "./frame-title";
import { cn } from "../../lib/ui-utils";
import { parseDesignBridgeMessage } from "../../shared/design-canvas/bridge-messages";
import type { DesignFrame } from "../../shared/design-canvas/schema";
import { designUrl } from "../../shared/design-canvas/url";
import type { DesignNode } from "../canvas-adapter-core";
import { useFrameSnapshot } from "../frame-snapshots";
import {
  DESIGN_DEFAULT_WIDTH,
  DESIGN_FRAME_HEADER_PX,
  useDesignNodeContext,
  withVersion,
} from "./design-node-context";
import { DesignNodeResizer, FrameSkeleton, MissingFrame, useRetiringFrame } from "./frame-parts";

/**
 * After the iframe loads, how long its page has to report in. A missing file
 * is answered as plain text with no bridge script, so it never does.
 */
export const DESIGN_FRAME_READY_TIMEOUT_MS = 2000;

const SANDBOX = "allow-scripts";

export type FileFrameProps = {
  frame: DesignFrame;
  grant: string | null;
  selected?: boolean;
  live: boolean;
  entered: boolean;
  /** Bumped each time the file changes on disk; reloads the page in place. */
  version: number;
  onEnter(): void;
  onMissing(): void;
  onRemove(): void;
  /** The editable title the canvas draws; a plain title without it. */
  titleSlot?: React.ReactNode;
};

export function FileFrame({
  frame,
  grant,
  selected = false,
  live,
  entered,
  version,
  onEnter,
  onMissing,
  onRemove,
  titleSlot,
}: FileFrameProps) {
  const designWidth = frame.designWidth ?? DESIGN_DEFAULT_WIDTH;
  const scale = frame.w / designWidth;
  const contentHeight = Math.max(0, frame.h - DESIGN_FRAME_HEADER_PX);
  const src = grant && frame.path ? withVersion(designUrl(grant, frame.path), version) : null;

  const [docHeight, setDocHeight] = React.useState<number | null>(null);
  const [missingVersion, setMissingVersion] = React.useState<number | null>(null);
  const missing = missingVersion === version;
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const reportedFor = React.useRef<string | null>(null);
  const missingTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMissingRef = React.useRef(onMissing);
  React.useLayoutEffect(() => {
    onMissingRef.current = onMissing;
  }, [onMissing]);

  const canShow = src !== null && !missing;
  const retiring = useRetiringFrame({ frameId: frame.id, version, live, showing: canShow, content: contentRef });
  const showIframe = canShow && (live || retiring);
  const { snapshot } = useFrameSnapshot(frame.id, version);

  const clearMissingTimer = () => {
    if (missingTimer.current === null) return;
    clearTimeout(missingTimer.current);
    missingTimer.current = null;
  };

  React.useEffect(() => {
    if (!showIframe) return;
    const receive = (event: MessageEvent) => {
      const guest = iframeRef.current?.contentWindow;
      // A detached frame has no window; a sourceless message must never match.
      if (!guest || event.source !== guest) return;
      const message = parseDesignBridgeMessage(event.data);
      if (!message || (message.type !== "ready" && message.type !== "resize")) return;
      reportedFor.current = iframeRef.current?.getAttribute("src") ?? null;
      clearMissingTimer();
      setDocHeight(Math.round(message.docHeight));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [showIframe]);

  // A new address (a newer version, another grant) has to report in again.
  React.useEffect(() => {
    reportedFor.current = null;
    return clearMissingTimer;
  }, [src]);
  React.useEffect(() => {
    if (!showIframe) clearMissingTimer();
  }, [showIframe]);

  const onLoad = () => {
    if (src === null || reportedFor.current === src) return;
    clearMissingTimer();
    const loadedVersion = version;
    missingTimer.current = setTimeout(() => {
      missingTimer.current = null;
      setMissingVersion(loadedVersion);
      onMissingRef.current();
    }, DESIGN_FRAME_READY_TIMEOUT_MS);
  };

  let body: React.ReactNode;
  if (missing) body = <MissingFrame path={frame.path} onRemove={onRemove} />;
  else if (showIframe) {
    body = (
      <div
        className={cn("h-full w-full overflow-hidden", entered && "nodrag nowheel")}
        style={{ pointerEvents: entered ? undefined : "none" }}
      >
        <iframe
          ref={iframeRef}
          data-frame-id={frame.id}
          title={frame.title}
          sandbox={SANDBOX}
          src={src}
          referrerPolicy="no-referrer"
          tabIndex={entered ? 0 : -1}
          onLoad={onLoad}
          className="block border-0 bg-background"
          style={{
            width: `${designWidth}px`,
            height: `${scale > 0 ? contentHeight / scale : 0}px`,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
        />
      </div>
    );
  } else if (snapshot) {
    body = <img src={snapshot} alt={frame.title} draggable={false} className="block h-full w-full object-cover object-top" />;
  } else {
    body = <FrameSkeleton title={frame.title} />;
  }

  return (
    <div className="h-full w-full" onDoubleClick={missing ? undefined : onEnter}>
      <CanvasNodeChrome
        title={frame.title}
        titleSlot={titleSlot}
        selected={selected}
        flush
        status={docHeight === null ? `${designWidth}` : `${designWidth} × ${docHeight}`}
      >
        <div ref={contentRef} className="h-full w-full overflow-hidden rounded-b-button">
          {body}
        </div>
      </CanvasNodeChrome>
    </div>
  );
}

export function FileNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { frame } = data;
  const version = canvas.versionOf(frame.path);
  return (
    <>
      <DesignNodeResizer selected={selected} />
      <FileFrame
        frame={frame}
        grant={canvas.grant}
        selected={selected}
        live={canvas.live.has(id)}
        entered={canvas.entered === id}
        version={version}
        onEnter={() => canvas.enter(id)}
        onMissing={() => canvas.markMissing(id, version)}
        onRemove={() => canvas.remove(id)}
        titleSlot={<FrameTitle frame={frame} />}
      />
    </>
  );
}
