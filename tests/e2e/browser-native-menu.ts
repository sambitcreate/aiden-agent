import type { ElectronApplication } from "@playwright/test";
import { expect } from "./fixtures";

/** Playwright locators cannot see OS menus. Observe the real popup and use Electron's item to select or dismiss it. */
export async function observeNextBrowserMenu(app: ElectronApplication) {
  const handle = await app.evaluateHandle(({ Menu }) => {
    const popup = Menu.prototype.popup;
    const observed = { open: false, closed: false, menu: null as Electron.Menu | null, window: undefined as Electron.BaseWindow | undefined };
    Menu.prototype.popup = function (options = {}) {
      Menu.prototype.popup = popup;
      observed.menu = this;
      observed.window = options.window;
      this.once("menu-will-show", () => { observed.open = true; });
      this.once("menu-will-close", () => { observed.open = false; });
      return popup.call(this, { ...options, callback: () => {
        options.callback?.();
        observed.closed = true;
      } });
    };
    return observed;
  });
  return {
    async waitForOpen() {
      await expect.poll(() => handle.evaluate(state => {
        if (state.open) return "open";
        if (state.closed) return "closed";
        return state.menu ? "waiting for menu-will-show: " + state.menu.items[0]?.label : "waiting for popup";
      })).toBe("open");
    },
    async close(label?: string) {
      await handle.evaluate((state, selectedLabel) => {
        if (!state.open || !state.menu) throw new Error("The native browser menu is closed.");
        if (selectedLabel !== undefined) {
          const item = state.menu.items.find(entry => entry.label === selectedLabel);
          if (!item?.enabled) throw new Error(`Missing enabled native menu item: ${selectedLabel}`);
          item.click({}, state.window);
        }
        state.menu.closePopup(state.window);
      }, label);
      // AppKit dismisses asynchronously. Wait for Electron to finish tracking the
      // first popup before a test can open another one in the same window.
      await expect.poll(() => handle.evaluate(state => state.closed)).toBe(true);
      await handle.dispose();
    },
  };
}
