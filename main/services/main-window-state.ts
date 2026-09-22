import type { BrowserWindow } from "electron";

import { DataStore } from "./data-store.js";
import {
  normalizeMainWindowState,
  trackMainWindowState,
  restoredMainWindowBounds,
  type MainWindowState,
  type WindowBounds,
} from "./main-window-state-core.js";

const persistence = new DataStore<MainWindowState>(
  "main-window-state.json",
  normalizeMainWindowState(null),
  undefined,
  { normalize: normalizeMainWindowState, maxBytes: 4_096 },
);

const trackedWindows = new WeakMap<BrowserWindow, () => MainWindowState>();

export const mainWindowState = {
  track(window: BrowserWindow): void {
    if (!trackedWindows.has(window)) {
      trackedWindows.set(window, trackMainWindowState(window));
    }
  },

  async restore(workAreas: readonly WindowBounds[]) {
    const state = await persistence.load();
    return {
      bounds: restoredMainWindowBounds(state.bounds, workAreas),
      maximized: state.maximized,
      fullScreen: state.fullScreen,
    };
  },

  async save(window: BrowserWindow): Promise<void> {
    const tracked = trackedWindows.get(window);
    if (tracked) {
      await persistence.save(tracked());
      return;
    }
    const bounds = window.getNormalBounds();
    await persistence.save({
      version: 1,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    });
  },
};
