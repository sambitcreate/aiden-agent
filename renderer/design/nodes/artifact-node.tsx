// An HTML artifact from the chat, drawn with the chat's own artifact preview.
// P3 is what places these; until then a canvas only shows the ones it has.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { CanvasNodeChrome } from "../../canvas";
import { HtmlArtifactIframe } from "../../components/html-artifact-frame";
import { readGenerativeUiTheme } from "../../lib/generative-ui-theme-snapshot";
import { chatsApi } from "../../lib/ipc";
import { cn } from "../../lib/ui-utils";
import type { DesignNode } from "../canvas-adapter-core";
import { useFrameSnapshot } from "../frame-snapshots";
import { useDesignNodeContext } from "./design-node-context";
import { DesignNodeResizer, FrameSkeleton, useRetiringFrame } from "./frame-parts";

export function ArtifactNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { frame } = data;
  const live = canvas.live.has(id);
  const entered = canvas.entered === id;
  const [src, setSrc] = React.useState<string | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const retiring = useRetiringFrame({ frameId: id, version: 0, live, showing: src !== null, content: contentRef });
  const { snapshot } = useFrameSnapshot(id, 0);
  const wanted = (live || retiring) && frame.mediaId !== undefined;

  React.useEffect(() => {
    if (!wanted || src !== null || !frame.mediaId) return;
    let cancelled = false;
    void chatsApi.htmlArtifactSrcdoc(canvas.chatId, frame.mediaId, readGenerativeUiTheme()).then(
      (preview) => {
        if (!cancelled && preview) setSrc(preview.src);
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
        <CanvasNodeChrome title={frame.title} selected={selected} flush>
          <div ref={contentRef} className="h-full w-full overflow-hidden rounded-b-button">
            {body}
          </div>
        </CanvasNodeChrome>
      </div>
    </>
  );
}
