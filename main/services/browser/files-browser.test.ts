import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import playwright, { type Browser, type Page } from "playwright";
import { BROWSER_PREVIEW_AUTH_HEADER, BrowserFileService, browserPreviewRequestHeaders } from "./files.js";

test("Chromium previews load exact assets without leaking another grant through cookies or cross-port requests", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-preview-browser-"));
  const service = new BrowserFileService({ getWorkspace: async () => ({ id: "workspace", folderPath: root, permission: "full" }) });
  const received: IncomingHttpHeaders[] = [];
  const outgoing: Array<{ url: string; authorized: boolean }> = [];
  const receiver = createServer((request, response) => {
    received.push(request.headers);
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*");
    response.setHeader("Access-Control-Allow-Credentials", "true");
    const requested = new URL(request.url ?? "/", "http://localhost");
    const redirect = requested.searchParams.get("redirect");
    if (redirect) { response.writeHead(302, { Location: redirect }); response.end(); }
    else if (requested.pathname === "/frame") { response.setHeader("Content-Type", "text/html"); response.end("<body>Cross-origin frame</body>"); }
    else { response.setHeader("Content-Type", "text/plain"); response.end("received"); }
  });
  let browser: Browser | undefined;
  try {
    await writeFile(join(root, "first.html"), '<link rel="stylesheet" href="first.css"><script src="first.js"></script><p>First approved document</p>');
    await writeFile(join(root, "first.css"), "p{color:rgb(12, 34, 56)}");
    await writeFile(join(root, "first.js"), "globalThis.previewScriptLoaded = true;");
    await writeFile(join(root, "second.html"), "<p>Second private grant</p>");
    const first = await service.open("workspace", "first.html", { assetPaths: ["first.css", "first.js"] });
    const second = await service.open("workspace", "second.html");
    const firstOrigin = new URL(first.url).origin, secondOrigin = new URL(second.url).origin;
    assert.notEqual(firstOrigin, secondOrigin);
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/collect`;
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const owned = new Set<Page>();
    // Chromium exercises real origin/CORS/cookie behavior. This host-side route
    // uses the same exact-grant lookup and header projection as Electron's hook.
    await context.route("**/*", async (route) => {
      let authorization: string | undefined;
      try {
        const frame = route.request().frame();
        if (owned.has(frame.page())) authorization = service.authorizationForRequest(
          "workspace", route.request().url(), new URL(frame.url()).origin,
        );
      } catch { /* An initial about:blank frame uses the bootstrap URL. */ }
      const headers = browserPreviewRequestHeaders(route.request().headers(), authorization);
      outgoing.push({ url: route.request().url(), authorized: Boolean(headers[BROWSER_PREVIEW_AUTH_HEADER]) });
      await route.continue({ headers });
    });
    const firstPage = await context.newPage(), secondPage = await context.newPage();
    owned.add(firstPage); owned.add(secondPage);
    await firstPage.goto(first.url);
    await secondPage.goto(second.url);
    assert.equal(await firstPage.locator("p").evaluate((element) => getComputedStyle(element).color), "rgb(12, 34, 56)");
    assert.equal(await firstPage.evaluate("globalThis.previewScriptLoaded"), true);
    assert.deepEqual(await context.cookies(), [], "preview grants must never become host-wide cookies");
    const assetUrl = new URL("first.css", first.url).href;
    assert.equal(await firstPage.evaluate(async (url) => (await fetch(url)).text(), assetUrl), "p{color:rgb(12, 34, 56)}");
    await firstPage.evaluate(async (url) => { await fetch(url, { credentials: "include" }); }, receiverUrl);
    const secondPlain = new URL(second.url); secondPlain.search = "";
    for (const target of [secondPlain.href, `${receiverUrl}?redirect=${encodeURIComponent(secondPlain.href)}`]) {
      const result = await firstPage.evaluate(async (url) => {
        try { return await (await fetch(url, { credentials: "include" })).text(); }
        catch { return "blocked"; }
      }, target);
      assert.doesNotMatch(result, /Second private grant/);
    }
    await firstPage.evaluate((url) => {
      const frame = document.createElement("iframe"); frame.name = "attacker"; frame.src = url; document.body.append(frame);
    }, new URL("/frame", receiverUrl).href);
    const frameBody = firstPage.frameLocator('iframe[name="attacker"]').locator("body");
    await frameBody.waitFor();
    const frameResult = await frameBody.evaluate(async (_body, url) => {
      try { return await (await fetch(url, { credentials: "include" })).text(); }
      catch { return "blocked"; }
    }, assetUrl);
    assert.equal(frameResult, "blocked");
    assert.ok(received.length >= 3);
    for (const headers of received) {
      assert.equal(headers.cookie, undefined);
      assert.equal(headers[BROWSER_PREVIEW_AUTH_HEADER.toLowerCase()], undefined);
    }
    assert.ok(outgoing.some((request) => request.url === assetUrl && request.authorized));
    assert.ok(outgoing.some((request) => request.url === assetUrl && !request.authorized), "the cross-origin iframe receives no header");
    assert.ok(outgoing.filter((request) => request.url === secondPlain.href).every((request) => !request.authorized));
  } finally {
    await browser?.close();
    await service.shutdown();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
