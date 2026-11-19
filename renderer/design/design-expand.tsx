// Expand and Minimize for design mode: Expand collapses the app sidebar so the
// chat (on the left) and the canvas fill the window; Minimize brings the
// sidebar back. The layout owns the state; the canvas shows the button.

import { Expand, Shrink } from "lucide-react";
import * as React from "react";
import { Button } from "../components/ui";
import { useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";

export interface DesignExpandState {
  /** False outside design mode, or where there is no sidebar to collapse. */
  available: boolean;
  /** True while the sidebar is collapsed in design mode. */
  expanded: boolean;
  setExpanded(expanded: boolean): void;
}

export const DesignExpandContext = React.createContext<DesignExpandState>({
  available: false,
  expanded: false,
  setExpanded: () => {},
});

export function useDesignExpand(): DesignExpandState {
  return React.useContext(DesignExpandContext);
}

/**
 * The canvas's Expand or Minimize button. Its label says what a press does,
 * so it carries no pressed state, and focus stays on it across the swap.
 */
export function DesignExpandButton() {
  const state = useDesignExpand();
  // The shortcut hooks need the app's command system, which only design mode provides.
  return state.available ? <ExpandToggle {...state} /> : null;
}

function ExpandToggle({ expanded, setExpanded }: DesignExpandState) {
  const binding = useShortcutBinding("design.expand");
  const shortcut = useShortcutLabel("design.expand");
  const label = expanded ? "Minimize canvas" : "Expand canvas";
  return (
    <Button
      iconOnly
      variant="bar"
      size="small"
      aria-label={label}
      aria-keyshortcuts={ariaKeyShortcut(binding)}
      title={binding ? `${label} (${shortcut})` : label}
      data-design-expand={expanded ? "expanded" : "minimized"}
      onClick={() => setExpanded(!expanded)}
    >
      {expanded ? <Shrink aria-hidden /> : <Expand aria-hidden />}
    </Button>
  );
}
