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

test.use({ workspaceSeed: true, appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_MODE: "1" } });

async function setWindowWidth(app: ElectronApplication, page: Page, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, nextWidth) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ ...window.getBounds(), x: 0, y: 0, width: nextWidth, height: 900 });
  }, width);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

/** Pretends the window's display has a work area this wide, as a laptop or a large monitor would. */
async function setDisplayWidth(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ screen }, workAreaWidth) => {
    const workArea = { x: 0, y: 0, width: workAreaWidth, height: 900 };
    screen.getDisplayMatching = () => ({ ...screen.getPrimaryDisplay(), workArea, bounds: workArea });
  }, width);
}

type AppearanceIpc = { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } };

/** Previews an appearance the way Settings does, without saving it. */
async function previewAppearance(page: Page, mode: "light" | "dark" | null): Promise<void> {
  await page.evaluate(async (nextMode) => {
    const { ipc } = (window as unknown as AppearanceIpc).aidenAPI;
    const saved = await ipc.invoke<{ mode: string }>("settings:getAppearance");
    await ipc.invoke("settings:previewAppearance", nextMode ? { ...saved, mode: nextMode } : saved);
  }, mode);
}

async function capture(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.mouse.move(1, 1);
  for (const scheme of ["light", "dark"] as const) {
    await previewAppearance(page, scheme);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", scheme);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-${scheme}.png`), animations: "disabled" });
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
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });
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
const sidebarChat = (page: Page, title: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${title}`, "u") }).first();
const designToggle = (page: Page) => page.getByRole("button", { name: "Design mode", exact: true });

test("design mode puts the chat beside a canvas, stays with its chat and gives the panel back on exit", async ({
  aiden,
}) => {
  const { app } = aiden;
  let page = aiden.page;
  await openTwoChats(page);
  await setWindowWidth(app, page, 1440);

  // Before entry: the Files tab is open in the Environment panel.
  const panel = page.getByRole("complementary", { name: "Environment work surface" });
  await page.locator("[data-environment-toggle]").click();
  await panel.getByRole("button", { name: "Files", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "false");
  await capture(page, "1440-design-off");

  await typeSlashCommand(page, "/design");
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "true");
  const canvas = page.getByRole("region", { name: "Design", exact: true });
  await expect(canvas).toHaveAttribute("data-design-canvas-region", "inline");
  await expect(canvas.getByText("Nothing on the canvas yet")).toBeVisible();
  await expect(panel).toBeHidden();

  // The chat is a 420 px column and the canvas takes the rest of the window, once the
  // Environment panel's space has finished closing.
  const rightEdge = async (locator: ReturnType<Page["locator"]>) => {
    const box = await locator.boundingBox();
    return box ? Math.round(box.x + box.width) : 0;
  };
  await expect.poll(() => rightEdge(canvas)).toBe(1440);
  const column = await page.locator('[data-design-mode="true"]').boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(column && canvasBox).toBeTruthy();
  expect(Math.abs(column!.width - 420)).toBeLessThanOrEqual(2);
  expect(Math.abs(canvasBox!.x - (column!.x + column!.width))).toBeLessThanOrEqual(1);
  expect(canvasBox!.width).toBeGreaterThanOrEqual(480);

  // The sidebar shows only this project's chats, under ‹ All projects.
  const scope = sidebar(page).locator("[data-sidebar-scope-list]");
  await expect(scope.getByRole("button", { name: "All projects" })).toBeVisible();
  await expect(scope.getByRole("heading", { name: WORKSPACE_NAME })).toBeVisible();
  await expect(sidebarChat(page, DESIGN_CHAT)).toBeVisible();
  await expect(sidebarChat(page, NOTES_CHAT)).toHaveCount(0);
  await capture(page, "1440-design-on");

  // Escape belongs to whatever has focus; it never leaves design mode.
  await page.locator("textarea").first().focus();
  await page.keyboard.press("Escape");
  await canvas.click({ position: { x: 40, y: 200 } });
  await page.keyboard.press("Escape");
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");

  // A reload keeps design mode on for this chat.
  await page.reload();
  page = aiden.page;
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");
  await expect(page.getByRole("region", { name: "Design", exact: true })).toBeVisible();
  await expect(sidebar(page).locator("[data-sidebar-scope-list]")).toBeVisible();

  // Enter on ‹ All projects shows every project again, still in design mode.
  const allProjects = sidebar(page).getByRole("button", { name: "All projects" });
  await allProjects.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar(page).locator("[data-sidebar-scope-list]")).toHaveCount(0);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");

  // Another chat has its own, normal layout; coming back brings design mode back.
  await sidebarChat(page, NOTES_CHAT).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(new RegExp(`^${NOTES_CHAT}`, "u"));
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(page.getByRole("region", { name: "Design", exact: true })).toHaveCount(0);
  await expect(designToggle(page)).toHaveAttribute("aria-pressed", "false");
  await sidebarChat(page, DESIGN_CHAT).click();
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");
  // The person chose All projects for this chat, which holds for the window session.
  await expect(sidebar(page).locator("[data-sidebar-scope-list]")).toHaveCount(0);

  // The shortcut leaves design mode and gives back the Files tab and the full sidebar.
  await page.locator("textarea").first().focus();
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(sidebarChat(page, NOTES_CHAT)).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();

  // The top-bar button turns it back on, scoped to the project again.
  await designToggle(page).click();
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");
  await expect(sidebar(page).locator("[data-sidebar-scope-list]")).toBeVisible();
  await designToggle(page).focus();
  await capture(page, "1440-design-toggle-focused");
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");

  // The slash palette offers /design here.
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.pressSequentially("/des");
  await expect(page.getByRole("option", { name: /Design mode/u })).toBeVisible();
  await capture(page, "1440-slash-design");
  await composer.fill("");
});

test("design mode makes room in a small window: the sidebar collapses, then the window widens or explains", async ({
  aiden,
}) => {
  const { app, page } = aiden;
  await openTwoChats(page);
  await setWindowWidth(app, page, 1440);
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  await typeSlashCommand(page, "/design");
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");

  // Below 1100 px the sidebar gets out of the way.
  await setWindowWidth(app, page, 1000);
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Design", exact: true })).toHaveAttribute(
    "data-design-canvas-region",
    "inline",
  );
  await capture(page, "1000-design-on");
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar(page).locator("[data-sidebar-scope-list]")).toBeVisible();
  await capture(page, "1000-design-on-scoped-sidebar");
  await page.getByRole("button", { name: "Hide sidebar" }).click();

  // Leaving gives back the sidebar design mode collapsed.
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  await capture(page, "1000-design-off");

  // At 800 px on a wide display, entering widens the window.
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 800);
  await typeSlashCommand(page, "/design");
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width))
    .toBeGreaterThanOrEqual(1024);
  await expect(page.getByText("Design mode needs a wider window")).toHaveCount(0);
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");

  // On a display too narrow to widen, the canvas floats over the chat and a banner explains.
  await setDisplayWidth(app, 800);
  await setWindowWidth(app, page, 800);
  await typeSlashCommand(page, "/design");
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "on");
  await expect(page.getByText("Design mode needs a wider window")).toBeVisible();
  await expect(page.getByRole("button", { name: "Widen window" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Design", exact: true })).toHaveAttribute(
    "data-design-canvas-region",
    "overlay",
  );
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width)).toBe(800);
  await capture(page, "800-design-banner");
  await page.keyboard.press(DESIGN_SHORTCUT);
  await expect(designLayout(page)).toHaveAttribute("data-design-layout", "off");
  await expect(page.getByText("Design mode needs a wider window")).toHaveCount(0);
});
