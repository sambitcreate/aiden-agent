import type { BrowserWindow } from "electron";

import { DataStore } from "./data-store.js";
import {
  normalizeMainWindowState,
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

export const mainWindowState = {
  async restore(workAreas: readonly WindowBounds[]) {
    const state = await persistence.load();
    return {
      bounds: restoredMainWindowBounds(state.bounds, workAreas),
      maximized: state.maximized,
      fullScreen: state.fullScreen,
    };
  },

  async save(window: BrowserWindow): Promise<void> {
    const bounds = window.getNormalBounds();
    await persistence.save({
      version: 1,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    });
  },
};
