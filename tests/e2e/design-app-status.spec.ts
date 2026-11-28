// Design mode's live app status (2c) end to end: the chip and its menu, the
// logs drawer, Retry after a crash, connecting a dev server the person already
// runs (from Connect running server… or a `.aiden/canvas.json` url), and the
// browser panel's Local servers. The workspace is a copy of
// tests/fixtures/design-app-server, as in 2b. Aiden never contacts a server:
// only this test makes HTTP requests, to check what still answers.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";
import type { BrowserState } from "../../renderer/shared/browser";
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
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test, waitForToastsToClear } from "./fixtures";

const FIXTURES = fileURLToPath(new URL("../fixtures/design-app-server/", import.meta.url));
const DESIGN_CHAT = "Design the landing page";

type Ipc = { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } };
type Aiden = { app: import("@playwright/test").ElectronApplication; page: Page; workspaceDir: string };

async function seedApp(workspaceDir: string, dev = "node server.mjs"): Promise<void> {
  await mkdir(path.join(workspaceDir, "node_modules"), { recursive: true });
  await copyFile(path.join(FIXTURES, "server.mjs"), path.join(workspaceDir, "server.mjs"));
  await writeFile(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify({ name: "landing", private: true, devDependencies: { vite: "*" }, scripts: { dev } }, null, 2)}\n`,
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

async function rootApp(page: Page, chatId: string, appRoot = "."): Promise<DesignAppStatus | undefined> {
  const snapshot = await page.evaluate(
    (id) => (window as unknown as Ipc).aidenAPI.ipc.invoke<DesignAppsSnapshot>("designApp:status:get", id),
    chatId,
  );
  return snapshot.apps.find((app) => app.appRoot === appRoot);
}

const runCard = (page: Page) => page.getByRole("group", { name: /^Run .* app\?$/u });
const attachCard = (page: Page) => page.getByRole("group", { name: /^Connect to .* at 127\.0\.0\.1:\d+\?$/u });
const chip = (page: Page) => page.getByRole("button", { name: /^Live app:/u });
const connectSheet = (page: Page) => page.getByRole("dialog", { name: "Connect running server" });

async function openDesignChat(aiden: Aiden) {
  const { app, page } = aiden;
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

async function openMenu(page: Page) {
  await chip(page).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function choose(page: Page, item: string) {
  const menu = await openMenu(page);
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A dev server the person runs: started by this test from the workspace folder, never by Aiden. */
function startOwnServer(workspaceDir: string, args: readonly string[]): ChildProcess {
  return spawn(process.execPath, [path.join(workspaceDir, "server.mjs"), ...args], { cwd: workspaceDir, stdio: "ignore" });
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

async function listening(origin: string): Promise<void> {
  await expect.poll(() => answers(origin), { timeout: 15_000 }).toBe(true);
}

/** Light and dark screenshots of the window at 1440 into the test's output folder. */
async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await previewAppearance(page, scheme);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", scheme);
    await page.screenshot({ path: testInfo.outputPath(`1440-${name}-${scheme}.png`), animations: "disabled" });
  }
  await previewAppearance(page, null);
}

/** Light and dark screenshots of just the chip, for its states. */
async function shootChip(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.mouse.move(1, 1);
  const group = page.getByRole("group", { name: "Live app" });
  for (const scheme of ["light", "dark"] as const) {
    await previewAppearance(page, scheme);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", scheme);
    await group.screenshot({ path: testInfo.outputPath(`${name}-${scheme}.png`), animations: "disabled" });
  }
  await previewAppearance(page, null);
}

/** A monorepo with two Vite apps under apps/, installed at the root. */
async function seedMonorepo(workspaceDir: string): Promise<void> {
  await mkdir(path.join(workspaceDir, "node_modules"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify({ name: "landing-monorepo", private: true, workspaces: ["apps/*"] }, null, 2)}\n`,
  );
  for (const name of ["docs", "web"]) {
    const dir = path.join(workspaceDir, "apps", name);
    await mkdir(dir, { recursive: true });
    await copyFile(path.join(FIXTURES, "server.mjs"), path.join(dir, "server.mjs"));
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name, private: true, devDependencies: { vite: "*" }, scripts: { dev: "node server.mjs" } }, null, 2)}\n`,
    );
  }
}

/** Not now on the card design mode shows when it turns on, so nothing runs. */
async function declineFirstCard(page: Page, chatId: string): Promise<void> {
  await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
  await runCard(page).getByRole("button", { name: "Not now" }).click();
  await expect(runCard(page)).toHaveCount(0);
  await expect.poll(async () => (await rootApp(page, chatId))?.problem?.problem).toBe("consent-declined");
}

test.describe("with a 15 s presence grace", () => {
  test.use({
    workspaceSeed: true,
    appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1", AIDEN_E2E_DESIGN_APP_GRACE_MS: "15000" },
  });

  test("the chip starts the app after the card, shows its port, its logs show the server's URL line, and Stop returns to Start", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seedApp(workspaceDir);
    const chatId = await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Waiting for approval", { timeout: 20_000 });
    await declineFirstCard(page, chatId);
    await expect(chip(page)).toHaveText("Not running");

    await choose(page, "Start");
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    await runCard(page).getByRole("button", { name: "Allow" }).click();
    await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 60_000 }).toBe("running");
    const app = (await rootApp(page, chatId))!;
    await expect(chip(page)).toHaveText(`Vite · :${app.port}`);
    await expect(chip(page)).toHaveAttribute("aria-label", `Live app: Vite, running at port ${app.port}`);

    // The keyboard ring is the shared one.
    await chip(page).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(chip(page)).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-input-modality", "keyboard");
    const outline = await chip(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline).toEqual({ style: "solid", width: "2px" });

    await page.mouse.move(1, 1);
    await shoot(page, testInfo, "design-app-chip-running");
    const menu = await openMenu(page);
    await expect(menu).toContainText(`Running at 127.0.0.1:${app.port}`);
    await shoot(page, testInfo, "design-app-menu");
    await menu.getByRole("menuitem", { name: "Show logs" }).click();

    const output = page.getByRole("log", { name: /^Output of Vite/u });
    await expect(output).toContainText(`Local:   http://127.0.0.1:${app.port}/`, { timeout: 15_000 });
    await expect(output).toBeFocused();
    // The drawer leaves room for the zoom controls at the bottom right (B5): they stay visible and take clicks.
    const zoom = page.getByRole("toolbar", { name: "Zoom" });
    await expect(zoom).toBeVisible();
    await zoom.getByRole("button", { name: "Zoom in" }).click({ trial: true, timeout: 5_000 });
    const [zoomBox, drawerBox] = await Promise.all([zoom.boundingBox(), page.locator(".design-app-logs").boundingBox()]);
    expect(zoomBox && drawerBox && zoomBox.y >= drawerBox.y + drawerBox.height).toBe(true);
    await shoot(page, testInfo, "design-app-logs");
    await page.keyboard.press("Escape");
    await expect(output).toHaveCount(0);
    await expect(chip(page)).toBeFocused();

    await choose(page, "Stop");
    await expect(chip(page)).toHaveText("Start", { timeout: 20_000 });
    await expect.poll(async () => (await rootApp(page, chatId))?.phase).toBe("stopped");
  });

  test("a crashing app shows Crashed, and its menu offers Retry with the fixed message, never the output", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seedApp(workspaceDir, "node server.mjs --fake-crash-after=4000");
    const chatId = await openDesignChat(aiden);
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    await runCard(page).getByRole("button", { name: "Allow" }).click();
    await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 60_000 }).toBe("running");
    await expect(chip(page)).toHaveText("Crashed", { timeout: 30_000 });
    await shootChip(page, testInfo, "design-app-chip-crashed");
    const menu = await openMenu(page);
    await expect(menu.getByRole("menuitem", { name: "Retry" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Restart" })).toBeVisible();
    await expect(menu).toContainText("The app's dev server stopped.");
    await expect(menu).not.toContainText("the fake server broke");
    await menu.getByRole("menuitem", { name: "Retry" }).click();
    await expect(chip(page)).not.toHaveText("Crashed");
  });

  test("Connect running server lists the person's own server, Connect shows it running, and Disconnect leaves it answering", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seedApp(workspaceDir);
    const chatId = await openDesignChat(aiden);
    await declineFirstCard(page, chatId);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const own = startOwnServer(workspaceDir, ["--host", "127.0.0.1", "--port", String(port)]);
    try {
      await listening(origin);
      await choose(page, "Connect running server…");
      const sheet = connectSheet(page);
      await expect(sheet).toBeVisible();
      const connect = sheet.getByRole("button", { name: `Connect to 127.0.0.1:${port}` });
      await expect(connect).toBeEnabled({ timeout: 15_000 });
      await expect(sheet).toContainText("App workspace folder");
      await page.mouse.move(1, 1);
      await shoot(page, testInfo, "design-app-connect");
      await connect.click();
      await expect(sheet).toHaveCount(0);
      await expect(chip(page)).toHaveText(`Vite · :${port}`, { timeout: 20_000 });
      expect((await rootApp(page, chatId))?.source).toBe("attached");
      await shootChip(page, testInfo, "design-app-chip-connected");
      const menu = await openMenu(page);
      await expect(menu).toContainText(`Connected to your server at 127.0.0.1:${port}`);
      await expect(menu.getByRole("menuitem", { name: "Show logs" })).toHaveCount(0);
      await menu.getByRole("menuitem", { name: "Disconnect" }).click();
      await expect(chip(page)).toHaveText("Connect again", { timeout: 20_000 });
      // Disconnecting never stops the person's server.
      expect(await answers(origin)).toBe(true);
      expect(own.exitCode).toBeNull();
    } finally {
      own.kill("SIGKILL");
    }
  });

  test("the Connect list leaves out Aiden's own processes and its running app, and shows a 0.0.0.0 server it can't connect", async ({ aiden }) => {
    const { page, workspaceDir } = aiden;
    await seedApp(workspaceDir);
    const chatId = await openDesignChat(aiden);
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    await runCard(page).getByRole("button", { name: "Allow" }).click();
    await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 60_000 }).toBe("running");
    const started = (await rootApp(page, chatId))!.port!;
    const wildcard = startOwnServer(workspaceDir, ["--fake-wildcard"]);
    try {
      await choose(page, "Connect running server…");
      const sheet = connectSheet(page);
      const rows = sheet.getByRole("list", { name: "Running servers" });
      const blocked = rows.getByRole("button", { name: /^Connect to :\d+$/u });
      await expect(async () => {
        // The list is read when the sheet opens; Refresh reads it again until the wildcard server shows.
        if ((await blocked.count()) === 0) {
          const refresh = sheet.getByRole("button", { name: "Refresh" });
          if (await refresh.isVisible()) await refresh.click();
          else {
            await sheet.getByRole("button", { name: "Close" }).click();
            await choose(page, "Connect running server…");
          }
        }
        await expect(blocked).toHaveCount(1, { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await expect(blocked).toBeDisabled();
      await expect(sheet).toContainText("It listens beyond this computer.");
      // Only the wildcard server is listed: not the app Aiden started, nor Aiden itself.
      await expect(rows.getByRole("listitem")).toHaveCount(1);
      await expect(sheet).not.toContainText(`:${started}`);
    } finally {
      wildcard.kill("SIGKILL");
    }
  });

  test("a workspace with no web app shows a Connect chip whose menu offers Add design app… and Connect running server…", async ({ aiden }, testInfo) => {
    const { page } = aiden;
    await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Connect", { timeout: 20_000 });
    await shootChip(page, testInfo, "design-app-chip-connect-only");
    const menu = await openMenu(page);
    // 3d: an empty workspace may get a design app.
    await expect(menu.getByRole("menuitem")).toHaveText(["Add design app…", "Connect running server…"]);
  });

  test("a server that hasn't listened yet shows Starting…, and Stop from the menu stops it", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seedApp(workspaceDir, "node server.mjs --fake-never-listen");
    const chatId = await openDesignChat(aiden);
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    await runCard(page).getByRole("button", { name: "Allow" }).click();
    await expect(chip(page)).toHaveText("Starting…", { timeout: 30_000 });
    await expect(chip(page)).toHaveAttribute("aria-label", "Live app: Vite, starting");
    await shootChip(page, testInfo, "design-app-chip-starting");
    await choose(page, "Stop");
    await expect(chip(page)).toHaveText("Start", { timeout: 20_000 });
    await expect.poll(async () => (await rootApp(page, chatId))?.phase).toBe("stopped");
  });

  test("in a monorepo, Choose apps… runs each app after its card, and the chip says 2 apps", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seedMonorepo(workspaceDir);
    const chatId = await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Choose apps…", { timeout: 20_000 });
    for (const root of ["apps/docs", "apps/web"]) {
      await choose(page, "Choose apps…");
      const sheet = page.getByRole("dialog", { name: "Choose apps" });
      await expect(sheet).toBeVisible();
      if (root === "apps/docs") await shoot(page, testInfo, "design-app-choose");
      await sheet.getByRole("button", { name: `Run ${root}` }).click();
      await expect(sheet).toHaveCount(0);
      await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
      await runCard(page).getByRole("button", { name: "Allow" }).click();
      await expect.poll(async () => (await rootApp(page, chatId, root))?.phase, { timeout: 60_000 }).toBe("running");
    }
    await expect(chip(page)).toHaveText("2 apps");
    await shootChip(page, testInfo, "design-app-chip-two-apps");
    const menu = await openMenu(page);
    await expect(menu).toContainText("apps/docs");
    await expect(menu).toContainText("apps/web");
  });

  test("the browser panel's Local servers lists the running design app, and opening it loads the page", async ({ aiden }) => {
    const { page, workspaceDir } = aiden;
    await seedApp(workspaceDir);
    const chatId = await openDesignChat(aiden);
    await expect(runCard(page)).toBeVisible({ timeout: 20_000 });
    await runCard(page).getByRole("button", { name: "Allow" }).click();
    await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 60_000 }).toBe("running");
    const origin = (await rootApp(page, chatId))!.origin!;
    const browserServers = () =>
      page.evaluate(
        async (workspaceId) => (await (window as unknown as Ipc).aidenAPI.ipc.invoke<BrowserState>("browser:get-state", workspaceId)).servers,
        E2E_WORKSPACE_ID,
      );
    await expect.poll(async () => (await browserServers()).find((server) => server.url === `${origin}/`)?.label).toBe("Vite · . · design mode");

    await page.getByRole("button", { name: "Show Environment" }).click();
    const surface = page.getByRole("complementary", { name: "Environment work surface" });
    await surface.getByRole("button", { name: "Browser", exact: true }).click();
    const row = surface.getByRole("button", { name: new RegExp(`Vite · \\. · design mode`, "u") });
    await expect(row).toBeVisible();
    await row.click();
    await expect
      .poll(async () => {
        const state = await page.evaluate(
          async (workspaceId) => (window as unknown as Ipc).aidenAPI.ipc.invoke<BrowserState>("browser:get-state", workspaceId),
          E2E_WORKSPACE_ID,
        );
        return state.tabs.some((tab) => tab.url.startsWith(origin));
      })
      .toBe(true);
  });
});

test.describe("with a 2 s presence grace", () => {
  test.use({
    workspaceSeed: true,
    appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1", AIDEN_E2E_DESIGN_APP_GRACE_MS: "2000" },
  });

  test("a canvas.json url root asks with the attach card; Allow connects, and design mode off and on connects again without a card", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seedApp(workspaceDir);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    await mkdir(path.join(workspaceDir, ".aiden"), { recursive: true });
    await writeFile(path.join(workspaceDir, ".aiden", "canvas.json"), `${JSON.stringify({ version: 1, apps: [{ root: ".", url: origin }] }, null, 2)}\n`);
    const own = startOwnServer(workspaceDir, ["--host", "127.0.0.1", "--port", String(port)]);
    try {
      await listening(origin);
      const chatId = await openDesignChat(aiden);
      const card = attachCard(page);
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card).toContainText(".aiden/canvas.json");
      await expect(runCard(page)).toHaveCount(0);
      await page.mouse.move(1, 1);
      await shoot(page, testInfo, "design-app-attach-card");
      await card.getByRole("button", { name: "Allow" }).click();
      await expect(card).toHaveCount(0);
      await expect(chip(page)).toHaveText(`Vite · :${port}`, { timeout: 20_000 });

      await typeSlashCommand(page, "/design off");
      await expect(designCanvas(page)).toHaveCount(0);
      // Past the grace, the attachment ends; the person's server keeps running.
      await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 20_000 }).toBe("stopped");
      expect(await answers(origin)).toBe(true);

      await typeSlashCommand(page, "/design");
      await expect(designCanvas(page)).toBeVisible();
      await expect(chip(page)).toHaveText(`Vite · :${port}`, { timeout: 20_000 });
      await expect(attachCard(page)).toHaveCount(0);
    } finally {
      own.kill("SIGKILL");
    }
  });
});
