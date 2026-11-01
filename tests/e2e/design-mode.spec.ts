import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  E2E_ASSISTANT_RESPONSE,
  expect,
  finishLmStudioOnboarding,
  test,
  waitForToastsToClear,
} from "./fixtures";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const DESIGN_SHORTCUT = `${PRIMARY_MODIFIER}+Shift+L`;
const WORKSPACE_NAME = "Aiden E2E workspace";
const DESIGN_CHAT = "Design chat for the landing page";
const NOTES_CHAT = "Notes chat about something else";
/** Set to a folder to save light and dark screenshots of each design mode state there. */
const SCREENSHOT_DIR = process.env.AIDEN_DESIGN_SCREENSHOTS?.trim();

test.use({
  workspaceSeed: true,
  appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_MODE: "1" },
});

async function setWindowWidth(
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
async function setDisplayWidth(
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
async function previewAppearance(
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

async function capture(page: Page, name: string): Promise<void> {
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

async function chooseWorkspace(page: Page, name: RegExp): Promise<void> {
  const picker = page.getByRole("button", { name: "Choose a workspace" });
  await picker.click();
  const option = page.getByRole("option", { name });
  await option.click();
  await expect(option).toHaveCount(0);
}

async function sendFirstMessage(page: Page, text: string): Promise<void> {
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

/** A No workspace chat and then a workspace chat, which is left open. */
async function openTwoChats(page: Page): Promise<void> {
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await chooseWorkspace(page, /^No workspace/u);
  await sendFirstMessage(page, NOTES_CHAT);
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, DESIGN_CHAT);
}

async function typeSlashCommand(page: Page, command: string): Promise<void> {
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.pressSequentially(command);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

const designLayout = (page: Page) => page.locator("[data-design-layout]");
const sidebar = (page: Page) => page.locator("[data-sidebar]");
const scopeList = (page: Page) =>
  sidebar(page).locator("[data-sidebar-scope-list]");
const sidebarChat = (page: Page, title: string) =>
  sidebar(page)
    .getByRole("button", { name: new RegExp(`^${title}`, "u") })
    .first();
const designToggle = (page: Page) =>
  page.getByRole("button", { name: "Design mode", exact: true });
const designCanvas = (page: Page) =>
  page.getByRole("region", { name: "Design canvas", exact: true });
const canvasRegion = (page: Page) =>
  page.locator("[data-design-canvas-region]");
const banner = (page: Page) =>
  page.getByText("Design mode needs a wider window");
const paneSwitch = (page: Page) =>
  page.getByRole("radiogroup", { name: "Design mode view" });
const windowWidth = (app: ElectronApplication) =>
  app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width,
  );

async function rightEdge(
  locator: ReturnType<Page["locator"]>,
): Promise<number> {
  const box = await locator.boundingBox();
  return box ? Math.round(box.x + box.width) : 0;
}

/** Presses Tab (or Shift+Tab) until the target has focus, the way a keyboard user reaches it. */
async function tabTo(
  page: Page,
  target: ReturnType<Page["locator"]>,
  key: "Tab" | "Shift+Tab",
): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  throw new Error(`${key} never reached the target`);
}

/**
 * Every control in the design chat column's top bar, and the title, keep their own space:
 * no two boxes overlap and none spills past the header.
 */
async function expectHeaderClear(page: Page): Promise<void> {
  const problems = await page
    .locator('[data-design-mode="true"] .scroll-area-header')
    .first()
    .evaluate((header) => {
      const header_ = header.getBoundingClientRect();
      const visible = (element: Element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 1 &&
          box.height > 1 &&
          getComputedStyle(element).visibility !== "hidden"
        );
      };
      const title = header.querySelector("h1");
      const pieces: { name: string; box: DOMRect }[] = [];
      if (title && visible(title))
        pieces.push({ name: "title", box: title.getBoundingClientRect() });
      for (const element of header.querySelectorAll(
        "button, [role=radiogroup]",
      )) {
        if (
          title?.contains(element) ||
          (element.closest('[role="radiogroup"]') !== null &&
            element.getAttribute("role") !== "radiogroup")
        )
          continue;
        if (!visible(element)) continue;
        const name =
          element.getAttribute("aria-label") ||
          element.textContent?.trim() ||
          element.tagName;
        pieces.push({ name, box: element.getBoundingClientRect() });
      }
      const found: string[] = [];
      for (const { name, box } of pieces) {
        if (box.left < header_.left - 0.5 || box.right > header_.right + 0.5)
          found.push(`${name} spills out`);
      }
      for (let a = 0; a < pieces.length; a += 1) {
        for (let b = a + 1; b < pieces.length; b += 1) {
          const one = pieces[a].box;
          const two = pieces[b].box;
          const overlapX =
            Math.min(one.right, two.right) - Math.max(one.left, two.left);
          const overlapY =
            Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top);
          if (overlapX > 0.5 && overlapY > 0.5)
            found.push(`${pieces[a].name} overlaps ${pieces[b].name}`);
        }
      }
      return { found, count: pieces.length };
    });
  expect(problems.count).toBeGreaterThan(2);
  expect(problems.found).toEqual([]);
}

test("design mode puts the chat beside a canvas, stays with its chat and gives the panel back on exit", async ({
  aiden,
}) => {
  const { app } = aiden;
  let page = aiden.page;
  await openTwoChats(page);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);

  // Before entry: the Files tab is open in the Environment panel.
  const panel = page.getByRole("complementary", {
    name: "Environment work surface",
  });
  await page.locator("[data-environment-toggle]").click();
  await panel.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    panel.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "false");
  await capture(page, "1440-design-off");

  await typeSlashCommand(page, "/design");
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(designCanvas(page)).toHaveCount(1);
  await expect(canvasRegion(page)).toHaveAttribute(
    "data-design-canvas-region",
    "split",
  );
  await expect(
    designCanvas(page).getByText("Designs will appear here."),
  ).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(paneSwitch(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Hide sidebar" }),
  ).toBeVisible();

  // The chat is a 420 px column and the canvas takes the rest of the window, once the
  // Environment panel's space has finished closing.
  await expect.poll(() => rightEdge(canvasRegion(page))).toBe(1440);
  const column = await page.locator('[data-design-mode="true"]').boundingBox();
  const canvasBox = await canvasRegion(page).boundingBox();
  expect(column && canvasBox).toBeTruthy();
  expect(Math.abs(column!.width - 420)).toBeLessThanOrEqual(2);
  expect(
    Math.abs(canvasBox!.x - (column!.x + column!.width)),
  ).toBeLessThanOrEqual(1);
  expect(canvasBox!.width).toBeGreaterThanOrEqual(320);

  // The Live pill stays in the chat column, clear of the canvas.
  const pill = page.locator(".aiden-dock-inset").first();
  if ((await pill.count()) > 0 && (await pill.isVisible())) {
    expect(await rightEdge(pill)).toBeLessThanOrEqual(
      Math.round(canvasBox!.x) + 1,
    );
  }

  // The sidebar shows only this workspace's chats, under ‹ All workspaces and a workspace heading.
  await expect(
    scopeList(page).getByRole("button", { name: "All workspaces" }),
  ).toBeVisible();
  await expect(
    scopeList(page).getByRole("heading", { name: WORKSPACE_NAME }),
  ).toBeVisible();
  await expect(sidebarChat(page, DESIGN_CHAT)).toBeVisible();
  await expect(sidebarChat(page, NOTES_CHAT)).toHaveCount(0);
  await capture(page, "1440-design-on");

  // Escape belongs to whatever has focus; it never leaves design mode.
  await page.locator("textarea").first().focus();
  await page.keyboard.press("Escape");
  await designCanvas(page).click({ position: { x: 40, y: 200 } });
  await page.keyboard.press("Escape");
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );

  // A reload keeps design mode on for this chat, and never resizes the window.
  await page.reload();
  page = aiden.page;
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expect(designCanvas(page)).toBeVisible();
  await expect(scopeList(page)).toBeVisible();
  expect(await windowWidth(app)).toBe(1440);

  // Enter on ‹ All workspaces shows every workspace again, still in design mode, with a way back.
  const allWorkspaces = sidebar(page).getByRole("button", {
    name: "All workspaces",
  });
  await allWorkspaces.focus();
  await page.keyboard.press("Enter");
  await expect(scopeList(page)).toHaveCount(0);
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  const showOnly = sidebar(page).getByRole("button", {
    name: `Show only ${WORKSPACE_NAME}`,
  });
  await expect(showOnly).toBeVisible();
  await capture(page, "1440-all-workspaces-cleared");

  // Another chat has its own, normal layout; coming back brings design mode back.
  await sidebarChat(page, NOTES_CHAT).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    new RegExp(`^${NOTES_CHAT}`, "u"),
  );
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(designCanvas(page)).toHaveCount(0);
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "false");
  await sidebarChat(page, DESIGN_CHAT).click();
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  // The person chose All workspaces for this chat, which holds for the window session.
  await expect(scopeList(page)).toHaveCount(0);
  await showOnly.click();
  await expect(scopeList(page)).toBeVisible();
  await capture(page, "1440-scoped-sidebar");

  // The shortcut leaves design mode and gives back the Files tab and the full sidebar.
  await page.locator("textarea").first().focus();
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(
    panel.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(sidebarChat(page, NOTES_CHAT)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hide sidebar" }),
  ).toBeVisible();

  // The top-bar button turns it back on, scoped to the workspace again.
  await designToggle(page).click();
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expect(scopeList(page)).toBeVisible();

  // Keyboard focus: Shift+Tab back from the composer to the toggle, then Tab on to the divider.
  await page.locator("textarea").first().click();
  await tabTo(page, designToggle(page), "Shift+Tab");
  await capture(page, "1440-design-toggle-focused");
  const divider = page.getByRole("separator", { name: "Resize chat" });
  await tabTo(page, divider, "Tab");
  await capture(page, "1440-divider-focused");

  // At its narrowest (360 px) the column's top bar still keeps every control clear of the title.
  await page.keyboard.press("Home");
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator('[data-design-mode="true"]').boundingBox())
          ?.width ?? 0,
      ),
    )
    .toBe(360);
  await expectHeaderClear(page);
  await expect(
    page.getByRole("button", { name: /^(Show|Hide) terminal$/u }),
  ).toHaveCount(0);
  await capture(page, "1440-chat-360");
  await page.keyboard.press("End");
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");

  // The slash palette offers /design here.
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.pressSequentially("/des");
  await expect(
    page.getByRole("option", { name: /Design mode/u }),
  ).toBeVisible();
  await capture(page, "1440-slash-design");
  await composer.fill("");
});

test("design mode fits narrow windows: split beside the sidebar, stacked below 680 px, and resizes only for a person", async ({
  aiden,
}) => {
  const { app } = aiden;
  let page = aiden.page;
  await openTwoChats(page);
  // A display too narrow to widen into, so nothing below may offer to widen.
  await setDisplayWidth(app, 1000);
  await setWindowWidth(app, page, 1440);
  await expect(
    page.getByRole("button", { name: "Hide sidebar" }),
  ).toBeVisible();
  await typeSlashCommand(page, "/design");
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );

  // At 1000 px the chat and canvas still fit beside the open sidebar.
  await setWindowWidth(app, page, 1000);
  await expect(
    page.getByRole("button", { name: "Hide sidebar" }),
  ).toBeVisible();
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expect.poll(() => rightEdge(canvasRegion(page))).toBe(1000);
  expect(
    (await canvasRegion(page).boundingBox())!.width,
  ).toBeGreaterThanOrEqual(320);
  await expect(paneSwitch(page)).toHaveCount(0);
  await capture(page, "1000-split-sidebar-open");
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Show sidebar" }),
  ).toBeVisible();
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await capture(page, "1000-split-sidebar-collapsed");

  // Below 680 px of content the panes stack behind a Chat | Canvas switch. The display cannot
  // take a wider window, so there is no banner.
  await setWindowWidth(app, page, 640);
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "stacked",
  );
  await expect(paneSwitch(page)).toBeVisible();
  await expect(
    paneSwitch(page).getByRole("radio", { name: "Chat" }),
  ).toBeChecked();
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(canvasRegion(page)).toBeHidden();
  await expect(banner(page)).toHaveCount(0);
  expect(await windowWidth(app)).toBe(640);
  await expectHeaderClear(page);
  await capture(page, "640-stacked-chat");

  await paneSwitch(page).getByRole("radio", { name: "Canvas" }).click();
  await expect(designCanvas(page)).toBeVisible();
  await expect(
    designCanvas(page).getByText("Designs will appear here."),
  ).toBeVisible();
  await expect(page.locator("textarea").first()).toBeHidden();
  await capture(page, "640-stacked-canvas");
  await paneSwitch(page).getByRole("radio", { name: "Chat" }).click();
  await expect(page.locator("textarea").first()).toBeVisible();

  // On a display with room to widen, a reload shows the banner but leaves the window alone.
  await setDisplayWidth(app, 1440);
  await page.reload();
  page = aiden.page;
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "stacked",
  );
  await expect(banner(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Widen window" }),
  ).toBeVisible();
  expect(await windowWidth(app)).toBe(640);
  await capture(page, "640-banner");

  // Switching chats never resizes either. The design chat scopes the sidebar to its
  // workspace, so step out to All workspaces to reach the other chat.
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await scopeList(page).getByRole("button", { name: "All workspaces" }).click();
  await sidebarChat(page, NOTES_CHAT).click();
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(banner(page)).toHaveCount(0);
  const showSidebar = page.getByRole("button", { name: "Show sidebar" });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await sidebarChat(page, DESIGN_CHAT).click();
  // The overlay sidebar stays open after a pick; Escape closes it.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-compact-sidebar-open]")).toHaveAttribute(
    "data-compact-sidebar-open",
    "false",
  );
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "stacked",
  );
  await expect(banner(page)).toBeVisible();
  expect(await windowWidth(app)).toBe(640);

  // Dismiss hides the banner; Widen window makes room and the split comes back.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner(page)).toHaveCount(0);
  await page.reload();
  page = aiden.page;
  await page.getByRole("button", { name: "Widen window" }).click();
  await expect.poll(() => windowWidth(app)).toBeGreaterThanOrEqual(1024);
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expect(banner(page)).toHaveCount(0);
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");

  // A person's entry at 800 px makes room by collapsing the sidebar, and exit gives it back.
  await setWindowWidth(app, page, 800);
  // Earlier steps hid the sidebar by hand; open it again first.
  const reopen = page.getByRole("button", { name: "Show sidebar" });
  if (await reopen.isVisible()) await reopen.click();
  await expect(
    page.getByRole("button", { name: "Hide sidebar" }),
  ).toBeVisible();
  await designToggle(page).click();
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expect(
    page.getByRole("button", { name: "Show sidebar" }),
  ).toBeVisible();
  expect(await windowWidth(app)).toBe(800);
  await designToggle(page).click();
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(
    page.getByRole("button", { name: "Hide sidebar" }),
  ).toBeVisible();

  // At 640 px collapsing is not enough, so the person's entry widens the window instead.
  await setWindowWidth(app, page, 640);
  await typeSlashCommand(page, "/design");
  await expect.poll(() => windowWidth(app)).toBeGreaterThanOrEqual(1024);
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expect(banner(page)).toHaveCount(0);
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
});
