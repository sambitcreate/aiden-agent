import assert from "node:assert/strict";
import test from "node:test";
import { installAccessibilityRefresh } from "./accessibility-refresh.js";

test("accessibility status refreshes on focus and when the app becomes visible", () => {
  const listeners = new Map<string, () => void>();
  let refreshes = 0;
  const windowEvents = {
    addEventListener: (name: string, fn: () => void) => listeners.set(`w:${name}`, fn),
    removeEventListener: (name: string) => listeners.delete(`w:${name}`),
  };
  const documentEvents = {
    visibilityState: "hidden",
    addEventListener: (name: string, fn: () => void) => listeners.set(`d:${name}`, fn),
    removeEventListener: (name: string) => listeners.delete(`d:${name}`),
  };
  const cleanup = installAccessibilityRefresh(
    () => {
      refreshes += 1;
    },
    windowEvents,
    documentEvents,
  );
  listeners.get("w:focus")!();
  listeners.get("d:visibilitychange")!();
  documentEvents.visibilityState = "visible";
  listeners.get("d:visibilitychange")!();
  assert.equal(refreshes, 2);
  cleanup();
  assert.equal(listeners.size, 0);
});
