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

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  appIframe,
  frameGroup,
  inside,
  LIVE_ON,
  openLiveChat,
  placeFrames,
  press,
  runCard,
  seedFixture,
  shoot,
} from "./design-live-helpers";
import {
  hostResolverRules,
  nonLoopbackAddress,
  startHttpObserver,
  startTcpObserver,
  startUdpObserver,
  type HttpObserver,
} from "./design-live-observer";
import { designCanvas, setDisplayWidth, setWindowWidth } from "./design-mode-helpers";
import { expect, test, waitForToastsToClear } from "./fixtures";

const FIXTURE = fileURLToPath(new URL("../fixtures/design-live-app/", import.meta.url));

const live = test.extend<{ external: HttpObserver }>({
  // External hosts resolve to this observer for the whole launch.
  external: async ({ workspaceSeed: _seed }, use) => {
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

const chip = (page: Page) => page.getByRole("button", { name: /^Live app:/u });

async function answerNextSave(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as unknown as typeof dialog.showSaveDialog;
  }, file);
}

/** Records every `shell.openExternal` call instead of opening anything. */
async function recordOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __aidenE2eOpened?: string[] }).__aidenE2eOpened = opened;
    shell.openExternal = (async (url: string) => {
      opened.push(url);
    }) as typeof shell.openExternal;
  });
}

function openedExternally(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { __aidenE2eOpened?: string[] }).__aidenE2eOpened ?? []);
}

async function enter(page: Page, title: string): Promise<void> {
  await frameGroup(page, title).dblclick();
  await expect(appIframe(page, title)).not.toHaveAttribute("inert", /.*/u);
}

live("two routes run live, take keys only when entered, and keep the app's own redirects inside", async ({ aiden }, testInfo) => {
  const { app, page, workspaceDir } = aiden;
  await seedFixture(workspaceDir, FIXTURE);
  await openLiveChat(aiden);
  await placeFrames(
    aiden,
    [
      { title: "Home", route: "/" },
      { title: "Pricing", route: "/pricing" },
      { title: "Framed", route: "/framed" },
    ],
    "Live frames test: put the home, pricing and framed routes on the canvas.",
  );

  // Both routes render their own page, and a page that forbids framing still shows on the canvas.
  await expect(inside(page, "Home").locator("#home-title")).toHaveText("Fixture home", { timeout: 30_000 });
  await expect(inside(page, "Pricing").getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 30_000 });
  await expect(inside(page, "Framed").locator("#framed")).toHaveText("Framed content", { timeout: 30_000 });
  for (const title of ["Home", "Pricing", "Framed"]) await expect(appIframe(page, title)).toHaveAttribute("inert", "");
  await waitForToastsToClear(page);
  await shoot(page, testInfo, "design-live-frames");

  // Entering hands the page the keys; its Esc gives them back to the canvas.
  await enter(page, "Home");
  await press(inside(page, "Home").locator("#counter"));
  await expect(inside(page, "Home").locator("#counter")).toHaveText("Count 1");
  await shoot(page, testInfo, "design-live-entered");
  await page.keyboard.press("Escape");
  await expect(appIframe(page, "Home")).toHaveAttribute("inert", "");
  await expect(page.locator(".studio-canvas")).toBeFocused();

  // A redirect within the app lands inside the frame.
  await enter(page, "Home");
  await activate(inside(page, "Home").locator("#to-login"));
  await expect(inside(page, "Home").getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 10_000 });
  // The bridge reaches every page the frame loads: Esc on the new page still leaves.
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
  // One frame a slide: Home is live on the first, and stays inert.
  await expect(page.getByRole("toolbar", { name: "Presentation" })).toContainText("1 of 3");
  await expect(appIframe(page, "Home")).toHaveAttribute("inert", "");
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
  await setDisplayWidth(aiden.app, 1440);
  await setWindowWidth(aiden.app, offPage, 1440);
  // Aiden reopens the design chat it was in.
  await expect(designCanvas(offPage)).toBeVisible({ timeout: 20_000 });
  await expect(frameGroup(offPage, "Pricing").getByText("Live apps are off")).toBeVisible({ timeout: 20_000 });
  await expect(offPage.locator("iframe[data-app-frame-id]")).toHaveCount(0);
  await waitForToastsToClear(offPage);
  await shoot(offPage, testInfo, "design-live-off");
});

/**
 * Activates a control that takes the frame to another page (a link, or a
 * button that sets `location`): clicked in the page, so no key event is in
 * flight when the frame's document is replaced. A CDP key event waits for the
 * renderer's ack, and a key whose document goes away mid-press (a refused
 * mailto: or redirect puts the frame back on its page) can wait for it until
 * the test times out (#966 CI run 46059273553). `press` stays for controls
 * that keep the page.
 */
async function activate(control: Locator): Promise<void> {
  await control.evaluate((element) => (element as HTMLElement).click());
}

// S1 and D1. The main window's CSP frame-src refuses a redirect (or a mailto:)
// out of an app frame before will-redirect or will-frame-navigate runs. Main
// answers the failed load: counted, Open in browser for a web address, and the
// frame put back on its last in-app path.
live("S1: a redirect out of the app leaves the frame where it was, with Open in browser", async ({ aiden }, testInfo) => {
  const { app, page, workspaceDir } = aiden;
  await seedFixture(workspaceDir, FIXTURE);
  await openLiveChat(aiden);
  await placeFrames(aiden, [{ title: "Home", route: "/" }], "Live frames test: put the home route on the canvas.");
  await expect(inside(page, "Home").locator("#home-title")).toHaveText("Fixture home", { timeout: 30_000 });
  await recordOpenExternal(app);
  await enter(page, "Home");
  await activate(inside(page, "Home").locator("#to-out"));
  await expect(page.getByText("example.com is outside the app")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Open in browser" })).toBeVisible();
  await expect(inside(page, "Home").locator("#home-title")).toHaveText("Fixture home", { timeout: 10_000 });
  await expect(frameGroup(page, "Home").getByRole("button", { name: /1 blocked/u })).toBeVisible();
  // A quarter-scale frame's status row gives way: its Download action stays inside the frame.
  const card = await frameGroup(page, "Home").boundingBox();
  const download = await frameGroup(page, "Home").getByRole("button", { name: /^Download/u }).boundingBox();
  expect(download!.x + download!.width).toBeLessThanOrEqual(card!.x + card!.width + 0.5);
  await shoot(page, testInfo, "design-live-open-in-browser");
  // Open in browser opens the browser panel, only when pressed; nothing went to the system.
  // (A fresh refusal, so the toast hasn't timed out during the screenshots.)
  await activate(inside(page, "Home").locator("#to-out"));
  await page.getByRole("button", { name: "Open in browser" }).click();
  await expect(page.getByRole("textbox", { name: "Search or enter URL" })).toHaveValue(/example\.com/u, { timeout: 15_000 });
  expect(await openedExternally(app)).toEqual([]);
});

// K1 (S75). Keys here are Playwright's CDP keys, which Chromium routes to the
// focused frame's widget as it routes a real keyboard's (Electron's
// sendInputEvent goes to the main frame's widget only, so it can't show this).
// Blink's BlockingFocusWithoutUserActivation, on with the flag, makes the
// iframe's focus-without-user-activation 'none' refuse the page's focus()
// loop. This is also the canary: if a Chromium upgrade drops the feature, it fails.
live("K1: a page looping input.focus() in a frame that isn't entered never takes the composer's keys", async ({ aiden }) => {
  const { page, workspaceDir } = aiden;
  await seedFixture(workspaceDir, FIXTURE);
  await openLiveChat(aiden);
  await placeFrames(aiden, [{ title: "Thief", route: "/probe?thief=1" }], "Live frames test: put the probe on the canvas.");
  await expect(inside(page, "Thief").getByRole("heading", { name: "Probe" })).toBeVisible({ timeout: 30_000 });
  const composer = page.locator("textarea").first();
  // Playwright runs its frame checks as a user gesture (callFunctionOn with
  // userGesture), and Chromium's transient activation lasts 5 s: wait it out,
  // so the thief has no activation, like a page the person never touched.
  await page.waitForTimeout(5_500);
  await composer.click();
  await page.keyboard.type("hello composer", { delay: 40 });
  await expect(composer).toHaveValue("hello composer");
  await expect(composer).toBeFocused();
  await expect(inside(page, "Thief").locator("#thief-input")).toHaveValue("");
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

    await seedFixture(workspaceDir, FIXTURE);
    const { app: running } = await openLiveChat(aiden);
    const own = 9222;
    const query = `target=127.0.0.1:${tcp.port}&alt=127.0.0.2:${alt.port}&udp=${udp.port}&own=${own}`;
    expect(running.port).not.toBe(tcp.port);
    await placeFrames(aiden, [{ title: "Probe", route: `/probe?${query}` }], "Live frames test: put the probe on the canvas.");
    await expect(inside(page, "Probe").getByRole("heading", { name: "Probe" })).toBeVisible({ timeout: 30_000 });
    // Anything the page hands to the system (popups, mailto:, top navigation) would reach openExternal.
    await recordOpenExternal(app);
    const opened = () => openedExternally(app);
    await enter(page, "Probe");
    await press(inside(page, "Probe").locator("#run"));
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
    // Denied by the permission layer, or refused before it on a runner with no capture device.
    expect(outcomes.getUserMedia).toMatch(/^failed:(NotAllowedError|NotFoundError)$/u);
    expect(outcomes.windowOpen, "window.open returns null").toBe("ok:true");
    expect(outcomes.confirm, "confirm returns at once").toBe("ok:false");
    expect(outcomes.notification).toBe("ok:denied");
    expect(outcomes.beacon, "the beacon is queued but never sent").toMatch(/^ok:/u);

    // The main window stayed where it was, and nothing went to the system.
    expect(page.url()).toMatch(/^file:/u);
    expect(await opened()).toEqual([]);

    // Nothing reached the observers: not the TLS-less loopback one, not 127.0.0.2, not the mapped external one.
    // The UDP observer only gives WebTransport a target: it leaks (S71, W1 and W2), and nothing is asserted about it.
    await page.waitForTimeout(2_000);
    expect(tcp.counts, "https://127.0.0.1 and the prefetch hints").toEqual({ connections: 0, bytes: 0 });
    expect(alt.counts, "127.0.0.2").toEqual({ connections: 0, bytes: 0 });
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
    await page.keyboard.press("Escape");

    // D1: a mailto: link opens nothing outside Aiden.
    await enter(page, "Probe");
    await activate(inside(page, "Probe").locator("#mailto"));
    await page.waitForTimeout(1_000);
    expect(await opened()).toEqual([]);
    // The frame is put back on its page (S1, D1).
    await expect(inside(page, "Probe").getByRole("heading", { name: "Probe" })).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toMatch(/^file:/u);
  } finally {
    await Promise.all([tcp.close(), alt.close(), udp.close()]);
  }
});
