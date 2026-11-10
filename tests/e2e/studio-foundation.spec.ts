import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const STUDIO_FLAGS = {
  // Design Studio was removed; its old flag must change nothing.
  AIDEN_EXPERIMENTAL_DESIGN_STUDIO: "1",
  AIDEN_EXPERIMENTAL_CREATE_IMAGES: "1",
};
// Lazy studio chunks the Vite build emits for the Images route and the shared canvas.
const STUDIO_CHUNK = /\/assets\/(images-route|canvas)-[\w-]+\.(js|css)(\?|$)/u;

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
  // Design mode is on by default, so its kill switch turns it off here.
  test.use({ workspaceSeed: true, appEnvironment: { AIDEN_DESIGN_MODE: "0" } });

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

  test("Images opens beside the sidebar, and Design Studio is gone", async ({ aiden }) => {
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
    // Icon-only helpers (the New chat in… chevron) have no text, so each row is named by its aria-label or text.
    const readRowNames = () =>
      nav.getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim()),
      );
    await expect
      .poll(async () => (await readRowNames()).slice(0, 3))
      .toEqual(["New Agent", "New chat in…", "Scheduled"]);
    await expect.poll(async () => (await readRowNames()).slice(-1)).toEqual(["Images"]);
    await expect(nav.getByRole("button", { name: "Design", exact: true })).toHaveCount(0);
    const imagesRow = nav.getByRole("button", { name: "Images", exact: true });
    const workspaces = page.getByText("Workspaces", { exact: true }).first();
    const [navBox, imagesBox, workspacesBox] = await Promise.all([
      nav.boundingBox(),
      imagesRow.boundingBox(),
      workspaces.boundingBox(),
    ]);
    expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(workspacesBox!.y);
    expect(imagesBox!.y).toBeLessThan(workspacesBox!.y);

    await imagesRow.click();
    await expect(page.getByText("No image workflows yet")).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/images");
    await expect(imagesRow).toHaveAttribute("aria-current", "page");
    await expect(nav).toBeVisible(); // the sidebar stays
    await expect(tools).toBeHidden(); // the Environment workbench is suppressed, not closed
    expect(await studioChunkCount(page)).toBeGreaterThan(0); // the chunk check can see studio loads

    // Back in a chat, the Environment workbench returns exactly as it was.
    await nav.getByRole("button", { name: "New Agent", exact: true }).click();
    await expect(tools).toBeVisible();

    // The palette opens Images and offers no Design Studio command.
    const paletteSearch = await openCommandPalette(page);
    await paletteSearch.fill("Open Design Studio");
    await expect(page.getByRole("option", { name: /Open Design Studio/u })).toHaveCount(0);
    await paletteSearch.fill("Open Create Images");
    await page.getByRole("option", { name: /Open Create Images/u }).click();
    await expect(page.getByRole("button", { name: "New from Starter" }).first()).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/images");

    // The detail route keeps its sidebar row selected.
    await navigateTo(page, "/images/workflow-1");
    await expect(page.getByText("This workflow could not be opened", { exact: true })).toBeVisible();
    await expect.poll(() => currentPath(page)).toBe("/images/workflow-1");
    await expect(imagesRow).toHaveAttribute("aria-current", "page");

    // A stale Design Studio link, with or without a project id, lands on the home chat.
    for (const stale of ["/design", "/design/project-1"]) {
      await navigateTo(page, "/scheduled");
      await expect.poll(() => currentPath(page)).toBe("/scheduled");
      await navigateTo(page, stale);
      await expectHomeChat(page);
    }

    // Relaunching without the flags removes every trace.
    page = await aiden.relaunch(undefined, {});
    await expectHomeChat(page);
    const relaunchedNav = page.getByRole("navigation", { name: "Primary" });
    await expect(relaunchedNav.getByRole("button", { name: "Scheduled", exact: true })).toBeVisible();
    await expect(relaunchedNav.getByRole("button", { name: "Images", exact: true })).toHaveCount(0);
    const relaunchedSearch = await openCommandPalette(page);
    await relaunchedSearch.fill("Open Create Images");
    await expect(page.getByRole("option", { name: /Open Create Images/u })).toHaveCount(0);
    await closeCommandPalette(page);
  });
});
