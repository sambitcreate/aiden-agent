import { Handle, Position, useStoreApi } from "@xyflow/react";
import type * as React from "react";
import { IMAGE_NODE_DEFINITIONS } from "../../shared/images/ports";
import type { ImageNodeType } from "../../shared/images/schema";

const FIRST_PORT_TOP = 44;
const PORT_GAP = 28;

/**
 * Ports are keyboard controls too. Enter or Space on a port does what a click does (React Flow's
 * click-to-connect): the first port starts a connection and the second completes it, through the
 * same validation as a drag. Escape abandons a connection that was started.
 */
function usePortKeys() {
  const store = useStoreApi();
  return (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      // Handled here: the node must not toggle selection and the canvas must not switch tools.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) event.currentTarget.click();
    } else if (event.key === "Escape" && store.getState().connectionClickStartHandle) {
      event.preventDefault();
      event.stopPropagation();
      store.setState({ connectionClickStartHandle: null });
    }
  };
}

/** One labelled handle per typed port; the id is the port id the schema stores on edges. */
export function NodePorts({ type }: { type: ImageNodeType }) {
  const definition = IMAGE_NODE_DEFINITIONS[type];
  const onKeyDown = usePortKeys();
  return (
    <>
      {definition.inputs.map((port, index) => (
        <Handle
          key={`in-${port.id}`}
          id={port.id}
          type="target"
          position={Position.Left}
          className="image-port"
          data-kind={port.kind}
          role="button"
          tabIndex={0}
          aria-label={`${port.label} input`}
          aria-keyshortcuts="Enter Space Escape"
          title={port.label}
          onKeyDown={onKeyDown}
          style={{ top: FIRST_PORT_TOP + index * PORT_GAP }}
        />
      ))}
      {definition.outputs.map((port, index) => (
        <Handle
          key={`out-${port.id}`}
          id={port.id}
          type="source"
          position={Position.Right}
          className="image-port"
          data-kind={port.kind}
          role="button"
          tabIndex={0}
          aria-label={`${port.label} output`}
          aria-keyshortcuts="Enter Space Escape"
          title={port.label}
          onKeyDown={onKeyDown}
          style={{ top: FIRST_PORT_TOP + index * PORT_GAP }}
        />
      ))}
    </>
  );
}
