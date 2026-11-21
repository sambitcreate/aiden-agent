import assert from "node:assert/strict";
import test from "node:test";

import { applyDockIcon, type DockIconSurface } from "./dock-icon.js";

function fakeDock(visible: boolean) {
  const events: string[] = [];
  let shown = visible;
  const dock: DockIconSurface = {
    setIcon: (icon) => void events.push(`icon:${String(icon)}`),
    isVisible: () => shown,
    show: async () => {
      events.push("show");
      shown = true;
    },
  };
  return { dock, events };
}

test("changing the icon of a visible Dock tile never re-shows it, so Aiden keeps focus", async () => {
  const { dock, events } = fakeDock(true);
  await applyDockIcon(dock, "monochrome");
  await applyDockIcon(dock, "aiden");
  assert.deepEqual(events, ["icon:monochrome", "icon:aiden"]);
});

test("a hidden Dock tile gets the icon and is shown once", async () => {
  const { dock, events } = fakeDock(false);
  await applyDockIcon(dock, "aiden");
  await applyDockIcon(dock, "monochrome");
  assert.deepEqual(events, ["icon:aiden", "show", "icon:monochrome"]);
});
