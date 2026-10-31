// F6 and ⇧F6 between the window's areas, ⌥↑ and ⌥↓ between replies, and the
// palette's "Focus sidebar / conversation / side panel" commands.

import { toast } from "./ui";
import { useCommandHandler, useShortcutBinding } from "../lib/command-system";
import { prettyAccelerator } from "../shared/keybindings";
import { focusRegion, useFocusRegionKeys } from "../lib/focus-regions";

export function KeyboardRegions() {
  useFocusRegionKeys();
  const sidebarBinding = useShortcutBinding("sidebar.toggle");
  const sidebarShortcut = sidebarBinding ? prettyAccelerator(sidebarBinding) : null;
  useCommandHandler("focus.sidebar", () => {
    if (!focusRegion("sidebar"))
      toast.info(sidebarShortcut ? `Show the sidebar first (${sidebarShortcut}).` : "Show the sidebar first.");
  });
  useCommandHandler("focus.chat", () => {
    if (!focusRegion("chat")) toast.info("There’s no conversation on this page.");
  });
  useCommandHandler("focus.panel", () => {
    if (!focusRegion("panel")) toast.info("No side panel is open.");
  });
  return null;
}
