// A sticky note the person writes on the canvas, with formatting from the
// bar above it. Each time the note takes focus, the first change starts one
// undo step for that round of typing.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { CanvasNodeChrome } from "../../canvas";
import { FrameTitle } from "./frame-title";
import { DESIGN_CANVAS_LIMITS } from "../../shared/design-canvas/schema";
import type { DesignNode } from "../canvas-adapter-core";
import { useDesignNodeContext } from "./design-node-context";
import { designColorVar, designFillVar, DESIGN_TEXT_PX } from "./draw-style";
import { focusInFormatBar, FormatBar, richEditorKeyDown } from "./format-bar";
import { DesignNodeResizer } from "./frame-parts";
import {
  NO_RICH_TEXT_STATE,
  RichTextEditor,
  type RichTextEditorHandle,
  type RichTextState,
} from "./rich-text-editor";

export function NoteNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { frame } = data;
  const editor = React.useRef<RichTextEditorHandle | null>(null);
  const startsUndoStep = React.useRef(true);
  const [focused, setFocused] = React.useState(false);
  const [state, setState] = React.useState<RichTextState>(NO_RICH_TEXT_STATE);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const { autoFocusId, autoFocusDone, update } = canvas;

  React.useEffect(() => {
    if (autoFocusId !== id) return;
    editor.current?.focus();
    autoFocusDone(id);
  }, [autoFocusId, autoFocusDone, id]);

  const onChange = React.useCallback(
    (text: string) => {
      update(id, { text }, { record: startsUndoStep.current });
      startsUndoStep.current = false;
    },
    [id, update],
  );

  return (
    <>
      <DesignNodeResizer selected={selected} />
      <FormatBar
        frame={frame}
        editor={editor}
        editing={focused}
        forceVisible={focused || linkOpen}
        state={state}
        linkOpen={linkOpen}
        onLinkOpenChange={setLinkOpen}
        onEdit={(command) => {
          editor.current?.focus(true);
          if (command) editor.current?.run(command);
        }}
        onLeave={() => {
          setFocused(false);
          setState(NO_RICH_TEXT_STATE);
        }}
      />
      <CanvasNodeChrome
        title={frame.title}
        titleSlot={<FrameTitle frame={frame} />}
        selected={selected}
        flush
        tint={frame.fill ? designFillVar(frame.fill) : undefined}
      >
        <RichTextEditor
          ref={editor}
          value={frame.text ?? ""}
          onChange={onChange}
          label="Note text"
          placeholder="Write a note"
          maxLength={DESIGN_CANVAS_LIMITS.noteChars}
          className="nowheel overflow-y-auto px-3 pb-3"
          style={{
            fontSize: DESIGN_TEXT_PX[frame.size ?? "small"],
            lineHeight: 1.4,
            color: frame.color ? designColorVar(frame.color) : "var(--text-primary)",
          }}
          onFocus={() => {
            startsUndoStep.current = true;
            setFocused(true);
          }}
          onBlur={(event) => {
            if (focusInFormatBar(event.relatedTarget)) return;
            setFocused(false);
            setState(NO_RICH_TEXT_STATE);
          }}
          onKeyDown={richEditorKeyDown}
          onSelectionChange={() => setState(editor.current?.state() ?? NO_RICH_TEXT_STATE)}
        />
      </CanvasNodeChrome>
    </>
  );
}
