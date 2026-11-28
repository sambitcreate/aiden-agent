// Design apps end to end (design mode v2 Phase 3d, Task 10). A workspace with
// no web app gets a small Vite + React app of its own after the person's Add
// design app: from Aiden's design_app scaffold, or from the chip's Add design
// app…. The workspace is a copy of tests/fixtures/design-mock-electron (an
// Electron app with React in its renderer) or design-mock-empty (no app).
//
// Nothing reaches the network: AIDEN_E2E_DESIGN_APP_NODE_MODULES (unpackaged
// only) links the new folder's node_modules to the repo's, which holds the
// template's exact versions, so 2b finds an install and skips npm ci. The one
// test that installs points npm at a closed loopback port through the test
// HOME's .npmrc, so its install fails without leaving the machine.
//
// The workspace folder is the oracle for what was written; the saved canvas
// for where frames went; the page inside a frame for what it shows.

import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";
import { chatIdFor, frameGroup, LIVE_ON, savedCanvas, shoot, type SavedFrame } from "./design-live-helpers";
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
import { expect, finishLmStudioOnboarding, test, waitForToastsToClear, type AidenE2e } from "./fixtures";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ELECTRON_FIXTURE = fileURLToPath(new URL("../fixtures/design-mock-electron/", import.meta.url));
const EMPTY_FIXTURE = fileURLToPath(new URL("../fixtures/design-mock-empty/", import.meta.url));
const DESIGN_CHAT = "Design the desk notes app";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const LINKED = { ...LIVE_ON, AIDEN_E2E_DESIGN_APP_NODE_MODULES: path.join(REPOSITORY_ROOT, "node_modules") };
const ELECTRON_QUESTION = "This is an Electron app, so it can't run on the canvas. Make React mocks of its screens in design-app/ to iterate on?";
const STARTER_QUESTION = "This folder has no web app. Add a small React app in design-app/ to design in?";
const SETTINGS = [
  'import { Button } from "@app/components/Button";',
  'import "@app/styles.css";',
  "",
  "export default function Settings() {",
  "  return (",
  "    <main>",
  "      <h1>Settings</h1>",
  "      <Button>Save changes</Button>",
  "    </main>",
  "  );",
  "}",
  "",
].join("\n");

const mock = test.extend({
  appArgs: async ({ workspaceSeed: _seed }, use) => {
    // gVisor (the Cua Space) kills Chromium's seccomp-filtered renderer as soon
    // as a Vite + React page runs (3a's environment note). Test-only.
    await use(process.platform === "linux" ? ["--disable-seccomp-filter-sandbox"] : []);
  },
});

const chip = (page: Page) => page.getByRole("button", { name: /^Live app:/u });
const scaffoldCard = (page: Page, question: string) => page.getByRole("group", { name: question, exact: true });
const anyScaffoldCard = (page: Page) => page.locator("[data-design-app-card]");
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const insideNode = (page: Page, id: string) => node(page, id).frameLocator("iframe[data-app-frame-id]");

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function seed(workspaceDir: string, fixture: string): Promise<void> {
  await cp(fixture, workspaceDir, { recursive: true });
}

/** Sizes the window and opens a design chat in the fixture workspace; there's no web app, so no run card. */
async function openDesignChat(aiden: AidenE2e, title = DESIGN_CHAT): Promise<string> {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, title);
  const chatId = await chatIdFor(page, title);
  await typeSlashCommand(page, "/design");
  await expect(designCanvas(page)).toBeVisible();
  return chatId;
}

/** Starts one fake-model turn; the caller waits on `completed` (a scaffold call waits on the card first). */
function startTurn(aiden: AidenE2e, prompt: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const scenario = aiden.lmStudio.enqueueToolScenario!({ prompt, calls, finalText: "Done." });
  const composer = aiden.page.locator("textarea").first();
  return {
    scenario,
    send: async () => {
      await composer.fill(prompt);
      await composer.press("Enter");
    },
  };
}

async function turn(aiden: AidenE2e, prompt: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const { scenario, send } = startTurn(aiden, prompt, calls);
  await send();
  await expect.poll(() => scenario.completed, { timeout: 60_000 }).toBe(true);
  expect(scenario.error).toBeUndefined();
  return scenario;
}

async function openMenu(page: Page) {
  await chip(page).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Light and dark screenshots of the chip's open menu. */
async function shootMenu(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await previewAppearance(page, scheme);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", scheme);
    const menu = await openMenu(page);
    await page.screenshot({ path: testInfo.outputPath(`1440-${name}-${scheme}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  await previewAppearance(page, null);
}

/** Presses a card's button from the keyboard: focus, then Enter. */
async function pressButton(page: Page, name: string, within = anyScaffoldCard(page)): Promise<void> {
  const button = within.getByRole("button", { name, exact: true });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
}

async function appFrames(userDataDir: string, route: string, appRoot = "design-app"): Promise<SavedFrame[]> {
  const doc = await savedCanvas(userDataDir);
  return (doc?.frames ?? []).filter((frame) => frame.kind === "app" && frame.appRoot === appRoot && frame.route === route);
}

async function onlyFrame(userDataDir: string, route: string): Promise<SavedFrame> {
  await expect.poll(async () => (await appFrames(userDataDir, route)).length, { timeout: 30_000 }).toBe(1);
  return (await appFrames(userDataDir, route))[0]!;
}

const resultText = (scenario: { results: Array<{ content: unknown }> }) => JSON.stringify(scenario.results.map((result) => result.content));

/** The tool's answers, parsed: each result's text is the tool's JSON. */
function answers(scenario: { results: Array<{ content: unknown }> }): Array<Record<string, unknown>> {
  return scenario.results.map((result) => {
    const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { text };
    }
  });
}

mock.describe("with live apps on", () => {
  mock.use({ workspaceSeed: true, appEnvironment: LINKED });

  mock("A–C: an Electron project gets React mocks after Add design app; its own components render in a route, and ⌘D copies one", async ({ aiden }, testInfo) => {
    const { page, workspaceDir, userDataDir } = aiden;
    await seed(workspaceDir, ELECTRON_FIXTURE);
    await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Connect", { timeout: 20_000 });

    // A. Aiden asks for a design app: the card asks the Electron question and lists what it installs, with versions.
    const { scenario, send } = startTurn(aiden, "Mock test: add a design app.", [{ name: "design_app", arguments: { action: "scaffold" } }]);
    await send();
    const card = scaffoldCard(page, ELECTRON_QUESTION);
    await expect(card).toBeVisible({ timeout: 30_000 });
    for (const entry of ["react 19.2.7", "react-dom 19.2.7", "vite 8.3.5", "@vitejs/plugin-react 6.0.3"]) await expect(card).toContainText(entry);
    // The files are named inside the folder the card's first line names.
    await expect(card).toContainText("Adds design-app/ and an entry in .aiden/canvas.json");
    const writes = card.getByRole("list", { name: "Files it writes" });
    for (const file of ["package.json", "package-lock.json", ".npmrc", "aiden.mock.json", "src/routes/index.tsx"]) {
      await expect(writes.getByRole("listitem").filter({ hasText: new RegExp(`^${file.replace(/\./gu, "\\.")}$`, "u") })).toHaveCount(1);
    }
    expect(await exists(path.join(workspaceDir, "design-app")), "nothing is written before Add design app").toBe(false);
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-mock-scaffold-card-electron");
    await pressButton(page, "Add design app", card);
    await expect.poll(() => scenario.completed, { timeout: 90_000 }).toBe(true);
    expect(scenario.error).toBeUndefined();
    expect(resultText(scenario)).toContain("design-app");
    expect(resultText(scenario)).not.toContain("refused");

    const config = JSON.parse(await readFile(path.join(workspaceDir, "design-app", "aiden.mock.json"), "utf8")) as {
      kind: string;
      aliases: Record<string, string>;
      globals: string[];
    };
    expect(config.kind).toBe("react-nonweb");
    expect(config.aliases).toEqual({ "@app": "src/renderer" });
    expect(config.globals).toEqual(["api"]);
    const pkg = JSON.parse(await readFile(path.join(workspaceDir, "design-app", "package.json"), "utf8")) as { aiden?: unknown };
    expect(pkg.aiden).toEqual({ designApp: 1 });
    await expect(chip(page)).toContainText("Design app", { timeout: 90_000 });

    // The design app's / lands live on the chat's page, and its heading carries a workspace source stamp.
    const home = await onlyFrame(userDataDir, "/");
    await designCanvas(page).getByRole("button", { name: "Fit to screen" }).click();
    const heading = insideNode(page, home.id).getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("Design app", { timeout: 60_000 });
    await expect(heading).toHaveAttribute("data-aiden-src", /^ws:design-app\/src\/routes\/index\.tsx:\d+$/u);
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-mock-home-frame");

    // B. A route Aiden writes uses the project's own Button and stylesheet through @app, and lands by itself.
    await turn(aiden, "Mock test: write the settings page.", [{ name: "write_file", arguments: { path: "design-app/src/routes/settings.tsx", content: SETTINGS } }]);
    const settings = await onlyFrame(userDataDir, "/settings");
    expect(settings.createdBy).toBe("aiden");
    await designCanvas(page).getByRole("button", { name: "Fit to screen" }).click();
    const save = insideNode(page, settings.id).getByRole("button", { name: "Save changes" });
    await expect(save).toBeVisible({ timeout: 60_000 });
    await expect(save).toHaveCSS("background-color", "rgb(14, 116, 144)");
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-mock-settings-frame");

    // C. ⌘D on the mock route copies its file as -v2 beside it; ⌘Z takes both away.
    const copy = path.join(workspaceDir, "design-app/src/routes/settings-v2.tsx");
    await frameGroup(page, "/settings").click();
    await page.keyboard.press(`${MOD}+d`);
    await expect.poll(() => exists(copy)).toBe(true);
    const variant = await onlyFrame(userDataDir, "/settings-v2");
    expect(variant.label).toBe("v2");
    await expect(insideNode(page, variant.id).getByRole("button", { name: "Save changes" })).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(async () => (await appFrames(userDataDir, "/settings-v2")).length).toBe(0);
    await expect.poll(() => exists(copy)).toBe(false);
  });

  mock("D: Not now writes nothing and Aiden doesn't ask again in the chat; the chip's Add design app… asks again", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seed(workspaceDir, EMPTY_FIXTURE);
    await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Connect", { timeout: 20_000 });

    const first = startTurn(aiden, "Mock test: start a design app.", [{ name: "design_app", arguments: { action: "scaffold" } }]);
    await first.send();
    const card = scaffoldCard(page, STARTER_QUESTION);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-mock-scaffold-card-starter");
    await pressButton(page, "Not now", card);
    await expect(card).toHaveCount(0);
    await expect.poll(() => first.scenario.completed, { timeout: 30_000 }).toBe(true);
    expect(answers(first.scenario)[0]?.status).toBe("declined");
    expect(await exists(path.join(workspaceDir, "design-app"))).toBe(false);

    // A second scaffold in the same chat shows no card and answers that the person said no.
    const second = await turn(aiden, "Mock test: try the design app again.", [{ name: "design_app", arguments: { action: "scaffold" } }]);
    expect(answers(second)[0]?.status).toBe("declined");
    await expect(anyScaffoldCard(page)).toHaveCount(0);

    // The person can still ask from the chip.
    const menu = await openMenu(page);
    await expect(menu.getByRole("menuitem")).toHaveText(["Add design app…", "Connect running server…"]);
    await page.keyboard.press("Escape");
    await waitForToastsToClear(page);
    await shootMenu(page, testInfo, "design-mock-chip-add");
    const again = await openMenu(page);
    await again.getByRole("menuitem", { name: "Add design app…", exact: true }).click();
    await expect(scaffoldCard(page, STARTER_QUESTION)).toBeVisible({ timeout: 30_000 });
    await pressButton(page, "Not now");
    await expect(anyScaffoldCard(page)).toHaveCount(0);
    expect(await exists(path.join(workspaceDir, "design-app"))).toBe(false);
  });

  mock("E: a root script that hands off to a workspace runner gets no card; the tool and the chip say why", async ({ aiden }) => {
    const { page, workspaceDir } = aiden;
    await writeFile(
      path.join(workspaceDir, "package.json"),
      `${JSON.stringify({ name: "mono", private: true, dependencies: { react: "19.2.7" }, scripts: { dev: "turbo run dev" } }, null, 2)}\n`,
    );
    await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Connect", { timeout: 20_000 });
    const scenario = await turn(aiden, "Mock test: add a design app here.", [{ name: "design_app", arguments: { action: "scaffold" } }]);
    expect(resultText(scenario)).toContain("workspace-runner");
    await expect(anyScaffoldCard(page)).toHaveCount(0);
    const menu = await openMenu(page);
    await expect(menu).toContainText("This workspace's dev script hands off to a workspace runner.");
    await expect(menu.getByRole("menuitem")).toHaveText(["Connect running server…"]);
    await page.keyboard.press("Escape");
    expect(await exists(path.join(workspaceDir, "design-app"))).toBe(false);
  });
});

mock.describe("with live apps on and no Node.js", () => {
  // The resolver also looks in fixed folders, so a test hides Node with the unpackaged-only knob.
  mock.use({ workspaceSeed: true, appEnvironment: { ...LINKED, AIDEN_E2E_DESIGN_NODE_MISSING: "1" } });

  mock("Add design app… says Node.js is missing and offers Retry, writing nothing", async ({ aiden }, testInfo) => {
    const { page, workspaceDir } = aiden;
    await seed(workspaceDir, EMPTY_FIXTURE);
    await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Connect", { timeout: 20_000 });
    const menu = await openMenu(page);
    await menu.getByRole("menuitem", { name: "Add design app…", exact: true }).click();
    await expect(menu).toHaveCount(0);
    const after = await openMenu(page);
    await expect(after).toContainText("wasn't found. Install it from nodejs.org or Homebrew, then try again.");
    await expect(after.getByRole("menuitem", { name: "Retry", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(anyScaffoldCard(page)).toHaveCount(0);
    expect(await exists(path.join(workspaceDir, "design-app"))).toBe(false);
    await waitForToastsToClear(page);
    await shootMenu(page, testInfo, "design-mock-chip-node-missing");
  });
});

mock.describe("with live apps on and an install that fails", () => {
  // No node_modules link: npm ci runs, against a registry on a closed loopback port.
  mock.use({ workspaceSeed: true, appEnvironment: LIVE_ON });

  mock("a failed install keeps the files, and the chip names the network hint with Retry", async ({ aiden }, testInfo) => {
    const { page, workspaceDir, rootDir } = aiden;
    await seed(workspaceDir, EMPTY_FIXTURE);
    // The test HOME's npm settings, which design apps use as the person's own.
    await writeFile(path.join(rootDir, ".npmrc"), "registry=http://127.0.0.1:9/\nfetch-retries=0\nfetch-timeout=5000\n");
    await openDesignChat(aiden);
    await expect(chip(page)).toHaveText("Connect", { timeout: 20_000 });
    const menu = await openMenu(page);
    await menu.getByRole("menuitem", { name: "Add design app…", exact: true }).click();
    await expect(scaffoldCard(page, STARTER_QUESTION)).toBeVisible({ timeout: 30_000 });
    await pressButton(page, "Add design app");
    await expect(anyScaffoldCard(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(chip(page)).toHaveText("Not running", { timeout: 120_000 });
    expect(await exists(path.join(workspaceDir, "design-app", "package.json")), "the files stay for Retry").toBe(true);
    // npm's own output, kept with the result: the hint is chosen from its error codes.
    const logs = await openMenu(page);
    await logs.getByRole("menuitem", { name: "Show logs", exact: true }).click();
    const output = page.getByRole("log", { name: /^Output of /u });
    await expect(output).toContainText("npm", { timeout: 20_000 });
    await testInfo.attach("npm-output", { body: (await output.textContent()) ?? "", contentType: "text/plain" });
    await expect(output).toContainText("ECONNREFUSED");
    await page.keyboard.press("Escape");
    await expect(output).toHaveCount(0);
    const after = await openMenu(page);
    await expect(after).toContainText("The design app's install needs the npm registry. Check your network or proxy, then Retry.");
    await expect(after.getByRole("menuitem", { name: "Retry", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await waitForToastsToClear(page);
    await shootMenu(page, testInfo, "design-mock-chip-install-failed");
  });
});

mock.describe("with live apps off", () => {
  mock.use({ workspaceSeed: true });

  mock("F: no chip and no design_app; Aiden's design/ page still lands by itself", async ({ aiden }) => {
    const { page, workspaceDir } = aiden;
    await seed(workspaceDir, ELECTRON_FIXTURE);
    await openDesignChat(aiden);
    await expect(chip(page)).toHaveCount(0);
    const { scenario, send } = startTurn(aiden, "Mock test: the flag is off.", [{ name: "design_app", arguments: { action: "scaffold" } }]);
    await send();
    await expect.poll(() => scenario.error ?? null, { timeout: 30_000 }).toBe("The real generation did not advertise required tool design_app.");
    await turn(aiden, "Mock test: write an HTML page.", [
      { name: "write_file", arguments: { path: "design/home.html", content: "<!doctype html><title>Home</title><h1>Desk notes</h1>" } },
    ]);
    await expect(frameGroup(page, "home.html")).toBeVisible({ timeout: 30_000 });
    expect(await exists(path.join(workspaceDir, "design-app"))).toBe(false);
  });
});

mock.describe("with live apps on, an existing design/ page", () => {
  mock.use({ workspaceSeed: true, appEnvironment: LINKED });

  mock("G: the person's file frame of a design/ page reloads on save; a new design/ page Aiden writes doesn't land", async ({ aiden }) => {
    const { app, page, workspaceDir, userDataDir } = aiden;
    await seed(workspaceDir, EMPTY_FIXTURE);
    const pageFile = path.join(workspaceDir, "design", "home.html");
    await mkdir(path.dirname(pageFile), { recursive: true });
    await writeFile(pageFile, "<!doctype html><title>Home</title><h1>Desk notes</h1>");
    await openDesignChat(aiden);
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as unknown as typeof dialog.showOpenDialog;
    }, pageFile);
    await designCanvas(page).getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "File…" }).click();
    await expect(frameGroup(page, "home.html")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await savedCanvas(userDataDir))?.frames.find((frame) => frame.title === "home.html")?.createdBy).toBe("person");

    // A save to the file reloads the frame the person placed.
    await designCanvas(page).getByRole("button", { name: "Fit to screen" }).click();
    const framed = designCanvas(page).frameLocator('iframe[title="home.html"]');
    await expect(framed.getByRole("heading", { name: "Desk notes" })).toBeVisible({ timeout: 30_000 });
    await turn(aiden, "Mock test: retitle the page.", [
      { name: "edit_file", arguments: { path: "design/home.html", old_string: "Desk notes", new_string: "Desk notes, calmer" } },
    ]);
    await expect(framed.getByRole("heading", { name: "Desk notes, calmer" })).toBeVisible({ timeout: 30_000 });

    // A new design/ page Aiden writes stays off the canvas.
    await turn(aiden, "Mock test: write a second HTML page.", [
      { name: "write_file", arguments: { path: "design/library.html", content: "<!doctype html><title>Library</title><h1>Library</h1>" } },
    ]);
    expect(await exists(path.join(workspaceDir, "design", "library.html"))).toBe(true);
    const doc = await savedCanvas(userDataDir);
    expect((doc?.frames ?? []).map((frame) => frame.title)).not.toContain("library.html");
    await expect(frameGroup(page, "library.html")).toHaveCount(0);
    expect((await readdir(path.join(workspaceDir, "design"))).sort()).toEqual(["home.html", "library.html"]);
  });
});
