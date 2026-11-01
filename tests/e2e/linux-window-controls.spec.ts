import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test, waitForToastsToClear } from "./fixtures";

// Aiden's own Linux title bar: no desktop frame or menu bar, Aiden-drawn
// window controls in the 52px top bar, and the system title bar as an opt-out.
test.skip(process.platform !== "linux", "The Aiden-drawn title bar is Linux-only.");

function windowControls(page: Page): Locator {
  return page.getByRole("group", { name: "Window", exact: true });
}

async function menuBarVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible());
}

async function sendWindowState(app: ElectronApplication, state: { maximized: boolean; fullScreen: boolean }) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send("app:window-state", payload);
  }, state);
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function startChat(page: Page): Promise<void> {
  await finishLmStudioOnboarding(page);
  await page.locator("textarea").fill("Window controls check");
  await page.locator("textarea").press("Enter");
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });
  await waitForToastsToClear(page);
}

test.describe("Aiden title bar", () => {
  test.use({ workspaceSeed: true });

  test("draws the window controls in the top bar instead of a desktop title bar", async ({ aiden }) => {
    const { app, page } = aiden;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startChat(page);

    await expect(page.locator("html")).toHaveAttribute("data-window-chrome", "aiden");
    expect(await menuBarVisible(app)).toBe(false);
    const controls = windowControls(page);
    await expect(controls.getByRole("button")).toHaveCount(3);
    await expect(controls.getByRole("button", { name: "Minimize" })).toBeVisible();
    await expect(controls.getByRole("button", { name: "Maximize" })).toBeVisible();
    await expect(controls.getByRole("button", { name: "Close" })).toBeVisible();

    // The controls sit in the top-right corner of the 52px bar.
    const viewport = await page.evaluate(() => document.documentElement.clientWidth);
    const controlsBox = (await controls.boundingBox())!;
    expect(controlsBox.y).toBe(0);
    expect(Math.round(controlsBox.x + controlsBox.width)).toBe(viewport);

    // The leading cluster starts at the window edge with the main menu first;
    // no space is held for macOS traffic lights.
    const menu = page.getByRole("button", { name: "Main menu" });
    await expect(menu).toBeVisible();
    expect(Math.round((await menu.boundingBox())!.x)).toBeLessThan(20);

    // No top-bar action sits under the window controls.
    const header = page.locator("header[data-toolbar]").first();
    for (const action of await header.getByRole("button").all()) {
      if (!(await action.isVisible())) continue;
      expect(overlaps((await action.boundingBox())!, controlsBox), await action.getAttribute("aria-label") ?? "").toBe(false);
    }

    // A docked Environment panel takes the corner, so its tab strip makes room
    // instead of the chat header.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 800));
    await page.getByRole("button", { name: "Show Environment" }).click();
    const strip = page.locator('[data-environment-surface="tools"] header').first();
    await expect(strip).toBeVisible();
    const docked = await page.evaluate(() => {
      const strip = document.querySelector('[data-environment-surface="tools"] header');
      return Math.round(strip!.getBoundingClientRect().right) === document.documentElement.clientWidth;
    });
    expect(docked, "at 1600px the Environment panel docks against the right edge").toBe(true);
    const dockedControls = (await controls.boundingBox())!;
    for (const action of await strip.getByRole("button").all()) {
      if (!(await action.isVisible())) continue;
      expect(overlaps((await action.boundingBox())!, dockedControls), await action.getAttribute("aria-label") ?? "").toBe(false);
    }
    await page.getByRole("button", { name: "Hide Environment" }).first().click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));

    // Maximize follows the window's state, and full screen hides the controls.
    await sendWindowState(app, { maximized: true, fullScreen: false });
    await expect(controls.getByRole("button", { name: "Restore" })).toBeVisible();
    await sendWindowState(app, { maximized: false, fullScreen: true });
    await expect(controls).toHaveCount(0);
    await expect(header).not.toHaveCSS("padding-right", `${Math.round(controlsBox.width) + 4}px`);
    await sendWindowState(app, { maximized: false, fullScreen: false });
    await expect(controls.getByRole("button", { name: "Maximize" })).toBeVisible();

    // Minimize reaches the main window. (Headless CI has no window manager
    // to iconify it, so count the call instead of reading isMinimized.)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const calls = { count: 0 };
      (globalThis as { __minimizeCalls?: typeof calls }).__minimizeCalls = calls;
      window.minimize = () => {
        calls.count += 1;
      };
    });
    await controls.getByRole("button", { name: "Minimize" }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __minimizeCalls?: { count: number } }).__minimizeCalls?.count))
      .toBe(1);
  });

  test("the system title bar switch takes effect on the next launch", async ({ aiden }) => {
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Use system title bar" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Takes effect the next time you open Aiden.")).toBeVisible();
    // Aiden's controls stay until the relaunch.
    await expect(windowControls(page)).toBeVisible();
    // The preference is saved after a short debounce.
    await expect
      .poll(async () => {
        try {
          const saved = JSON.parse(await readFile(path.join(aiden.userDataDir, "settings.json"), "utf8"));
          return saved.settings?.appearance?.linuxTitleBar;
        } catch {
          return undefined;
        }
      })
      .toBe("system");

    page = await aiden.relaunch();
    await expect(page.locator("html")).toHaveAttribute("data-window-chrome", "system");
    await expect(windowControls(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Main menu" })).toHaveCount(0);
    expect(await menuBarVisible(aiden.app)).toBe(true);
  });
});

test.describe("tiling window managers", () => {
  test.use({ appEnvironment: { XDG_CURRENT_DESKTOP: "sway" } });

  test("default to the system title bar", async ({ aiden }) => {
    const { app, page } = aiden;
    await finishLmStudioOnboarding(page);
    await expect(page.locator("html")).toHaveAttribute("data-window-chrome", "system");
    await expect(windowControls(page)).toHaveCount(0);
    expect(await menuBarVisible(app)).toBe(true);
  });
});
