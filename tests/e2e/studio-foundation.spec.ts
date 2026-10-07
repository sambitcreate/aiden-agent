import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const STUDIO_FLAGS = {
  AIDEN_EXPERIMENTAL_DESIGN_STUDIO: "1",
  AIDEN_EXPERIMENTAL_CREATE_IMAGES: "1",
};
// Lazy studio chunks the Vite build emits for the placeholder routes and the shared canvas.
const STUDIO_CHUNK = /\/assets\/(design-route|images-route|canvas)-[\w-]+\.(js|css)(\?|$)/u;

interface RendererRouter {
  navigate(options: { to: string }): Promise<void>;
  state: { location: { pathname: string } };
}

/**
 * The renderer uses an in-memory router with no URL bar and no navigation hook, so the
 * running router is read from the React context provider and driven like the app does.
 */
async function withRouter<T, A = undefined>(
  page: Page,
  run: (router: RendererRouter, arg: A) => T | Promise<T>,
  arg?: A,
): Promise<T> {
  return page.evaluate(
    async ({ source, arg }) => {
      const container = document.getElementById("root") ?? document.body.firstElementChild;
      const key = container && Object.keys(container).find((name) => name.startsWith("__reactContainer$"));
      if (!container || !key) throw new Error("React root not found.");
      const stack: unknown[] = [(container as unknown as Record<string, unknown>)[key]];
      let router: RendererRouter | undefined;
      while (stack.length > 0 && !router) {
        const fiber = stack.pop() as {
          child?: unknown;
          sibling?: unknown;
          memoizedProps?: { value?: unknown } | null;
        } | null;
        if (!fiber) continue;
        const value = fiber.memoizedProps?.value as Partial<RendererRouter> | undefined;
        if (value && typeof value.navigate === "function" && value.state?.location) {
          router = value as RendererRouter;
        }
        stack.push(fiber.sibling, fiber.child);
      }
      if (!router) throw new Error("Router context not found.");
      return (new Function("router", "arg", `return (${source})(router, arg);`) as (
        router: RendererRouter,
        arg: unknown,
      ) => unknown)(router, arg);
    },
    { source: run.toString(), arg },
  ) as Promise<T>;
}

const pathExists = (target: string) =>
  fs.access(target).then(
    () => true,
    () => false,
  );

const currentPath = (page: Page) => withRouter(page, (router) => router.state.location.pathname);
const navigateTo = (page: Page, to: string) =>
  withRouter(page, (router, target: string) => router.navigate({ to: target }), to);

/**
 * Lazy chunks the document has requested. The app loads from file://, where
 * performance.getEntriesByType("resource") stays empty, but Vite's loader leaves a
 * modulepreload link or script element in the DOM for every chunk it fetches.
 */
function studioChunkCount(page: Page): Promise<number> {
  return page.evaluate(
    (pattern) =>
      [...document.querySelectorAll<HTMLElement>("script[src], link[href]")].filter((element) =>
        new RegExp(pattern, "u").test(element.getAttribute("src") ?? element.getAttribute("href") ?? ""),
      ).length,
    STUDIO_CHUNK.source,
  );
}

async function openCommandPalette(page: Page) {
  await page.keyboard.press(`${PRIMARY_MODIFIER}+K`);
  await expect(page.locator("[data-command-palette-content]")).toBeVisible();
  return page.getByRole("combobox", { name: "Search commands" });
}

async function closeCommandPalette(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-command-palette-content]")).toBeHidden();
}

/** The normal chat surface: an editable composer, and no studio canvas. */
async function expectHomeChat(page: Page) {
  await expect(page.locator("textarea").first()).toBeVisible(); // also waits for a relaunched renderer to mount
  await expect.poll(() => currentPath(page)).toMatch(/^\/chat\//u);
  await expect(page.getByRole("region", { name: /(Design|Images) canvas/u })).toHaveCount(0);
}

test.describe("Studio foundation with both flags off", () => {
  test.use({ workspaceSeed: true });

  test("adds no studio rows, commands, chunks or routes", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await expectHomeChat(page);

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("button", { name: "Scheduled", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Design", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Images", exact: true })).toHaveCount(0);

    const search = await openCommandPalette(page);
    await search.fill("Open Design Studio");
    await expect(page.getByRole("option", { name: /Open Design Studio/u })).toHaveCount(0);
    await search.fill("Open Create Images");
    await expect(page.getByRole("option", { name: /Open Create Images/u })).toHaveCount(0);
    await closeCommandPalette(page);

    // The home screen never requested the studio canvas or placeholder route chunks.
    expect(await studioChunkCount(page)).toBe(0);

    // Startup never touched the studio asset store, so userData has no trace of it.
    expect(await pathExists(path.join(aiden.userDataDir, "studio-assets"))).toBe(false);

    // Studio routes redirect to the home chat, whether or not they carry an id.
    for (const path of ["/design", "/design/project-1", "/images", "/images/workflow-1"]) {
      await navigateTo(page, "/scheduled");
      await expect.poll(() => currentPath(page)).toBe("/scheduled");
      await navigateTo(page, path);
      await expectHomeChat(page);
      await expect(nav.getByRole("button", { name: "Scheduled", exact: true })).toBeVisible();
    }
  });
});

test.describe("Studio foundation with both flags on", () => {
  test.use({ workspaceSeed: true, appEnvironment: STUDIO_FLAGS });

  test("Design and Images open empty canvases beside the sidebar", async ({ aiden }) => {
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    await page.mouse.move(1, 1); // keep the onboarding toast from pausing over the toolbar
    await expectHomeChat(page);
    expect(await studioChunkCount(page)).toBe(0); // studio code stays lazy until a route opens

    // Startup opens the asset store, creating its database under userData.
    const assetDatabase = path.join(aiden.userDataDir, "studio-assets", "assets-v1.sqlite");
    await expect.poll(() => pathExists(assetDatabase)).toBe(true);

    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
    await expect(tools).toBeVisible();

    // Primary navigation sits above the workspace outline, in a fixed order.
    const nav = page.getByRole("navigation", { name: "Primary" });
    const readRowNames = async () => (await nav.getByRole("button").allTextContents()).map((name) => name.trim());
    await expect.poll(async () => (await readRowNames()).slice(0, 2)).toEqual(["New Agent", "Scheduled"]);
    await expect.poll(async () => (await readRowNames()).slice(-2)).toEqual(["Design", "Images"]);
    const designRow = nav.getByRole("button", { name: "Design", exact: true });
    const imagesRow = nav.getByRole("button", { name: "Images", exact: true });
    const workspaces = page.getByText("Workspaces", { exact: true }).first();
    const [navBox, imagesBox, workspacesBox] = await Promise.all([
      nav.boundingBox(),
      imagesRow.boundingBox(),
      workspaces.boundingBox(),
    ]);
    expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(workspacesBox!.y);
    expect(imagesBox!.y).toBeLessThan(workspacesBox!.y);

    await designRow.click();
    const canvas = page.getByRole("region", { name: "Design canvas" });
    await expect(canvas).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/design");
    await expect(designRow).toHaveAttribute("aria-current", "page");
    await expect(nav).toBeVisible(); // the sidebar stays
    await expect(tools).toBeHidden(); // the Environment workbench is suppressed, not closed
    await expect(canvas.getByText("No design projects yet")).toBeVisible();
    expect(await studioChunkCount(page)).toBeGreaterThan(0); // the chunk check can see studio loads

    // Keyboard tools and zoom act on the focused canvas only.
    await canvas.focus();
    const rail = canvas.getByRole("toolbar", { name: "Canvas tools" });
    const zoom = canvas.getByRole("toolbar", { name: "Zoom" });
    const select = rail.getByRole("button", { name: "Select" });
    const hand = rail.getByRole("button", { name: "Hand" });
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("h");
    await expect(hand).toHaveAttribute("aria-pressed", "true");
    await expect(select).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("v");
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await expect(hand).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("h");
    await expect(hand).toHaveAttribute("aria-pressed", "true");

    await expect(zoom.getByRole("button", { name: /^Zoom 100%/u })).toBeVisible();
    await page.keyboard.press("=");
    await expect(zoom.getByRole("button", { name: /^Zoom 120%/u })).toBeVisible();
    await page.keyboard.press("-");
    await expect(zoom.getByRole("button", { name: /^Zoom 100%/u })).toBeVisible();
    await page.keyboard.press("=");
    await expect(zoom.getByRole("button", { name: /^Zoom 120%/u })).toBeVisible();
    await page.keyboard.press("Shift+0");
    await expect(zoom.getByRole("button", { name: /^Zoom 100%/u })).toBeVisible();
    await zoom.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoom.getByRole("button", { name: /^Zoom 120%/u })).toBeVisible();

    // M toggles the overview map.
    const minimap = zoom.getByRole("button", { name: "Overview map" });
    await canvas.focus();
    await expect(minimap).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.locator(".react-flow__minimap")).toHaveCount(0);
    await page.keyboard.press("m");
    await expect(minimap).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.locator(".react-flow__minimap")).toBeVisible();
    await page.keyboard.press("m");
    await expect(minimap).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.locator(".react-flow__minimap")).toHaveCount(0);

    // The Hand tool pans the viewport.
    const viewport = canvas.locator(".react-flow__viewport");
    const before = await viewport.evaluate((element) => getComputedStyle(element).transform);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(() => viewport.evaluate((element) => getComputedStyle(element).transform))
      .not.toBe(before);

    // App shortcuts still work while the canvas has focus, and typing in the palette does not trigger canvas keys.
    // Select is active and the overview map is off, so a leaked "h" or "m" would visibly flip one of them.
    await canvas.focus();
    await page.keyboard.press("v");
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await expect(minimap).toHaveAttribute("aria-pressed", "false");
    const search = await openCommandPalette(page);
    await search.fill("hm");
    await expect(search).toHaveValue("hm");
    await closeCommandPalette(page); // the open palette hides the canvas from the accessibility tree
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await expect(hand).toHaveAttribute("aria-pressed", "false");
    await expect(minimap).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.locator(".react-flow__minimap")).toHaveCount(0);

    // Back in a chat, the Environment workbench returns exactly as it was.
    await nav.getByRole("button", { name: "New Agent", exact: true }).click();
    await expect(tools).toBeVisible();
    await expect(page.getByRole("region", { name: "Design canvas" })).toHaveCount(0);

    // The palette opens Design and Images.
    let paletteSearch = await openCommandPalette(page);
    await paletteSearch.fill("Open Design Studio");
    await page.getByRole("option", { name: /Open Design Studio/u }).click();
    await expect(page.getByRole("region", { name: "Design canvas" })).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/design");

    paletteSearch = await openCommandPalette(page);
    await paletteSearch.fill("Open Create Images");
    await page.getByRole("option", { name: /Open Create Images/u }).click();
    await expect(page.getByRole("region", { name: "Images canvas" })).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/images");
    await expect(imagesRow).toHaveAttribute("aria-current", "page");
    await expect(designRow).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByText("No image workflows yet")).toBeVisible();

    // Detail routes mount the same canvases and keep their sidebar row selected.
    await navigateTo(page, "/design/project-1");
    await expect(page.getByRole("region", { name: "Design canvas" })).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/design/project-1");
    await expect(designRow).toHaveAttribute("aria-current", "page");
    await navigateTo(page, "/images/workflow-1");
    await expect(page.getByRole("region", { name: "Images canvas" })).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/images/workflow-1");
    await expect(imagesRow).toHaveAttribute("aria-current", "page");

    // Relaunching without the flags removes every trace.
    page = await aiden.relaunch(undefined, {});
    await expectHomeChat(page);
    const relaunchedNav = page.getByRole("navigation", { name: "Primary" });
    await expect(relaunchedNav.getByRole("button", { name: "Scheduled", exact: true })).toBeVisible();
    await expect(relaunchedNav.getByRole("button", { name: "Design", exact: true })).toHaveCount(0);
    await expect(relaunchedNav.getByRole("button", { name: "Images", exact: true })).toHaveCount(0);
    const relaunchedSearch = await openCommandPalette(page);
    await relaunchedSearch.fill("Open Design Studio");
    await expect(page.getByRole("option", { name: /Open Design Studio/u })).toHaveCount(0);
    await closeCommandPalette(page);
  });
});
