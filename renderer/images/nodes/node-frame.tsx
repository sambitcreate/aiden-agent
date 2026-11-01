import type * as React from "react";
import type { WorkflowNodeDimensions } from "../../shared/images/schema";
import { IMAGE_NODE_WIDTH } from "../node-dimensions-core";

/**
 * The box React Flow lays out and attaches edges to. A node with stored dimensions renders at
 * exactly that size (the same width and height the flow adapter hands React Flow); any other node
 * takes the shared width and its content's height, which React Flow measures.
 */
export function ImageNodeFrame({ dimensions, children }: React.PropsWithChildren<{ dimensions?: WorkflowNodeDimensions }>) {
  return (
    <div
      className="image-node"
      data-sized={dimensions ? "true" : undefined}
      style={dimensions ? { width: dimensions.width, height: dimensions.height } : { width: IMAGE_NODE_WIDTH }}
    >
      {children}
    </div>
  );
}
