import path from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import playwright from "@playwright/test";
import type * as PlaywrightModule from "@playwright/test";
import { build } from "esbuild";
import { test, expect, isolatedAppEnvironment } from "./fixtures";

const DRAWING = [
  "```svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="240" height="120">',
  '  <rect x="4" y="4" width="112" height="52" rx="10" fill="none" stroke="#111" stroke-width="3"/>',
  '  <circle cx="34" cy="30" r="14" fill="#2563eb"/>',
  '  <path d="M60 42 L78 18 L96 42 Z" fill="#111"/>',
  "</svg>",
  "```",
].join("\n");
// No xmlns: Chromium refuses to decode it as an image, so the note must show.
const NO_XMLNS = ["```svg", '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>', "```"].join("\n");

// Real chat Markdown and the built stylesheet in Chromium, light and dark.
test("svg code blocks toggle between code and drawing without a blank card or network", async () => {
  const testInfo = test.info();
  const rootDir = await mkdtemp(path.join(tmpdir(), "aiden-svg-preview-"));
  const entry = path.join(rootDir, "main.cjs");
  await writeFile(entry, `const { app, BrowserWindow } = require("electron");
    app.setPath("userData", ${JSON.stringify(path.join(rootDir, "user-data"))});
    app.whenReady().then(() => { const window = new BrowserWindow({ width: 760, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } }); window.loadURL("about:blank"); });`);
  const electron = (playwright as unknown as typeof PlaywrightModule)._electron;
  const app = await electron.launch({ args: [entry], env: isolatedAppEnvironment() });
  const page = await app.firstWindow();
  const networkRequests: string[] = [];
  page.on("request", (request) => { if (/^(https?|wss?):/u.test(request.url())) networkRequests.push(request.url()); });
  try {
    const assetsDir = path.resolve("build/renderer/assets");
    const stylesheets = (await readdir(assetsDir)).filter((name) => name.endsWith(".css"));
    expect(stylesheets.length).toBeGreaterThan(0);
    const bundle = await build({ stdin: { contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { Markdown } from "./renderer/components/markdown";
      const root = createRoot(document.getElementById("root"));
      window.showFixtureTranscript = (content) => root.render(<Markdown content={content} />);
    `, resolveDir: process.cwd(), loader: "tsx" }, loader: { ".css": "empty" }, bundle: true, write: false, format: "iife", platform: "browser", define: { "process.env.NODE_ENV": '"production"' }, absWorkingDir: path.resolve(process.cwd()) });
    await page.setContent('<html data-reduce-motion="true"><body><div id="root" style="box-sizing: border-box; max-width: 720px; padding: 24px; overflow: auto"></div></body></html>');
    for (const name of stylesheets) await page.addStyleTag({ path: path.join(assetsDir, name) });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate((content) => {
      (window as unknown as { showFixtureTranscript(content: string): void }).showFixtureTranscript(content);
    }, `Here is the drawing:\n\n${DRAWING}\n\nAnd one without a namespace:\n\n${NO_XMLNS}`);

    const toggles = page.getByRole("button", { name: "Preview" });
    await expect(toggles).toHaveCount(2);
    const [drawingToggle, bareToggle] = [toggles.nth(0), toggles.nth(1)];
    await expect(drawingToggle).toHaveAttribute("aria-pressed", "false");

    // Keyboard: Tab to the first toggle so focus-visible shows, then press it.
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    for (let step = 0; step < 10 && !(await drawingToggle.evaluate((node) => node === document.activeElement)); step += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(drawingToggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(drawingToggle).toHaveAttribute("aria-pressed", "true");
    const drawing = page.getByRole("img", { name: "SVG preview" });
    await expect.poll(() => drawing.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

    // The namespace-less fence must end up drawn or explained, never a blank card.
    await bareToggle.click();
    await expect.poll(async () => {
      if (await page.getByText("Couldn't draw this SVG.").isVisible()) return "note";
      const images = page.getByRole("img", { name: "SVG preview" });
      if ((await images.count()) === 2 && await images.nth(1).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)) return "drawing";
      return "pending";
    }).not.toBe("pending");

    await drawingToggle.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await page.screenshot({ path: testInfo.outputPath(`svg-preview-${theme}.png`), fullPage: true });
    }

    await drawingToggle.click();
    await expect(drawingToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("pre").first()).toContainText("<circle");
    expect(networkRequests).toEqual([]);
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
