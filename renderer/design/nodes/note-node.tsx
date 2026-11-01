// A sticky note the person writes on the canvas. Each time the note takes
// focus, the first keystroke starts one undo step for that round of typing.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { CanvasNodeChrome } from "../../canvas";
import { DESIGN_CANVAS_LIMITS } from "../../shared/design-canvas/schema";
import type { DesignNode } from "../canvas-adapter-core";
import { useDesignNodeContext } from "./design-node-context";
import { DesignNodeResizer } from "./frame-parts";

export function NoteNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { frame } = data;
  const field = React.useRef<HTMLTextAreaElement | null>(null);
  const startsUndoStep = React.useRef(true);
  const { autoFocusId, autoFocusDone } = canvas;

  React.useEffect(() => {
    if (autoFocusId !== id) return;
    field.current?.focus();
    autoFocusDone(id);
  }, [autoFocusId, autoFocusDone, id]);

  return (
    <>
      <DesignNodeResizer selected={selected} />
      <CanvasNodeChrome title={frame.title} selected={selected} flush>
        <textarea
          ref={field}
          aria-label="Note text"
          value={frame.text ?? ""}
          maxLength={DESIGN_CANVAS_LIMITS.noteChars}
          placeholder="Write a note"
          onFocus={() => {
            startsUndoStep.current = true;
          }}
          onChange={(event) => {
            canvas.update(id, { text: event.target.value }, { record: startsUndoStep.current });
            startsUndoStep.current = false;
          }}
          className="nodrag nowheel block h-full w-full resize-none bg-transparent px-3 pb-3 text-primary outline-none placeholder:text-tertiary"
        />
      </CanvasNodeChrome>
    </>
  );
}
