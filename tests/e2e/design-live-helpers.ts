// Shared steps for the live app frame E2E specs (design mode v2 Phase 3a and
// 3b). A helper module, not a spec: importing a spec from another would run
// its tests twice.

import { cp, readdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameLocator, Locator, Page, TestInfo } from "@playwright/test";
import type { DesignAppsSnapshot, DesignAppStatus } from "../../renderer/shared/design-app";
import {
  chooseWorkspace,
  designCanvas,
  previewAppearance,
  sendFirstMessage,
  setDisplayWidth,
  setWindowWidth,
  typeSlashCommand,
  WORKSPACE_NAME,
} from "./design-mode-helpers";
import { expect, finishLmStudioOnboarding, waitForToastsToClear, type AidenE2e } from "./fixtures";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DESIGN_CHAT = "Design the pricing app";

type Ipc = { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } };
export const LIVE_ON = { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1" };

/**
 * Copies a fixture app into the workspace and links the repo's node_modules,
 * which counts as the person's install: design mode finds Vite in
 * devDependencies and starts `npm run dev` without installing.
 */
export async function seedFixture(workspaceDir: string, fixtureDir: string, into = "."): Promise<void> {
  const target = path.join(workspaceDir, into);
  await cp(fixtureDir, target, { recursive: true });
  if (into === ".") await symlink(path.join(REPOSITORY_ROOT, "node_modules"), path.join(workspaceDir, "node_modules"), "dir");
}

export async function chatIdFor(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(async (wanted) => {
    const chats = await (window as unknown as Ipc).aidenAPI.ipc.invoke<Array<{ id: string; title?: string }>>("chats:list");
    return chats.find((chat) => chat.title === wanted)?.id ?? null;
  }, title);
  expect(id, `the chat titled ${title}`).not.toBeNull();
  return id!;
}

export async function rootApp(page: Page, chatId: string): Promise<DesignAppStatus | undefined> {
  const snapshot = await page.evaluate(
    (id) => (window as unknown as Ipc).aidenAPI.ipc.invoke<DesignAppsSnapshot>("designApp:status:get", id),
    chatId,
  );
  return snapshot.apps.find((app) => app.appRoot === ".");
}

export const runCard = (page: Page) => page.getByRole("group", { name: /^Run .* app\?$/u });
export const frameGroup = (page: Page, title: string) => designCanvas(page).getByRole("group", { name: title, exact: true });
export const appIframe = (page: Page, title: string): Locator => frameGroup(page, title).locator("iframe[data-app-frame-id]");
export const inside = (page: Page, title: string): FrameLocator => frameGroup(page, title).frameLocator("iframe[data-app-frame-id]");

/** Sizes the window, then opens a design chat in the fixture workspace and lets design mode start the app. */
export async function openLiveChat(aiden: AidenE2e, title = DESIGN_CHAT): Promise<{ chatId: string; app: DesignAppStatus }> {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);
  return startDesignChat(page, title);
}

/** A new chat in the fixture workspace, in design mode, with its app allowed and running. */
export async function startDesignChat(page: Page, title: string): Promise<{ chatId: string; app: DesignAppStatus }> {
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, title);
  const chatId = await chatIdFor(page, title);
  await typeSlashCommand(page, "/design");
  await expect(designCanvas(page)).toBeVisible();
  // The app may already be running for the workspace (a second chat).
  await expect.poll(async () => (await runCard(page).isVisible()) || (await rootApp(page, chatId))?.phase === "running", { timeout: 30_000 }).toBe(true);
  if (await runCard(page).isVisible()) await runCard(page).getByRole("button", { name: "Allow" }).click();
  await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 90_000 }).toBe("running");
  return { chatId, app: (await rootApp(page, chatId))! };
}

/** Aiden places app frames for these routes, in order. */
export async function placeFrames(aiden: AidenE2e, frames: Array<{ title: string; route: string }>, prompt: string): Promise<void> {
  const composer = aiden.page.locator("textarea").first();
  const scenario = aiden.lmStudio.enqueueToolScenario!({
    prompt,
    // A quarter scale keeps four frames above the live zoom floor (25%) once fitted.
    calls: frames.map((frame) => ({ name: "canvas_place_frame", arguments: { kind: "app", title: frame.title, route: frame.route, scale: 0.25 } })),
    finalText: "The app is on the canvas.",
  });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect.poll(() => scenario.completed, { timeout: 30_000 }).toBe(true);
  expect(scenario.error).toBeUndefined();
  for (const frame of frames) await expect(frameGroup(aiden.page, frame.title)).toBeVisible();
  // Only frames in view go live, so the page is fitted to the window.
  await designCanvas(aiden.page).getByRole("button", { name: "Fit to screen" }).click();
}

/**
 * Presses a control inside a scaled app page from the keyboard: focus moves
 * into the entered frame and Enter activates it, as a person tabbing would.
 * (Pointer clicks into a CSS-scaled iframe land at unscaled coordinates.)
 */
export async function press(control: Locator): Promise<void> {
  await control.focus();
  await control.page().keyboard.press("Enter");
}

/** Light and dark screenshots of the window at 1440 into the test's output folder. */
export async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await previewAppearance(page, scheme);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", scheme);
    await page.screenshot({ path: testInfo.outputPath(`1440-${name}-${scheme}.png`), animations: "disabled" });
  }
  await previewAppearance(page, null);
}

export type SavedFrame = {
  id: string;
  kind: string;
  title: string;
  pageId: string;
  route?: string;
  appRoot?: string;
  createdBy?: string;
  label?: string;
  variantOf?: string;
  groupId?: string;
  viewport?: { width: number; height: number };
};

export type SavedCanvas = {
  frames: SavedFrame[];
  pages: Array<{ id: string; name: string }>;
  chatPages: Record<string, string>;
  removedAppRoutes?: string[];
};

/** The workspace's saved canvas, parsed (one workspace per test). */
export async function savedCanvas(userDataDir: string): Promise<SavedCanvas | undefined> {
  const root = path.join(userDataDir, "design-canvases");
  const names = await readdir(root).catch(() => [] as string[]);
  const name = names.find((entry) => entry.endsWith(".json"));
  if (!name) return undefined;
  try {
    return JSON.parse(await readFile(path.join(root, name), "utf8")) as SavedCanvas;
  } catch {
    // Read mid-write: the next poll sees the whole file.
    return undefined;
  }
}

/** The routes of the app frames on a page, sorted. */
export async function appRoutesOn(userDataDir: string, pageId: string): Promise<string[]> {
  const doc = await savedCanvas(userDataDir);
  return (doc?.frames ?? [])
    .filter((frame) => frame.kind === "app" && frame.pageId === pageId)
    .map((frame) => frame.route ?? "")
    .sort();
}
