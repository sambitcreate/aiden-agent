import * as fs from "node:fs/promises";
import * as path from "node:path";
import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
import type { Page } from "@playwright/test";
import { compileAum } from "../../renderer/shared/aiden-ui/compile";
import { parseChatUiVisualV1 } from "../../renderer/shared/aiden-ui/visual";
import { AIDEN_UI_CATALOG_VERSION } from "../../renderer/shared/aiden-ui/types";
import { buildVisualViewerDocument, type VisualViewerBundle } from "../../main/services/visual-viewer-document";
import { loadGenerativeUiHostLibraries } from "../../main/services/generative-ui-host-libraries";

// Playwright's config loader resolves this ESM repo through the CommonJS
// condition. Named exports are unavailable; the default object carries them.
const { expect, test } = playwrightTest as unknown as typeof PlaywrightTestModule;

/**
 * The phone visual viewer document, as iOS and Android load it: an HTML string
 * with no base URL, the network unreachable, and one native message channel
 * (stubbed here as Android's `AidenVisualBridge`).
 */

async function viewerBundle(): Promise<VisualViewerBundle> {
  const directory = path.resolve("build/renderer/visual-viewer");
  return {
    script: await fs.readFile(path.join(directory, "viewer.js"), "utf8"),
    style: await fs.readFile(path.join(directory, "viewer.css"), "utf8"),
  };
}

interface Loaded {
  messages: () => Promise<Array<Record<string, unknown>>>;
  requests: string[];
}

async function openDocument(page: Page, document: string): Promise<Loaded> {
  const requests: string[] = [];
  const entry = "https://viewer.invalid/";
  await page.route("**/*", (route) => {
    if (route.request().url() === entry) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: document });
    requests.push(route.request().url());
    return route.abort();
  });
  // Only the top document gets the channel, as `isMainFrame` checks do natively.
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const sent: string[] = [];
    Object.defineProperty(window, "__viewerMessages", { value: sent });
    Object.defineProperty(window, "AidenVisualBridge", { value: { postMessage: (json: string) => sent.push(json) } });
  });
  await page.goto(entry);
  return {
    requests,
    messages: () =>
      page.evaluate(() =>
        ((window as unknown as { __viewerMessages: string[] }).__viewerMessages ?? []).map((json) => JSON.parse(json) as Record<string, unknown>),
      ),
  };
}

function uiVisual(markup: string) {
  const compiled = compileAum(markup);
  if (!compiled.tree) throw new Error("fixture markup did not compile");
  const visual = parseChatUiVisualV1({
    version: 1,
    kind: "ui",
    id: "ui-1",
    title: "Weekly active users",
    catalogVersion: AIDEN_UI_CATALOG_VERSION,
    tree: compiled.tree,
    ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
    ...(compiled.state ? { state: compiled.state } : {}),
    fallbackText: compiled.fallbackText,
  });
  if (!visual) throw new Error("fixture visual is invalid");
  return visual;
}

test("a native visual draws its chart offline in the phone's dark theme and hands follow-ups to the host", async ({ page }) => {
  const visual = uiVisual(`<Visual title="Weekly active users">
  <Chart kind="bar" data={$data.weeks} x="week" y="users" height={220} label="Users per week" />
  <Button variant="accent" action={sendPrompt("Break down W3")}>Drill into W3</Button>
  <Button action={openUrl("https://example.com/report")}>Open report</Button>
  <Data name="data">{"weeks": [{"week": "W1", "users": 1180}, {"week": "W2", "users": 1240}, {"week": "W3", "users": 1310}]}</Data>
</Visual>`);
  const document = buildVisualViewerDocument(
    { kind: "ui", title: visual.title, visual, attachments: [] },
    { scheme: "dark", preset: "aiden" },
    await viewerBundle(),
    {},
  );
  const loaded = await openDocument(page, document);

  await expect(page.locator("canvas[role='img'][data-chart-ready='true']")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await expect.poll(loaded.messages).toContainEqual({ type: "ready" });

  // The viewer draws no Send chip of its own: the phone confirms.
  await page.getByRole("button", { name: "Drill into W3" }).click();
  await expect.poll(loaded.messages).toContainEqual({ type: "prompt", text: "Break down W3" });
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  // Links go to the phone, which asks before opening them.
  await page.getByRole("button", { name: "Open report" }).click();
  await expect.poll(loaded.messages).toContainEqual({ type: "openUrl", url: "https://example.com/report" });
  expect(loaded.requests).toEqual([]);
});

test("an HTML visual runs sandboxed with its inlined library, takes the phone's theme, and its prompts are admitted once", async ({ page }) => {
  const html = `<canvas id="c" width="300" height="150"></canvas>
<p id="scheme"></p>
<script>
  new Chart(document.getElementById("c"), { type: "bar", data: { labels: ["a", "b"], datasets: [{ data: [1, 2], backgroundColor: aiden.series()[0] }] } });
  const show = () => { document.getElementById("scheme").textContent = document.documentElement.dataset.colorScheme; };
  show();
  window.addEventListener("aiden:themechange", show);
  let parentReadable = "blocked";
  try { parentReadable = String(window.parent.document.title); } catch (error) {}
  document.body.dataset.parent = parentReadable;
  aiden.sendPrompt("Explain bar b");
  aiden.sendPrompt("Explain bar b again");
</script>`;
  const document = buildVisualViewerDocument(
    { kind: "html", title: "Bars", html },
    { scheme: "dark", preset: "midnight" },
    await viewerBundle(),
    await loadGenerativeUiHostLibraries(),
  );
  const loaded = await openDocument(page, document);

  await expect(page.locator("iframe[data-themed='true']")).toHaveCount(1);
  const guest = page.frameLocator("iframe");
  await expect(guest.locator("#scheme")).toHaveText("dark");
  await expect(guest.locator("body")).toHaveAttribute("data-parent", "blocked");
  expect(await page.frames()[1]!.evaluate(() => typeof (window as unknown as { Chart?: unknown }).Chart)).toBe("function");
  expect(await page.frames()[1]!.evaluate(() => "AidenVisualBridge" in window)).toBe(false);

  await expect.poll(loaded.messages).toContainEqual({ type: "ready" });
  const prompts = (await loaded.messages()).filter((message) => message.type === "prompt");
  // The second request falls inside the 3 s cooldown.
  expect(prompts).toEqual([{ type: "prompt", text: "Explain bar b" }]);
  expect(loaded.requests).toEqual([]);
});

test("tall visuals scroll on a phone-sized screen so below-the-fold actions stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const bundle = await viewerBundle();
  const scrolled = () => page.evaluate(() => document.querySelector("main")!.parentElement!.scrollTop);

  const visual = uiVisual(`<Visual title="Tall">
  <Chart kind="bar" data={$data.rows} x="k" y="v" height={900} label="Tall chart" />
  <Button action={sendPrompt("From the bottom")}>Bottom action</Button>
  <Data name="data">{"rows": [{"k": "a", "v": 1}, {"k": "b", "v": 2}]}</Data>
</Visual>`);
  const native = await openDocument(page, buildVisualViewerDocument({ kind: "ui", title: "Tall", visual, attachments: [] }, { scheme: "light", preset: "aiden" }, bundle, {}));
  await expect.poll(native.messages).toContainEqual({ type: "ready" });
  await page.mouse.move(195, 300);
  await page.mouse.wheel(0, 2000);
  await expect.poll(scrolled).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Bottom action" })).toBeInViewport();
  await page.getByRole("button", { name: "Bottom action" }).click();
  await expect.poll(native.messages).toContainEqual({ type: "prompt", text: "From the bottom" });

  await page.unrouteAll();
  const html = `<div style="height: 1600px"></div><button id="b" onclick="aiden.sendPrompt('Guest bottom')">Guest bottom</button>`;
  const guest = await openDocument(page, buildVisualViewerDocument({ kind: "html", title: "Tall guest", html }, { scheme: "light", preset: "aiden" }, bundle, {}));
  await expect.poll(guest.messages).toContainEqual({ type: "ready" });
  await page.mouse.move(195, 300);
  await page.mouse.wheel(0, 3000);
  await expect.poll(scrolled).toBeGreaterThan(0);
  const button = page.frameLocator("iframe").locator("#b");
  await expect(button).toBeInViewport();
  await button.click();
  await expect.poll(guest.messages).toContainEqual({ type: "prompt", text: "Guest bottom" });
});
