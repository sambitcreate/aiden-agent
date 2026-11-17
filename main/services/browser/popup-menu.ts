import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { BrowserMenuChoice, BrowserMenuItem } from "../../../renderer/shared/browser.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";

const openMenus = new WeakMap<Electron.WebContents, { id: string; dismiss: () => void }>();

export function dismissBrowserMenu(sender: Electron.WebContents, id: unknown): void {
  const current = openMenus.get(sender);
  if (current && current.id === id) current.dismiss();
}

/** Only display plain choices. All commands and their authorization stay with their existing callers. */
export async function popupBrowserMenu(
  sender: Electron.WebContents, owner: RendererDocumentOwner, id: unknown,
  point: { x: number; y: number }, items: BrowserMenuItem[],
): Promise<BrowserMenuChoice | null> {
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.webContents !== sender || owner.isDestroyed()) return null;
  if (typeof id !== "string" || id.length > 64 || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !Array.isArray(items) || !items.length || items.length > 512) throw new Error("Invalid browser menu.");
  if (openMenus.has(sender)) return null;

  let choice: BrowserMenuChoice | null = null;
  const template = items.map((item, index): MenuItemConstructorOptions => {
    if (item === null) return { type: "separator" };
    if (typeof item?.label !== "string" || typeof item.enabled !== "boolean") throw new Error("Invalid browser menu item.");
    const label = item.label.slice(0, 256).replace(/\p{Cc}/gu, " ");
    return {
      label: process.platform === "darwin" ? label : label.replace(/&/gu, "&&"),
      enabled: item.enabled,
      type: typeof item.checked === "boolean" ? "checkbox" : "normal",
      checked: item.checked === true,
      click: (_item, _window, event) => { choice = { index, shiftKey: event?.shiftKey === true }; },
    };
  });
  const menu = Menu.buildFromTemplate(template);
  const zoom = sender.getZoomFactor();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  let dismissed = false;
  const dismiss = () => {
    dismissed = true;
    if (!window.isDestroyed()) menu.closePopup(window);
  };
  openMenus.set(sender, { id, dismiss });
  const unsubscribe = owner.onInvalidated(() => {
    dismiss();
    // A destroyed window may never run the native close callback.
    finish();
  });
  try {
    if (dismissed) return null;
    menu.popup({ window, x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), callback: finish });
    await closed;
    return dismissed ? null : choice;
  } finally {
    unsubscribe();
    openMenus.delete(sender);
  }
}
