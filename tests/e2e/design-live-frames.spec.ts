// Live app frames end to end (design mode v2 Phase 3a, Task 14). The
// workspace is a copy of tests/fixtures/design-live-app with node_modules
// linked to the repo's, so design mode starts its Vite dev server after the
// consent card. Aiden places the frames through the fake model's
// canvas_place_frame calls.
//
// Containment has two oracles: the page sees each blocked request fail, and
// the observer it was aimed at (design-live-observer.ts) sees nothing. External
// hosts reach the observer only through the test-only --host-resolver-rules
// switch, which a control request on a separate session proves works.

import { cp, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, FrameLocator, Locator, Page, TestInfo } from "@playwright/test";
import type { DesignAppsSnapshot, DesignAppStatus } from "../../renderer/shared/design-app";
import {
  hostResolverRules,
  nonLoopbackAddress,
  startHttpObserver,
  startTcpObserver,
  startUdpObserver,
  type HttpObserver,
} from "./design-live-observer";
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

const FIXTURE = fileURLToPath(new URL("../fixtures/design-live-app/", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DESIGN_CHAT = "Design the pricing app";

type Ipc = { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } };
type Aiden = AidenE2e;
const LIVE_ON = { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "1" };

const live = test.extend<{ external: HttpObserver }>({
  // External hosts resolve to this observer for the whole launch.
  external: async ({}, use) => {
    const observer = await startHttpObserver(nonLoopbackAddress());
    await use(observer);
    await observer.close();
  },
  appArgs: async ({ external }, use) => {
    await use([
      hostResolverRules(external.host, external.port),
      // gVisor (the Cua Space) kills Chromium's seccomp-filtered renderer as soon
      // as a Vite + React page runs (Task 2's environment note). Test-only.
      ...(process.platform === "linux" ? ["--disable-seccomp-filter-sandbox"] : []),
    ]);
  },
});

live.use({ workspaceSeed: true, appEnvironment: LIVE_ON });

async function seedFixture(workspaceDir: string): Promise<void> {
  await cp(FIXTURE, workspaceDir, { recursive: true });
  // The person's install: design mode finds Vite in devDependencies and starts `npm run dev` without installing.
  await symlink(path.join(REPOSITORY_ROOT, "node_modules"), path.join(workspaceDir, "node_modules"), "dir");
}

async function chatIdFor(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(async (wanted) => {
    const chats = await (window as unknown as Ipc).aidenAPI.ipc.invoke<Array<{ id: string; title?: string }>>("chats:list");
    return chats.find((chat) => chat.title === wanted)?.id ?? null;
  }, title);
  expect(id, `the chat titled ${title}`).not.toBeNull();
  return id!;
}

async function rootApp(page: Page, chatId: string): Promise<DesignAppStatus | undefined> {
  const snapshot = await page.evaluate(
    (id) => (window as unknown as Ipc).aidenAPI.ipc.invoke<DesignAppsSnapshot>("designApp:status:get", id),
    chatId,
  );
  return snapshot.apps.find((app) => app.appRoot === ".");
}

const runCard = (page: Page) => page.getByRole("group", { name: /^Run .* app\?$/u });
const chip = (page: Page) => page.getByRole("button", { name: /^Live app:/u });
const frameGroup = (page: Page, title: string) => designCanvas(page).getByRole("group", { name: title, exact: true });
const appIframe = (page: Page, title: string): Locator => frameGroup(page, title).locator("iframe[data-app-frame-id]");
const inside = (page: Page, title: string): FrameLocator => frameGroup(page, title).frameLocator("iframe[data-app-frame-id]");

/** Opens a design chat in the fixture workspace and lets design mode start the app. */
async function openLiveChat(aiden: Aiden): Promise<{ chatId: string; app: DesignAppStatus }> {
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
  await expect(runCard(page)).toBeVisible({ timeout: 30_000 });
  await runCard(page).getByRole("button", { name: "Allow" }).click();
  await expect.poll(async () => (await rootApp(page, chatId))?.phase, { timeout: 90_000 }).toBe("running");
  return { chatId, app: (await rootApp(page, chatId))! };
}

/** Aiden places app frames for these routes, in order. */
async function placeFrames(aiden: Aiden, frames: Array<{ title: string; route: string }>, prompt: string): Promise<void> {
  const composer = aiden.page.locator("textarea").first();
  const scenario = aiden.lmStudio.enqueueToolScenario!({
    prompt,
    calls: frames.map((frame) => ({ name: "canvas_place_frame", arguments: { kind: "app", title: frame.title, route: frame.route } })),
    finalText: "The app is on the canvas.",
  });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect.poll(() => scenario.completed, { timeout: 30_000 }).toBe(true);
  expect(scenario.error).toBeUndefined();
  for (const frame of frames) await expect(frameGroup(aiden.page, frame.title)).toBeVisible();
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

async function answerNextSave(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as unknown as typeof dialog.showSaveDialog;
  }, file);
}

async function enter(page: Page, title: string): Promise<void> {
  await frameGroup(page, title).dblclick();
  await expect(appIframe(page, title)).not.toHaveAttribute("inert", /.*/u);
}

live("two routes run live, take keys only when entered, and keep the app's own redirects inside", async ({ aiden }, testInfo) => {
  const { app, page, workspaceDir } = aiden;
  await seedFixture(workspaceDir);
  await openLiveChat(aiden);
  await placeFrames(
    aiden,
    [
      { title: "Home", route: "/" },
      { title: "Pricing", route: "/pricing" },
      { title: "Framed", route: "/framed" },
      { title: "Thief", route: "/probe?thief=1" },
    ],
    "Live frames test: put the home, pricing, framed and probe routes on the canvas.",
  );

  // Both routes render their own page, and a page that forbids framing still shows on the canvas.
  await expect(inside(page, "Home").locator("#home-title")).toHaveText("Fixture home", { timeout: 30_000 });
  await expect(inside(page, "Pricing").getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 30_000 });
  await expect(inside(page, "Framed").locator("#framed")).toHaveText("Framed content", { timeout: 30_000 });
  await expect(inside(page, "Thief").getByRole("heading", { name: "Probe" })).toBeVisible({ timeout: 30_000 });
  for (const title of ["Home", "Pricing", "Framed", "Thief"]) await expect(appIframe(page, title)).toHaveAttribute("inert", "");
  await waitForToastsToClear(page);
  await shoot(page, testInfo, "design-live-frames");

  // K1: a page calling input.focus() every 50 ms in a frame that isn't entered never takes the composer's keys.
  const composer = page.locator("textarea").first();
  await composer.click();
  await page.keyboard.type("hello composer", { delay: 40 });
  await expect(composer).toHaveValue("hello composer");
  await expect(composer).toBeFocused();
  await composer.fill("");

  // Entering hands the page the keys; its Esc gives them back to the canvas.
  await enter(page, "Pricing");
  await inside(page, "Pricing").getByRole("heading", { name: "Pricing" }).click();
  await shoot(page, testInfo, "design-live-entered");
  await page.keyboard.press("Escape");
  await expect(appIframe(page, "Pricing")).toHaveAttribute("inert", "");
  await expect(page.locator(".studio-canvas")).toBeFocused();

  // A redirect within the app lands inside the frame; one out of it is refused with Open in browser.
  await enter(page, "Home");
  await inside(page, "Home").locator("#to-out").click();
  const refused = page.getByText("example.com is outside the app");
  await expect(refused).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Open in browser" })).toBeVisible();
  await expect(inside(page, "Home").locator("#home-title")).toHaveText("Fixture home");
  await shoot(page, testInfo, "design-live-open-in-browser");
  await inside(page, "Home").locator("#to-login").click();
  await expect(inside(page, "Home").getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(appIframe(page, "Home")).toHaveAttribute("inert", "");
  await waitForToastsToClear(page);

  // Download offers a picture or a PDF of the running app, drawn at its viewport.
  const pricing = frameGroup(page, "Pricing");
  await pricing.click();
  const pngPath = path.join(aiden.workspaceDir, "..", "pricing.png");
  await answerNextSave(app, pngPath);
  await pricing.getByRole("button", { name: "Download Pricing" }).click();
  await expect(page.getByRole("menuitem", { name: "PNG image" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Original file" })).toHaveCount(0);
  await shoot(page, testInfo, "design-live-download-menu");
  await page.getByRole("menuitem", { name: "PNG image" }).click();
  await expect.poll(async () => (await readFile(pngPath).catch(() => Buffer.alloc(0))).length, { timeout: 45_000 }).toBeGreaterThan(1000);
  const png = await readFile(pngPath);
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect(png.readUInt32BE(16), "the 1 280 px viewport at 1×").toBe(1280);

  // Presenting shows the frames without entering them.
  await page.getByRole("button", { name: "Present this page" }).click();
  await expect(page.getByRole("toolbar", { name: "Presentation" })).toBeVisible();
  for (const title of ["Home", "Pricing"]) await expect(appIframe(page, title)).toHaveAttribute("inert", "");
  await shoot(page, testInfo, "design-live-present");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar", { name: "Presentation" })).toHaveCount(0);

  // Stopped, each frame keeps its picture under Start app; Start brings them back.
  await chip(page).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Stop", exact: true }).click();
  const start = frameGroup(page, "Pricing").getByRole("button", { name: "Start app" });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await expect(appIframe(page, "Pricing")).toHaveCount(0);
  await waitForToastsToClear(page);
  await shoot(page, testInfo, "design-live-start-overlay");
  await start.click();
  if (await runCard(page).isVisible().catch(() => false)) await runCard(page).getByRole("button", { name: "Allow" }).click();
  await expect(inside(page, "Pricing").getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 90_000 });

  // With live apps off, the same frames are cards over their last picture, and nothing is framed.
  const offPage = await aiden.relaunch(undefined, {});
  await finishLmStudioOnboarding(offPage);
  await offPage.locator("[data-sidebar]").getByRole("button", { name: new RegExp(`^${DESIGN_CHAT}`, "u") }).first().click();
  await expect(designCanvas(offPage)).toBeVisible({ timeout: 20_000 });
  await expect(frameGroup(offPage, "Pricing").getByText("Live apps are off")).toBeVisible({ timeout: 20_000 });
  await expect(offPage.locator("iframe[data-app-frame-id]")).toHaveCount(0);
  await waitForToastsToClear(offPage);
  await shoot(offPage, testInfo, "design-live-off");
});

live("a probe in an app frame reaches nothing outside localhost: each try fails in the page and no observer hears it", async ({ aiden, external }, testInfo) => {
  const { app, page, workspaceDir } = aiden;
  const tcp = await startTcpObserver("127.0.0.1");
  const alt = await startTcpObserver("127.0.0.2");
  const udp = await startUdpObserver("127.0.0.1");
  try {
    // The control: outside the default session, a mapped host does reach the external observer.
    const control = await app.evaluate(async ({ session }, url) => {
      const response = await session.fromPartition("aiden-e2e-observer-control").fetch(url);
      return response.text();
    }, "http://example.com/control");
    expect(control).toBe("observer");
    await expect.poll(() => external.paths.includes("/control")).toBe(true);
    const before = { ...external.counts };

    await seedFixture(workspaceDir);
    const { app: running } = await openLiveChat(aiden);
    const own = 9222;
    const query = `target=127.0.0.1:${tcp.port}&alt=127.0.0.2:${alt.port}&udp=${udp.port}&own=${own}`;
    expect(running.port).not.toBe(tcp.port);
    await placeFrames(aiden, [{ title: "Probe", route: `/probe?${query}` }], "Live frames test: put the probe on the canvas.");
    await expect(inside(page, "Probe").getByRole("heading", { name: "Probe" })).toBeVisible({ timeout: 30_000 });
    await enter(page, "Probe");
    await inside(page, "Probe").locator("#run").click();
    await expect(inside(page, "Probe").locator("#result")).not.toHaveText("", { timeout: 60_000 });
    const outcomes = JSON.parse((await inside(page, "Probe").locator("#result").textContent()) ?? "{}") as Record<string, string>;
    await testInfo.attach("probe-outcomes.json", { body: JSON.stringify(outcomes, null, 2), contentType: "application/json" });

    const failed = (name: string) => expect(outcomes[name], name).toMatch(/^failed:/u);
    for (const name of [
      "fetchExternal",
      "fetchLan",
      "fetchAltLoopback",
      "fetchHttpsLoopback",
      "img",
      "wsExternal",
      "wssExternal",
      "eventSource",
      "attachmentImg",
      "designScript",
      "assetLink",
      "redirectOwn",
      "redirectEvil",
      "redirectOut",
      "getUserMedia",
      "getDisplayMedia",
      "geolocation",
      "pictureInPicture",
      "fullscreen",
      "clipboard",
    ]) {
      failed(name);
    }
    expect(outcomes.getUserMedia).toBe("failed:NotAllowedError");
    expect(outcomes.windowOpen, "window.open returns null").toBe("ok:true");
    expect(outcomes.confirm, "confirm returns at once").toBe("ok:false");
    expect(outcomes.notification).toBe("ok:denied");
    expect(outcomes.beacon, "the beacon is queued but never sent").toMatch(/^ok:/u);

    // The main window stayed where it was.
    expect(page.url()).toMatch(/^file:/u);

    // Nothing reached the observers: not the TLS-less loopback one, not 127.0.0.2, not UDP, not the mapped external one.
    await page.waitForTimeout(2_000);
    expect(tcp.counts, "https://127.0.0.1 and the prefetch hints").toEqual({ connections: 0, bytes: 0 });
    expect(alt.counts, "127.0.0.2").toEqual({ connections: 0, bytes: 0 });
    expect(udp.datagrams(), "QUIC and WebTransport").toBe(0);
    expect(external.counts, "example.com, the LAN host and www.youtube.com").toEqual(before);

    // The frame's title row counts what was blocked and names the hosts.
    await page.keyboard.press("Escape");
    const blocked = frameGroup(page, "Probe").getByRole("button", { name: /\d+ blocked/u });
    await expect(blocked).toBeVisible();
    expect(Number((await blocked.textContent())?.match(/\d+/u)?.[0] ?? 0)).toBeGreaterThanOrEqual(5);
    await blocked.click();
    const hosts = page.getByRole("list", { name: "Blocked hosts" });
    await expect(hosts).toContainText("example.com");
    await expect(page.getByText("Design mode only lets apps reach localhost for now.")).toBeVisible();
    await expect(page.getByText(/Dialogs are turned off on the canvas/u)).toBeVisible();
    await shoot(page, testInfo, "design-live-blocked-popover");
  } finally {
    await Promise.all([tcp.close(), alt.close(), udp.close()]);
  }
});
