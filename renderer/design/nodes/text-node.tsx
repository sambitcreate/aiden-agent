// Text placed with the Text tool: words straight on the canvas, no card,
// formatted from the bar above it.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { richTextPlain } from "../../shared/design-canvas/rich-text";
import { designMinSize } from "../../shared/design-canvas/schema";
import type { DesignNode } from "../canvas-adapter-core";
import { CanvasText, type CanvasRichText } from "./canvas-text";
import { designColorVar, DESIGN_DRAW_DEFAULTS, DESIGN_TEXT_PX } from "./draw-style";
import { FormatBar } from "./format-bar";
import { DesignNodeResizer } from "./frame-parts";
import { useDesignNodeContext } from "./design-node-context";
import {
  NO_RICH_TEXT_STATE,
  type RichTextCommand,
  type RichTextEditorHandle,
  type RichTextState,
} from "./rich-text-editor";

export function TextNode({ data, selected }: NodeProps<DesignNode>) {
  const { frame } = data;
  const canvas = useDesignNodeContext();
  const editing = canvas.editing === frame.id;
  const editorRef = React.useRef<RichTextEditorHandle | null>(null);
  // A format command given before editing started runs once the editor is up.
  const pending = React.useRef<RichTextCommand | null>(null);
  const [state, setState] = React.useState<RichTextState>(NO_RICH_TEXT_STATE);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const size = DESIGN_TEXT_PX[frame.size ?? DESIGN_DRAW_DEFAULTS.text.size];
  const plain = frame.text ? richTextPlain(frame.text) : "";

  const rich = React.useMemo<CanvasRichText>(
    () => ({
      editorRef,
      onReady: () => {
        const command = pending.current;
        pending.current = null;
        if (!command) return;
        editorRef.current?.focus(true);
        editorRef.current?.run(command);
      },
      onSelectionChange: () => setState(editorRef.current?.state() ?? NO_RICH_TEXT_STATE),
    }),
    [],
  );

  if (!editing && state !== NO_RICH_TEXT_STATE) setState(NO_RICH_TEXT_STATE);

  return (
    <>
      <DesignNodeResizer selected={selected && !editing} minSize={designMinSize("text")} />
      <FormatBar
        frame={frame}
        editor={editorRef}
        editing={editing}
        forceVisible={editing || linkOpen}
        state={state}
        linkOpen={linkOpen}
        onLinkOpenChange={setLinkOpen}
        onEdit={(command) => {
          pending.current = command ?? null;
          if (editing) rich.onReady();
          else canvas.edit(frame.id);
        }}
        onLeave={() => {
          if (!editing) return;
          canvas.edit(null);
          if (!plain.trim()) canvas.remove(frame.id);
        }}
      />
      <div
        role="group"
        aria-label={plain ? `Text: ${plain.slice(0, 80)}` : "Text"}
        data-selected={selected ? "true" : "false"}
        className="h-full w-full"
      >
        <CanvasText
          frame={frame}
          label="Text"
          placeholder="Type something"
          grow
          removeWhenEmpty
          rich={rich}
          style={{
            fontSize: size,
            lineHeight: 1.3,
            color: frame.color ? designColorVar(frame.color) : "var(--text-primary)",
          }}
        />
      </div>
    </>
  );
}
