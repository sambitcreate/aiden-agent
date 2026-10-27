import path from "node:path";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import playwright from "@playwright/test";
import type * as PlaywrightModule from "@playwright/test";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "./fixtures";
import { fetchTranscriptImage } from "../../main/services/transcript-image-fetch";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

// Real renderer components in Chromium. The only transport exception is the
// fixture's injected Node adapter, never a production env flag or app channel.
test("transcript images make zero network requests before consent through streaming and reload", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "aiden-image-consent-"));
  const entry = path.join(rootDir, "main.cjs");
  await writeFile(entry, `const { app, BrowserWindow } = require("electron");
    app.setPath("userData", ${JSON.stringify(path.join(rootDir, "user-data"))});
    app.whenReady().then(() => { const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } }); window.loadURL("about:blank"); });`);
  const electron = (playwright as unknown as typeof PlaywrightModule)._electron;
  const app = await electron.launch({ args: [entry], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const page = await app.firstWindow();
  const paths: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url!); headers.push(request.headers);
    response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(PNG, "base64"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browserRequests: string[] = [];
  page.on("request", (request) => { if (/^https?:/u.test(request.url())) browserRequests.push(request.url()); });
  try {
    await page.exposeFunction("loadFixtureTranscriptImage", (url: string) => fetchTranscriptImage(url, { allowAddress: (address) => address === "127.0.0.1" }));
    const bundle = await build({ stdin: { contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { Markdown } from "./renderer/components/markdown";
      import { StreamingMarkdownReveal } from "./renderer/components/streaming-markdown-reveal";
      window.aidenAPI = { ipc: { invoke: (channel, url) => {
        if (channel !== "chat:loadTranscriptImage") throw new Error("Unexpected IPC");
        return window.loadFixtureTranscriptImage(url);
      } } };
      const root = createRoot(document.getElementById("root"));
      window.showFixtureTranscript = (content, scope, streaming) => root.render(
        streaming ? <StreamingMarkdownReveal content={content} imageScope={scope} /> : <Markdown content={content} imageScope={scope} />
      );
    `, resolveDir: process.cwd(), loader: "tsx" }, loader: { ".css": "empty" }, bundle: true, write: false, format: "iife", platform: "browser", define: { "process.env.NODE_ENV": '"production"' }, absWorkingDir: path.resolve(process.cwd()) });
    const script = bundle.outputFiles[0]!.text;
    const initialize = async () => {
      await page.setContent('<html data-reduce-motion="true"><body><div id="root"></div></body></html>');
      await page.addScriptTag({ content: script });
    };
    const show = (content: string, scope: string, streaming: boolean) => page.evaluate(({ content, scope, streaming }) => {
      (window as unknown as { showFixtureTranscript(content: string, scope: string, streaming: boolean): void }).showFixtureTranscript(content, scope, streaming);
    }, { content, scope, streaming });
    const content = `![Chart](${origin}/first)\n\n![Other](${origin}/other)`;
    await initialize();
    await show(content, "message-1", true);
    await expect(page.getByRole("button", { name: "Load image" })).toHaveCount(2);
    await show(content + "\n\nMore streamed text.", "message-1", true);
    await expect(page.getByText("More streamed text.", { exact: true })).toBeVisible();
    expect(paths).toEqual([]); expect(browserRequests).toEqual([]);
    await page.getByRole("button", { name: "Load image" }).first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("img", { name: "Chart" })).toHaveAttribute("src", `data:image/png;base64,${PNG}`);
    await expect.poll(() => page.getByRole("img", { name: "Chart" }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1)).toBe(true);
    expect(paths).toEqual(["/first"]); expect(browserRequests).toEqual([]);
    await show(`![Chart](${origin}/changed)`, "message-1", true);
    await expect(page.getByRole("button", { name: "Load image" })).toHaveCount(1);
    expect(paths).toEqual(["/first"]);
    await show(content, "message-2", false);
    await expect(page.getByRole("button", { name: "Load image" })).toHaveCount(2);
    await page.reload();
    await initialize();
    await show(content, "message-1", false);
    await expect(page.getByRole("button", { name: "Load image" })).toHaveCount(2);
    expect(paths).toEqual(["/first"]); expect(browserRequests).toEqual([]);
    expect(headers[0]?.cookie).toBeUndefined(); expect(headers[0]?.referer).toBeUndefined(); expect(headers[0]?.authorization).toBeUndefined();
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
