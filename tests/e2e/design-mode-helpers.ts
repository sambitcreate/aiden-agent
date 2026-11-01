// Helpers the design mode e2e specs share: window and display sizing, an
// appearance preview for light and dark screenshots, and opening a workspace chat.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { E2E_ASSISTANT_RESPONSE, expect } from "./fixtures";

export const WORKSPACE_NAME = "Aiden E2E workspace";
/** Set to a folder to save light and dark screenshots of each design mode state there. */
const SCREENSHOT_DIR = process.env.AIDEN_DESIGN_SCREENSHOTS?.trim();

export async function setWindowWidth(
  app: ElectronApplication,
  page: Page,
  width: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, nextWidth) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({
      ...window.getBounds(),
      x: 0,
      y: 0,
      width: nextWidth,
      height: 900,
    });
  }, width);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

/** Pretends the window's display has a work area this wide, as a laptop or a large monitor would. */
export async function setDisplayWidth(
  app: ElectronApplication,
  width: number,
): Promise<void> {
  await app.evaluate(({ screen }, workAreaWidth) => {
    const workArea = { x: 0, y: 0, width: workAreaWidth, height: 900 };
    screen.getDisplayMatching = () => ({
      ...screen.getPrimaryDisplay(),
      workArea,
      bounds: workArea,
    });
  }, width);
}

type AppearanceIpc = {
  aidenAPI: {
    ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
  };
};

/** Previews an appearance the way Settings does, without saving it. */
export async function previewAppearance(
  page: Page,
  mode: "light" | "dark" | null,
): Promise<void> {
  await page.evaluate(async (nextMode) => {
    const { ipc } = (window as unknown as AppearanceIpc).aidenAPI;
    const saved = await ipc.invoke<{ mode: string }>("settings:getAppearance");
    await ipc.invoke(
      "settings:previewAppearance",
      nextMode ? { ...saved, mode: nextMode } : saved,
    );
  }, mode);
}

export async function capture(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.mouse.move(1, 1);
  for (const scheme of ["light", "dark"] as const) {
    await previewAppearance(page, scheme);
    await expect(page.locator("html")).toHaveAttribute(
      "data-appearance-scheme",
      scheme,
    );
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${name}-${scheme}.png`),
      animations: "disabled",
    });
  }
  await previewAppearance(page, null);
}

export async function chooseWorkspace(page: Page, name: RegExp): Promise<void> {
  const picker = page.getByRole("button", { name: "Choose a workspace" });
  await picker.click();
  const option = page.getByRole("option", { name });
  await option.click();
  await expect(option).toHaveCount(0);
}

export async function sendFirstMessage(
  page: Page,
  text: string,
): Promise<void> {
  const composer = page.locator("textarea").first();
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible({
    timeout: 20_000,
  });
  // Every chat is titled from the fake model's reply, so name it after its message instead.
  await page.locator("[data-chat-title-menu]").click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename chat" });
  await dialog.getByRole("textbox", { name: "Chat name" }).fill(text);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-chat-title-menu]")).toContainText(text);
}

export async function typeSlashCommand(
  page: Page,
  command: string,
): Promise<void> {
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.pressSequentially(command);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

export const designLayout = (page: Page) =>
  page.locator("[data-design-layout]");
export const designCanvas = (page: Page) =>
  page.getByRole("region", { name: "Design canvas", exact: true });
export const canvasRegion = (page: Page) =>
  page.locator("[data-design-canvas-region]");
