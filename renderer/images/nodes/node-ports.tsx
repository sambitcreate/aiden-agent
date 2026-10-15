import { Handle, Position } from "@xyflow/react";
import { IMAGE_NODE_DEFINITIONS } from "../../shared/images/ports";
import type { ImageNodeType } from "../../shared/images/schema";

const FIRST_PORT_TOP = 44;
const PORT_GAP = 28;

/** One labelled handle per typed port; the id is the port id the schema stores on edges. */
export function NodePorts({ type }: { type: ImageNodeType }) {
  const definition = IMAGE_NODE_DEFINITIONS[type];
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
          aria-label={`${port.label} input`}
          title={port.label}
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
          aria-label={`${port.label} output`}
          title={port.label}
          style={{ top: FIRST_PORT_TOP + index * PORT_GAP }}
        />
      ))}
    </>
  );
}
