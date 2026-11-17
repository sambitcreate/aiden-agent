import type { ElectronApplication, Page } from "@playwright/test";
import {
  canvasRegion,
  capture,
  chooseWorkspace,
  designCanvas,
  designLayout,
  sendFirstMessage,
  setDisplayWidth,
  setWindowWidth,
  typeSlashCommand,
  WORKSPACE_NAME,
} from "./design-mode-helpers";
import {
  expect,
  finishLmStudioOnboarding,
  test,
  waitForToastsToClear,
} from "./fixtures";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const DESIGN_SHORTCUT = `${PRIMARY_MODIFIER}+Shift+L`;
const DESIGN_CHAT = "Design chat for the landing page";
const NOTES_CHAT = "Notes chat about something else";

test.use({
  workspaceSeed: true,
});

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

const sidebar = (page: Page) => page.locator("[data-sidebar]");
const scopeList = (page: Page) =>
  sidebar(page).locator("[data-sidebar-scope-list]");
const sidebarChat = (page: Page, title: string) =>
  sidebar(page)
    .getByRole("button", { name: new RegExp(`^${title}`, "u") })
    .first();
const designToggle = (page: Page) =>
  page.getByRole("button", { name: "Design mode", exact: true });
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

/**
 * The composer's footer controls each keep their own space inside the composer: "+" and Send
 * are there, no two controls overlap, and none spills outside. The context meter shows only
 * outside design mode.
 */
async function expectComposerFooterClear(
  footer: ReturnType<Page["locator"]>,
  { designMode = true }: { designMode?: boolean } = {},
): Promise<void> {
  const problems = await footer.evaluate((row) => {
    const composer = row.closest(".composer-responsive") ?? row;
    const bounds = composer.getBoundingClientRect();
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      if (getComputedStyle(element).visibility === "hidden") return false;
      for (
        let node: Element | null = element;
        node && node !== row;
        node = node.parentElement
      ) {
        if (Number(getComputedStyle(node).opacity) < 0.01) return false;
      }
      return true;
    };
    const pieces = [...row.querySelectorAll("button")]
      .filter(shown)
      .map((element) => ({
        name:
          element.getAttribute("aria-label") ||
          element.textContent?.trim() ||
          "button",
        box: element.getBoundingClientRect(),
      }));
    const found: string[] = [];
    for (const { name, box } of pieces) {
      if (
        box.left < bounds.left - 0.5 ||
        box.right > bounds.right + 0.5 ||
        box.bottom > bounds.bottom + 0.5
      )
        found.push(`${name} spills out of the composer`);
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
    return { found, names: pieces.map((piece) => piece.name) };
  });
  const required = [/^Attach files or images$/u, /^(Send|Queue) message$/u];
  for (const name of required)
    expect(problems.names.some((piece) => name.test(piece))).toBe(true);
  expect(problems.names.some((piece) => /^Context usage/u.test(piece))).toBe(
    !designMode,
  );
  expect(problems.found).toEqual([]);
}

/** Two boxes share no area. */
function apart(
  one: { x: number; y: number; width: number; height: number },
  two: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    one.x + one.width <= two.x + 0.5 ||
    two.x + two.width <= one.x + 0.5 ||
    one.y + one.height <= two.y + 0.5 ||
    two.y + two.height <= one.y + 0.5
  );
}

/** The locator's box once it has stopped moving, so a sidebar or column transition has finished. */
async function settledBox(
  locator: ReturnType<Page["locator"]>,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let last: Awaited<ReturnType<typeof locator.boundingBox>> = null;
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      const still =
        box !== null &&
        last !== null &&
        box.x === last.x &&
        box.y === last.y &&
        box.width === last.width &&
        box.height === last.height;
      last = box;
      return still;
    })
    .toBe(true);
  return last!;
}

/** The canvas's tool rail and zoom controls are on screen, inside the canvas and clear of each other. */
async function expectCanvasChrome(page: Page): Promise<void> {
  const tools = designCanvas(page).getByRole("toolbar", {
    name: "Canvas tools",
  });
  const zoom = designCanvas(page).getByRole("toolbar", { name: "Zoom" });
  await expect(tools).toBeVisible();
  await expect(zoom).toBeVisible();
  await expect(tools.getByRole("button").first()).toBeVisible();
  await expect(zoom.getByRole("button", { name: "Zoom in" })).toBeVisible();
  const region = await settledBox(canvasRegion(page));
  for (const toolbar of [tools, zoom]) {
    const box = (await toolbar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(region.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(
      region.x + region.width + 0.5,
    );
    expect(box.y).toBeGreaterThanOrEqual(region.y - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(
      region.y + region.height + 0.5,
    );
  }
  expect(apart((await tools.boundingBox())!, (await zoom.boundingBox())!)).toBe(
    true,
  );
}

const composerFooter = (page: Page) =>
  page.locator('[data-design-mode="true"] .composer-footer-row').first();

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
    designCanvas(page).getByText(
      "Ask Aiden to design something, or add a note.",
    ),
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
  await expectCanvasChrome(page);
  await expectComposerFooterClear(composerFooter(page));
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
  // The composer footer fits the narrow column without drawing one control over another.
  await expectComposerFooterClear(composerFooter(page));
  // A truncated title still shows all of itself on hover.
  await expect(
    page.locator("[data-chat-title-menu] [title]").first(),
  ).toHaveAttribute("title", DESIGN_CHAT);
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
  // The 320 px canvas keeps its tool rail and zoom controls.
  await expectCanvasChrome(page);
  await expectComposerFooterClear(composerFooter(page));
  await capture(page, "1000-split-sidebar-open");
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Show sidebar" }),
  ).toBeVisible();
  await expect(designLayout(page)).toHaveAttribute(
    "data-design-layout",
    "split",
  );
  await expectCanvasChrome(page);
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
  await expectComposerFooterClear(composerFooter(page));
  await capture(page, "640-stacked-chat");

  await paneSwitch(page).getByRole("radio", { name: "Canvas" }).click();
  await expect(designCanvas(page)).toBeVisible();
  await expect(
    designCanvas(page).getByText(
      "Ask Aiden to design something, or add a note.",
    ),
  ).toBeVisible();
  await expect(page.locator("textarea").first()).toBeHidden();
  await expectCanvasChrome(page);
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
  // The banner is part of the top bar: below the header, clear of the Chat | Canvas
  // switch, and the conversation starts below it instead of underneath it.
  const bannerBox = (await page.locator("[data-design-banner]").boundingBox())!;
  const headerBox = (await page
    .locator('[data-design-mode="true"] .scroll-area-header')
    .first()
    .boundingBox())!;
  expect(bannerBox.y).toBeGreaterThanOrEqual(
    headerBox.y + headerBox.height - 0.5,
  );
  expect(apart(bannerBox, (await paneSwitch(page).boundingBox())!)).toBe(true);
  const firstMessage = page
    .locator('[data-design-mode="true"] [data-scroll-content]')
    .getByText(DESIGN_CHAT)
    .first();
  await expect(firstMessage).toBeVisible();
  expect((await firstMessage.boundingBox())!.y).toBeGreaterThanOrEqual(
    bannerBox.y + bannerBox.height - 0.5,
  );
  await capture(page, "640-banner");
  // The canvas pane starts below the banner too.
  await paneSwitch(page).getByRole("radio", { name: "Canvas" }).click();
  await expect(designCanvas(page)).toBeVisible();
  await expect(banner(page)).toBeVisible();
  expect((await canvasRegion(page).boundingBox())!.y).toBeGreaterThanOrEqual(
    bannerBox.y + bannerBox.height - 0.5,
  );
  await expectCanvasChrome(page);
  await paneSwitch(page).getByRole("radio", { name: "Chat" }).click();
  await expect(page.locator("textarea").first()).toBeVisible();

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

  // Outside design mode a narrow window's composer degrades the same way.
  await setWindowWidth(app, page, 420);
  await expectComposerFooterClear(page.locator(".composer-footer-row").first(), {
    designMode: false,
  });
});

test("Aiden asks to open design mode on a card, then puts its work on the canvas; Not now leaves the chat as it was", async ({
  aiden,
}) => {
  const { app, page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, DESIGN_CHAT);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);
  const card = page.getByRole("group", { name: "Aiden asks to open design mode" });
  const composer = page.locator("textarea").first();

  // Not now: the reply carries on in the chat and design mode stays off.
  const declinePrompt = "Design consent test: sketch a pricing page, but I'll say not now.";
  const declined = lmStudio.enqueueToolScenario!({
    prompt: declinePrompt,
    calls: [{ name: "design_mode", arguments: { action: "enter", reason: "Pricing pages are easier to judge side by side." } }],
    finalText: "No problem, here is the outline in the chat instead.",
  });
  await composer.fill(declinePrompt);
  await composer.press("Enter");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Pricing pages are easier to judge side by side.");
  await capture(page, "1440-design-consent-card");
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toBeHidden();
  await expect.poll(() => declined.completed).toBe(true);
  expect(declined.error).toBeUndefined();
  expect(JSON.stringify(declined.results)).toContain("declined");
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(designCanvas(page)).toHaveCount(0);

  // Enter: the canvas opens, and the same reply places a note there with the canvas tools.
  const enterPrompt = "Design consent test: lay out three pricing directions.";
  const entered = lmStudio.enqueueToolScenario!({
    prompt: enterPrompt,
    calls: [
      { name: "design_mode", arguments: { action: "enter", reason: "Comparing three directions is easier side by side." } },
      { name: "canvas_place_frame", arguments: { kind: "note", title: "Pricing directions", text: "Calm, bold and editorial" } },
      { name: "canvas_focus", arguments: {} },
    ],
    finalText: "The canvas is open with a note for the three directions.",
  });
  await composer.fill(enterPrompt);
  await composer.press("Enter");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Enter design mode" }).click();
  await expect(card).toBeHidden();
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "split");
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => entered.completed).toBe(true);
  expect(entered.error).toBeUndefined();
  expect(entered.issuedToolNames).toEqual(["design_mode", "canvas_place_frame", "canvas_focus"]);
  expect(JSON.stringify(entered.results)).toContain("entered");
  expect(JSON.stringify(entered.results)).toContain("placed");
  const note = designCanvas(page).getByRole("group", { name: "Pricing directions" });
  await expect(note).toBeVisible();
  // canvas_focus brings the new note into view, with room around it.
  await expect
    .poll(async () => {
      const [frame, region] = await Promise.all([note.boundingBox(), canvasRegion(page).boundingBox()]);
      if (!frame || !region) return false;
      return frame.x >= region.x + 40 && frame.x + frame.width <= region.x + region.width - 40;
    })
    .toBe(true);
  await waitForToastsToClear(page);
  await capture(page, "1440-design-entered-from-card");
});
