// Live app frame viewports and page actions end to end (design mode v2
// Phase 3c, Task 10). The workspace is a copy of tests/fixtures/design-live-routes:
// its Pricing page reports `data-cols` and `data-width` from the window, by
// the same width breakpoints as its stylesheet, so a frame's viewport is
// observable inside the running page.
//
// The saved canvas is the oracle for frames and their sizes; the workspace
// folder is the oracle for the page files ⌘D writes and the Trash takes.

import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { frameGroup, inside, LIVE_ON, openLiveChat, savedCanvas, seedFixture, shoot, type SavedFrame } from "./design-live-helpers";
import { chooseWorkspace, designCanvas, sendFirstMessage, setDisplayWidth, setWindowWidth, typeSlashCommand, WORKSPACE_NAME } from "./design-mode-helpers";
import { expect, finishLmStudioOnboarding, test, waitForToastsToClear } from "./fixtures";

const ROUTES_FIXTURE = fileURLToPath(new URL("../fixtures/design-live-routes/", import.meta.url));
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const ABOUT = 'export default function About() {\n  return (\n    <main>\n      <h1>About</h1>\n    </main>\n  );\n}\n';

const live = test.extend({
  appArgs: async ({ workspaceSeed: _seed }, use) => {
    // gVisor (the Cua Space) kills Chromium's seccomp-filtered renderer as soon
    // as a Vite + React page runs (3a's environment note). Test-only.
    await use(process.platform === "linux" ? ["--disable-seccomp-filter-sandbox"] : []);
  },
});

const picker = (page: Page) => page.getByRole("dialog", { name: "Add a page from your app" });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const insideNode = (page: Page, id: string) => node(page, id).frameLocator("iframe[data-app-frame-id]");
const layout = (page: Page, title: string) => inside(page, title).locator("#layout");

/** Adds the route the filter narrows to through Add ▸ Page from app…, as the person would. */
async function addRoute(page: Page, filterText: string): Promise<void> {
  await designCanvas(page).getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Page from app/u }).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByRole("combobox", { name: "Filter routes" }).fill(filterText);
  await picker(page).getByRole("combobox", { name: "Filter routes" }).press("Enter");
  await expect(picker(page)).toBeHidden();
}

async function appFrames(userDataDir: string, route: string): Promise<SavedFrame[]> {
  const doc = await savedCanvas(userDataDir);
  return (doc?.frames ?? []).filter((frame) => frame.kind === "app" && frame.route === route);
}

async function onlyFrame(userDataDir: string, route: string): Promise<SavedFrame & { scale?: number }> {
  await expect.poll(async () => (await appFrames(userDataDir, route)).length).toBe(1);
  return (await appFrames(userDataDir, route))[0]!;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Presses on the middle of `control`, moves by (dx, dy) screen px in steps, then calls `during` before letting go. */
async function drag(page: Page, control: Locator, dx: number, dy: number, during?: () => Promise<void>): Promise<void> {
  const box = (await control.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  if (during) await during();
  await page.mouse.up();
}

async function undo(page: Page): Promise<void> {
  await page.locator(".studio-canvas").focus();
  await page.keyboard.press(`${MOD}+z`);
}

live.describe("with live apps on", () => {
  live.use({ workspaceSeed: true, appEnvironment: LIVE_ON });

  live("edges change the viewport, corners scale, and the device menu and Add view at width size the page", async ({ aiden }, testInfo) => {
    const { page, workspaceDir, userDataDir } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    await openLiveChat(aiden);
    await addRoute(page, "pri");
    await expect(layout(page, "/pricing")).toHaveAttribute("data-cols", "3", { timeout: 30_000 });
    const pricing = await onlyFrame(userDataDir, "/pricing");
    expect(pricing.viewport).toEqual({ width: 1280, height: 800 });
    const scale = pricing.scale;
    await waitForToastsToClear(page);

    // A. Dragging the right edge to about 1000 reflows the page below its 1024 breakpoint, keeps the scale, and draws the ticks.
    await frameGroup(page, "/pricing").click();
    const frameBox = (await node(page, pricing.id).boundingBox())!;
    const perViewportPx = frameBox.width / 1280;
    await drag(page, node(page, pricing.id).locator(".react-flow__resize-control.line.right"), -280 * perViewportPx, 0, async () => {
      await expect(page.locator(".design-viewport-readout")).toHaveText(/^\d{3,4} × 800$/u);
      const ticks = page.locator(".design-viewport-tick");
      await expect(ticks).toHaveCount(3);
      expect(await ticks.evaluateAll((all) => all.map((tick) => tick.getAttribute("data-breakpoint")))).toEqual(["640", "768", "1024"]);
      await shoot(page, testInfo, "design-live-edge-drag");
    });
    await expect(page.locator(".design-viewport-ruler")).toHaveCount(0);
    // The canvas saves after a short debounce.
    await expect.poll(async () => (await onlyFrame(userDataDir, "/pricing")).viewport?.width).not.toBe(1280);
    const dragged = await onlyFrame(userDataDir, "/pricing");
    expect(dragged.viewport!.width).toBeGreaterThan(985);
    expect(dragged.viewport!.width).toBeLessThan(1015);
    expect(dragged.viewport!.height).toBe(800);
    expect(dragged.scale).toBe(scale);
    await expect(layout(page, "/pricing")).toHaveAttribute("data-width", String(dragged.viewport!.width));
    await expect(layout(page, "/pricing")).toHaveAttribute("data-cols", "2");

    // ⌘Z puts 1280 back in one step.
    await undo(page);
    await expect.poll(async () => (await onlyFrame(userDataDir, "/pricing")).viewport).toEqual({ width: 1280, height: 800 });
    await expect(layout(page, "/pricing")).toHaveAttribute("data-cols", "3");

    // B. A corner drag scales the frame and keeps the viewport.
    await frameGroup(page, "/pricing").click();
    await drag(page, node(page, pricing.id).locator(".react-flow__resize-control.handle.bottom.right"), 60, 40);
    await expect.poll(async () => (await onlyFrame(userDataDir, "/pricing")).scale).not.toBe(scale);
    expect((await onlyFrame(userDataDir, "/pricing")).viewport).toEqual({ width: 1280, height: 800 });
    await expect(layout(page, "/pricing")).toHaveAttribute("data-width", "1280");
    await undo(page);
    await expect.poll(async () => (await onlyFrame(userDataDir, "/pricing")).scale).toBe(scale);

    // C. The device menu, by keyboard: iPad, then Custom… 500 × 900, and focus comes back to the button.
    await frameGroup(page, "/pricing").click();
    const device = frameGroup(page, "/pricing").getByRole("button", { name: /^Viewport/u });
    await expect(device).toHaveAccessibleName("Viewport, Laptop, 1280 by 800");
    await device.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: /iPhone/u })).toBeFocused();
    await shoot(page, testInfo, "design-live-device-menu");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await onlyFrame(userDataDir, "/pricing")).viewport).toEqual({ width: 768, height: 1024 });
    await expect(layout(page, "/pricing")).toHaveAttribute("data-width", "768");
    await expect(layout(page, "/pricing")).toHaveAttribute("data-cols", "2");
    await expect(device).toHaveAccessibleName("Viewport, iPad, 768 by 1024");
    await expect(device).toBeFocused();

    // Each key waits for the menu to hold focus, or it lands on the button.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: /iPhone/u })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "Custom…" })).toBeFocused();
    await page.keyboard.press("Enter");
    const custom = page.getByRole("dialog", { name: "Custom viewport" });
    await expect(custom.getByRole("textbox", { name: "Width" })).toBeFocused();
    await custom.getByRole("textbox", { name: "Width" }).fill("500");
    await custom.getByRole("textbox", { name: "Height" }).fill("900");
    await custom.getByRole("textbox", { name: "Height" }).press("Enter");
    await expect(custom).toBeHidden();
    await expect(device).toBeFocused();
    await expect.poll(async () => (await onlyFrame(userDataDir, "/pricing")).viewport).toEqual({ width: 500, height: 900 });
    await expect(layout(page, "/pricing")).toHaveAttribute("data-width", "500");
    await expect(layout(page, "/pricing")).toHaveAttribute("data-cols", "1");

    // D. More ▸ Add view at width ▸ iPhone adds a second frame of the page at 390, in its variant set.
    await waitForToastsToClear(page);
    await frameGroup(page, "/pricing").getByRole("button", { name: "More actions for /pricing" }).click();
    const sub = page.getByRole("menuitem", { name: "Add view at width" });
    await sub.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: /iPhone/u })).toBeVisible();
    await shoot(page, testInfo, "design-live-more-menu");
    await page.getByRole("menuitem", { name: /iPhone/u }).click();
    await expect.poll(async () => (await appFrames(userDataDir, "/pricing")).length).toBe(2);
    const view = (await appFrames(userDataDir, "/pricing")).find((frame) => frame.id !== pricing.id)!;
    expect(view.viewport).toEqual({ width: 390, height: 844 });
    expect(view.variantOf).toBe(pricing.id);
    expect(view.createdBy).toBe("person");
    await expect(insideNode(page, view.id).locator("#layout")).toHaveAttribute("data-width", "390", { timeout: 30_000 });

    // J. That phone view's header is compact: the device button and More, each inside the frame and reachable by Tab.
    await node(page, view.id).click();
    const header = node(page, view.id).getByRole("button", { name: /^Viewport|^More actions/u });
    await expect(header).toHaveCount(2);
    const viewBox = (await node(page, view.id).boundingBox())!;
    for (const button of await header.all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThanOrEqual(viewBox.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewBox.x + viewBox.width + 1);
    }
    await header.first().focus();
    await page.keyboard.press("Tab");
    await expect(header.last()).toBeFocused();
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-live-narrow-header");
  });

  live("⌘D copies the page file as -v2, ⌘Z takes the copy away and ⇧⌘Z brings it back; a dynamic page refuses with Ask Aiden", async ({ aiden }, testInfo) => {
    const { page, workspaceDir, userDataDir } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    await openLiveChat(aiden);
    await addRoute(page, "pri");
    await expect(inside(page, "/pricing").getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 30_000 });
    const copy = path.join(workspaceDir, "src/routes/pricing-v2.tsx");
    await waitForToastsToClear(page);

    // E. ⌘D with the one frame selected writes the copy, and its frame shows the page once the dev server serves it.
    await frameGroup(page, "/pricing").click();
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByText("Copied the page's file to src/routes/pricing-v2.tsx.")).toBeVisible();
    await expect.poll(() => exists(copy)).toBe(true);
    const variant = await onlyFrame(userDataDir, "/pricing-v2");
    expect(variant.label).toBe("v2");
    await expect(insideNode(page, variant.id).getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 30_000 });
    await shoot(page, testInfo, "design-live-duplicate-variant");

    // ⌘Z takes the frame off and the copy to the Trash; ⇧⌘Z puts both back.
    await undo(page);
    await expect.poll(async () => (await appFrames(userDataDir, "/pricing-v2")).length).toBe(0);
    await expect.poll(() => exists(copy)).toBe(false);
    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect.poll(async () => (await appFrames(userDataDir, "/pricing-v2")).length).toBe(1);
    await expect.poll(() => exists(copy)).toBe(true);
    await waitForToastsToClear(page);

    // G. A page from a dynamic route can't be copied from here: the toast says why and offers Ask Aiden, and nothing is written.
    await addRoute(page, "hello-world");
    await expect(inside(page, "/blog/hello-world").getByRole("heading")).toBeVisible({ timeout: 30_000 });
    const before = (await readdir(path.join(workspaceDir, "src/routes"))).sort();
    await frameGroup(page, "/blog/hello-world").click();
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByText("This page comes from a dynamic route, so copying its file would copy every page it serves.")).toBeVisible();
    await shoot(page, testInfo, "design-live-copy-refusal");
    await page.getByRole("button", { name: "Ask Aiden" }).click();
    await expect(page.getByText("Added a note for Aiden on this frame. It goes with your next message.")).toBeVisible();
    expect((await readdir(path.join(workspaceDir, "src/routes"))).sort()).toEqual(before);
    expect(await appFrames(userDataDir, "/blog/hello-world")).toHaveLength(1);

    // I. The shortcut sheet lists ⌘D for a live page.
    await page.keyboard.press(`${MOD}+/`);
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet.getByRole("searchbox", { name: "Search keyboard shortcuts" })).toBeFocused();
    await page.keyboard.type("live page");
    await expect(sheet.getByRole("listitem")).toHaveText([/Duplicate a live page as a variant/u]);
    await shoot(page, testInfo, "design-live-shortcut-row");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  live("F: Move page file to Trash asks first, removes the page, and Undo puts the frame and the file back", async ({ aiden }, testInfo) => {
    const { page, workspaceDir, userDataDir } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    // Its own page, so the other specs' route lists stay as they are.
    const about = path.join(workspaceDir, "src/routes/about.tsx");
    await writeFile(about, ABOUT);
    await openLiveChat(aiden);
    await addRoute(page, "about");
    await expect(inside(page, "/about").getByRole("heading", { name: "About" })).toBeVisible({ timeout: 30_000 });
    const frame = await onlyFrame(userDataDir, "/about");
    await waitForToastsToClear(page);

    await frameGroup(page, "/about").click();
    await frameGroup(page, "/about").getByRole("button", { name: "More actions for /about" }).click();
    await page.getByRole("menuitem", { name: "Move page file to Trash…" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Move page file to Trash" });
    await expect(confirm).toContainText("The file that serves /about goes to the Trash");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await shoot(page, testInfo, "design-live-trash-confirm");
    await confirm.getByRole("button", { name: "Move to Trash" }).click();

    await expect.poll(() => exists(about)).toBe(false);
    await expect.poll(async () => (await appFrames(userDataDir, "/about")).length).toBe(0);
    await expect(page.locator(".studio-canvas")).toBeFocused();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Moved src/routes/about.tsx to the Trash." });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await appFrames(userDataDir, "/about")).map((entry) => entry.id)).toEqual([frame.id]);
    await expect.poll(() => exists(about)).toBe(true);
    await expect(inside(page, "/about").getByRole("heading", { name: "About" })).toBeVisible({ timeout: 30_000 });
  });
});

// H. With live apps off, ⌘D is today's duplicate and no page actions show.
live.describe("with live apps off", () => {
  live.use({ workspaceSeed: true, appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "0" } });

  live("H: ⌘D duplicates the selection, and neither the page actions nor their shortcut row show", async ({ aiden }) => {
    const { app, page, workspaceDir, userDataDir } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    await finishLmStudioOnboarding(page);
    await waitForToastsToClear(page);
    await setDisplayWidth(app, 1440);
    await setWindowWidth(app, page, 1440);
    await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
    await sendFirstMessage(page, "Design the pricing app");
    await typeSlashCommand(page, "/design");
    await expect(designCanvas(page)).toBeVisible();

    const notes = async () => ((await savedCanvas(userDataDir))?.frames ?? []).filter((frame) => frame.kind === "note").length;
    await designCanvas(page).getByRole("button", { name: "Note", exact: true }).click();
    await expect.poll(notes).toBe(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${MOD}+d`);
    await expect.poll(notes).toBe(2);
    await expect(page.getByRole("button", { name: /^More actions for/u })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Viewport/u })).toHaveCount(0);

    await page.keyboard.press(`${MOD}+/`);
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet.getByRole("searchbox", { name: "Search keyboard shortcuts" })).toBeFocused();
    await page.keyboard.type("live page");
    await expect(sheet.getByRole("listitem").filter({ hasText: "Duplicate a live page as a variant" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});
