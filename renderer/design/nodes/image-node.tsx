// A workspace image on the design canvas, served by the chat's aiden-design grant.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { CanvasNodeChrome } from "../../canvas";
import { FrameActions } from "./frame-actions";
import { FrameTitle } from "./frame-title";
import { designUrl } from "../../shared/design-canvas/url";
import type { DesignNode } from "../canvas-adapter-core";
import { useDesignNodeContext, withVersion } from "./design-node-context";
import { DesignNodeResizer, FrameSkeleton, MissingFrame } from "./frame-parts";

export function ImageNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { frame } = data;
  const version = canvas.versionOf(frame.path);
  const [brokenVersion, setBrokenVersion] = React.useState<number | null>(null);
  const src = canvas.grant && frame.path ? withVersion(designUrl(canvas.grant, frame.path), version) : null;

  let body: React.ReactNode;
  if (brokenVersion === version) body = <MissingFrame path={frame.path} onRemove={() => canvas.remove(id)} />;
  else if (src) {
    body = (
      <img
        src={src}
        alt={frame.title}
        draggable={false}
        onError={() => setBrokenVersion(version)}
        className="block h-full w-full object-contain"
      />
    );
  } else body = <FrameSkeleton title={frame.title} />;

  return (
    <>
      <DesignNodeResizer selected={selected} />
      <CanvasNodeChrome
        title={frame.title}
        titleSlot={<FrameTitle frame={frame} />}
        selected={selected}
        flush
        toolbar={<FrameActions frame={frame} />}
      >
        <div className="h-full w-full overflow-hidden rounded-b-button">{body}</div>
      </CanvasNodeChrome>
    </>
  );
}
