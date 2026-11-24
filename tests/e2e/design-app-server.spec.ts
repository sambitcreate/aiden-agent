// Design mode's live app (2b) end to end: turning design mode on asks on the
// run-app card, Allow starts the workspace's dev server on 127.0.0.1, and the
// server stops once no canvas for the workspace is on screen. The workspace is
// a copy of tests/fixtures/design-app-server with an empty node_modules (so
// nothing installs) and `dev: node server.mjs`, run by the real npm.

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { DesignAppsSnapshot, DesignAppStatus } from "../../renderer/shared/design-app";
import {
  chooseWorkspace,
  designCanvas,
  designLayout,
  previewAppearance,
  sendFirstMessage,
  setDisplayWidth,
  setWindowWidth,
  typeSlashCommand,
  WORKSPACE_NAME,
} from "./design-mode-helpers";
import { expect, finishLmStudioOnboarding, test, waitForToastsToClear } from "./fixtures";

const FIXTURES = fileURLToPath(new URL("../fixtures/design-app-server/", import.meta.url));
const DESIGN_CHAT = "Design the landing page";
const SECOND_CHAT = "Another look at the landing page";

type Ipc = { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } };

async function seedApp(workspaceDir: string): Promise<void> {
  await mkdir(path.join(workspaceDir, "node_modules"), { recursive: true });
  await copyFile(path.join(FIXTURES, "server.mjs"), path.join(workspaceDir, "server.mjs"));
  await writeFile(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify({ name: "landing", private: true, devDependencies: { vite: "*" }, scripts: { dev: "node server.mjs" } }, null, 2)}\n`,
  );
}

async function chatIdFor(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(async (wanted) => {
    const chats = await (window as unknown as Ipc).aidenAPI.ipc.invoke<Array<{ id: string; title?: string }>>("chats:list");
    return chats.find((chat) => chat.title === wanted)?.id ?? null;
  }, title);
  expect(id, `the chat titled ${title}`).not.toBeNull();
  return id!;
}

/** The workspace root app's status, read through the page's own bridge as the canvas would. */
async function rootApp(page: Page, chatId: string): Promise<DesignAppStatus | undefined> {
  const snapshot = await page.evaluate(
    (id) => (window as unknown as Ipc).aidenAPI.ipc.invoke<DesignAppsSnapshot>("designApp:status:get", id),
    chatId,
  );
  return snapshot.apps.find((app) => app.appRoot === ".");
}

const runCard = (page: Page) => page.getByRole("group", { name: /^Run .* app\?$/u });

async function openDesignChat(aiden: { app: import("@playwright/test").ElectronApplication; page: Page; workspaceDir: string }) {
  const { app, page, workspaceDir } = aiden;
  await seedApp(workspaceDir);
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, DESIGN_CHAT);
  const chatId = await chatIdFor(page, DESIGN_CHAT);
  await typeSlashCommand(page, "/design");
  await expect(designCanvas(page)).toBeVisible();
  return chatId;
}

/** Allow on the card, then wait until the app runs; returns its origin. */
async function allowAndRun(page: Page, chatId: string): Promise<string> {
  await runCard(page).getByRole("button", { name: "Allow" }).click();
  await expect(runCard(page)).toHaveCount(0);
  await expect
    .poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 60_000 })
    .toBe("running");
  const origin = (await rootApp(page, chatId))?.origin ?? "";
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  return origin;
}

async function answers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(2_000) });
    await response.text();
    return response.ok;
  } catch {
    return false;
  }
}

test.describe("with a 2 s presence grace", () => {
  test.use({
    workspaceSeed: true,
    appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1", AIDEN_E2E_DESIGN_APP_GRACE_MS: "2000" },
  });

  test("turning design mode on shows the run-app card with the script text; Not now starts nothing", async ({ aiden }, testInfo) => {
    const { page } = aiden;
    const chatId = await openDesignChat(aiden);
    const card = runCard(page);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("node server.mjs");
    await expect(card).toContainText("This approves the commands above.");
    await expect(card.getByRole("button", { name: "Not now" })).toBeFocused();

    await page.mouse.move(1, 1);
    for (const scheme of ["light", "dark"] as const) {
      await previewAppearance(page, scheme);
      await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", scheme);
      await page.screenshot({ path: testInfo.outputPath(`1440-design-app-consent-${scheme}.png`), animations: "disabled" });
    }
    await previewAppearance(page, null);

    await card.getByRole("button", { name: "Not now" }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await rootApp(page, chatId))?.problem?.problem).toBe("consent-declined");
    expect((await rootApp(page, chatId))?.phase).toBe("stopped");
  });

  test("Allow starts the app and it reaches running at http://127.0.0.1:<port>; leaving design mode stops it after the grace period", async ({ aiden }) => {
    const { page } = aiden;
    const chatId = await openDesignChat(aiden);
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    const origin = await allowAndRun(page, chatId);
    expect(await answers(origin)).toBe(true);

    await typeSlashCommand(page, "/design off");
    await expect(designCanvas(page)).toHaveCount(0);
    await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 20_000 }).toBe("stopped");
    await expect.poll(() => answers(origin), { timeout: 10_000 }).toBe(false);
  });

  test("showing the Chat pane in the stacked layout stops the server after the grace period", async ({ aiden }) => {
    const { app, page } = aiden;
    const chatId = await openDesignChat(aiden);
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    const origin = await allowAndRun(page, chatId);

    // Below 680 px the panes stack, and the Chat pane shows: no canvas for the workspace is on screen.
    await setWindowWidth(app, page, 640);
    await expect(designLayout(page)).toHaveAttribute("data-design-layout", "stacked");
    await expect(page.getByRole("radiogroup", { name: "Design mode view" }).getByRole("radio", { name: "Chat" })).toBeChecked();
    await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 20_000 }).toBe("stopped");
    await expect.poll(() => answers(origin), { timeout: 10_000 }).toBe(false);
  });
});

test.describe("with a 15 s presence grace", () => {
  test.use({
    workspaceSeed: true,
    appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1", AIDEN_E2E_DESIGN_APP_GRACE_MS: "15000" },
  });

  test("a second chat in the same workspace turning design mode on doesn't start a second server or ask again", async ({ aiden }) => {
    const { page } = aiden;
    const chatId = await openDesignChat(aiden);
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    const origin = await allowAndRun(page, chatId);
    const first = await rootApp(page, chatId);

    await page.getByRole("button", { name: "New Agent", exact: true }).click();
    await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
    await sendFirstMessage(page, SECOND_CHAT);
    const secondId = await chatIdFor(page, SECOND_CHAT);
    await typeSlashCommand(page, "/design");
    await expect(designCanvas(page)).toBeVisible();

    // No card, and the same server: one app at the same address, started once.
    await page.waitForTimeout(3_000);
    await expect(runCard(page)).toHaveCount(0);
    const snapshot = await page.evaluate(
      (id) => (window as unknown as Ipc).aidenAPI.ipc.invoke<DesignAppsSnapshot>("designApp:status:get", id),
      secondId,
    );
    const running = snapshot.apps.filter((app) => app.phase === "running");
    expect(running).toHaveLength(1);
    expect(running[0]!.origin).toBe(origin);
    expect(running[0]!.revision).toBe(first!.revision);
    expect(await answers(origin)).toBe(true);
  });
});
