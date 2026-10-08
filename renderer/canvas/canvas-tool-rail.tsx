import { Hand, MousePointer2 } from "lucide-react";
import { Button } from "../components/ui";
import { CANVAS_TOOL_SHORTCUTS, type CanvasTool } from "./canvas-keymap-core";

const TOOLS = [
  { tool: "select", label: "Select", Icon: MousePointer2 },
  { tool: "hand", label: "Hand", Icon: Hand },
] as const satisfies readonly { tool: CanvasTool; label: string; Icon: typeof Hand }[];

export function CanvasToolRail({
  tool,
  onToolChange,
}: {
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className="glass-surface flex flex-col gap-1 rounded-button p-1 shadow-control"
    >
      {TOOLS.map(({ tool: item, label, Icon }) => {
        const shortcut = CANVAS_TOOL_SHORTCUTS[item];
        return (
          <Button
            key={item}
            variant={tool === item ? "muted" : "transparent"}
            iconOnly
            aria-label={label}
            aria-pressed={tool === item}
            aria-keyshortcuts={shortcut}
            title={`${label} (${shortcut})`}
            onClick={() => onToolChange(item)}
          >
            <Icon />
          </Button>
        );
      })}
    </div>
  );
}
