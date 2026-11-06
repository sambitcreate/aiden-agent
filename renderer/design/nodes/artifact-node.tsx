// An HTML artifact from the chat, drawn with the chat's own artifact preview.
// Aiden places these while design mode is on; drawing a visual again under
// the same title swaps the frame's media, so the frame shows the new one.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { CanvasNodeChrome } from "../../canvas";
import { FrameActions } from "./frame-actions";
import { FrameTitle } from "./frame-title";
import { HtmlArtifactIframe } from "../../components/html-artifact-frame";
import { readGenerativeUiTheme } from "../../lib/generative-ui-theme-snapshot";
import { chatsApi } from "../../lib/ipc";
import { cn } from "../../lib/ui-utils";
import type { DesignNode } from "../canvas-adapter-core";
import { useFrameSnapshot } from "../frame-snapshots";
import { useDesignNodeContext } from "./design-node-context";
import { DesignNodeResizer, FrameSkeleton, useRetiringFrame } from "./frame-parts";

/** A snapshot belongs to one visual: a frame's new media is a new snapshot version. */
function mediaVersion(mediaId: string | undefined): number {
  let hash = 0;
  for (const char of mediaId ?? "") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

export function ArtifactNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { frame } = data;
  const live = canvas.live.has(id);
  const entered = canvas.entered === id;
  // Keyed by media, so a swapped visual loads afresh instead of keeping the old one.
  const [loaded, setLoaded] = React.useState<{ mediaId: string; src: string } | null>(null);
  const src = loaded && loaded.mediaId === frame.mediaId ? loaded.src : null;
  const version = mediaVersion(frame.mediaId);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const retiring = useRetiringFrame({ frameId: id, version, live, showing: src !== null, content: contentRef });
  const { snapshot } = useFrameSnapshot(id, version);
  const wanted = (live || retiring) && frame.mediaId !== undefined;

  React.useEffect(() => {
    if (!wanted || src !== null || !frame.mediaId) return;
    const mediaId = frame.mediaId;
    let cancelled = false;
    void chatsApi.htmlArtifactSrcdoc(canvas.chatId, mediaId, readGenerativeUiTheme()).then(
      (preview) => {
        if (!cancelled && preview) setLoaded({ mediaId, src: preview.src });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [wanted, src, canvas.chatId, frame.mediaId]);

  let body: React.ReactNode;
  if (wanted && src) {
    body = (
      <div
        className={cn("h-full w-full", entered && "nodrag nowheel")}
        style={{ pointerEvents: entered ? undefined : "none" }}
      >
        <HtmlArtifactIframe src={src} title={frame.title} />
      </div>
    );
  } else if (snapshot) {
    body = <img src={snapshot} alt={frame.title} draggable={false} className="block h-full w-full object-cover object-top" />;
  } else body = <FrameSkeleton title={frame.title} />;

  return (
    <>
      <DesignNodeResizer selected={selected} />
      <div className="h-full w-full" onDoubleClick={() => canvas.enter(id)}>
        <CanvasNodeChrome
          title={frame.title}
          titleSlot={<FrameTitle frame={frame} />}
          selected={selected}
          flush
          toolbar={<FrameActions frame={frame} />}
        >
          <div ref={contentRef} className="h-full w-full overflow-hidden rounded-b-button">
            {body}
          </div>
        </CanvasNodeChrome>
      </div>
    </>
  );
}
