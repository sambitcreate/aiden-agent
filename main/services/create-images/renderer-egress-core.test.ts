import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAidenMainRendererUrl, shouldBlockAidenRendererEgress, authorizeBrowserFaviconEgress } from "./renderer-egress-core.js";

test("packaged main renderer egress is denied while non-Aiden windows stay independent", () => {
  const rendererUrl =
    "file:///Applications/Aiden.app/Contents/Resources/app.asar/build/renderer/main-window.html";
  assert.equal(isAidenMainRendererUrl(rendererUrl), true);
  for (const requestUrl of [
    "https://attacker.example/collect",
    "http://attacker.example/pixel",
    "wss://attacker.example/socket",
  ]) {
    assert.equal(shouldBlockAidenRendererEgress({ requestUrl, rendererUrl, packaged: true }), true);
  }
  assert.equal(
    shouldBlockAidenRendererEgress({
      requestUrl: "https://accounts.example/login",
      rendererUrl: "https://accounts.example/login",
      packaged: true,
    }),
    false,
  );
});

test("development permits only loopback renderer transport", () => {
  const rendererUrl = "http://127.0.0.1:4143/main-window.html";
  assert.equal(
    shouldBlockAidenRendererEgress({
      requestUrl: "ws://127.0.0.1:4143/hmr",
      rendererUrl,
      packaged: false,
    }),
    false,
  );
  assert.equal(
    shouldBlockAidenRendererEgress({
      requestUrl: "https://attacker.example/collect",
      rendererUrl,
      packaged: false,
    }),
    true,
  );
});

test("main CSP permits browser favicons while connections and media remain local", () => {
  const html = readFileSync(new URL("../../../main-window.html", import.meta.url), "utf8");
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u)?.[1] ?? "";
  const directive = (name: string) =>
    policy
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name} `)) ?? "";
  assert.match(directive("img-src"), /aiden-asset:.*https: http:/u);
  for (const name of ["connect-src", "media-src"]) {
    const value = directive(name);
    assert.ok(value, `${name} must be present`);
    const sources = new Set(value.split(/\s+/u).slice(1));
    assert.equal(sources.has("http:"), false);
    assert.equal(sources.has("https:"), false);
    assert.equal(sources.has("file:"), false);
  }
});

test("the installed request policy honors the branded development runtime profile", () => {
  const source = readFileSync(new URL("./asset-protocol.ts", import.meta.url), "utf8");
  assert.match(source, /packaged: isPackagedRuntime\(\)/u);
  assert.doesNotMatch(source, /packaged: app\.isPackaged/u);
});


test("browser favicon exception requires exact main-owned URL, frame, image GET and owner", () => {
  const request = { url: "https://site.example/favicon.ico", method: "GET", resourceType: "image", webContentsId: 7 };
  const authorize = (url: string, owner: number, document: string) =>
    url === request.url && owner === 7 && document === "current-document";
  assert.equal(authorizeBrowserFaviconEgress(request, "current-document", authorize), true);
  for (const patch of [{ url: request.url + "?secret=x" }, { method: "POST" },
    { resourceType: "xhr" }, { webContentsId: 8 }, { webContentsId: undefined }]) {
    assert.equal(authorizeBrowserFaviconEgress({ ...request, ...patch }, "current-document", authorize), false);
  }
  assert.equal(authorizeBrowserFaviconEgress(request, undefined, authorize), false);
  assert.equal(authorizeBrowserFaviconEgress(request, "old-document", authorize), false);
  const rendererUrl = "file:///app/main-window.html";
  assert.equal(shouldBlockAidenRendererEgress({ requestUrl: request.url, rendererUrl, packaged: true,
    authorizedBrowserFavicon: true }), false);
  assert.equal(shouldBlockAidenRendererEgress({ requestUrl: request.url, rendererUrl, packaged: true }), true);
});


test("favicon authority is rechecked for navigation, revocation, redirects and schemes", () => {
  let current: string | undefined = "https://site.example/icon.png";
  const request = { url: current, method: "GET", resourceType: "image", webContentsId: 7 };
  const authorize = (url: string) => url === current;
  assert.equal(authorizeBrowserFaviconEgress(request, "doc", authorize), true);
  current = undefined;
  assert.equal(authorizeBrowserFaviconEgress(request, "doc", authorize), false);
  current = "https://site.example/new.png";
  assert.equal(authorizeBrowserFaviconEgress(request, "doc", authorize), false);
  assert.equal(authorizeBrowserFaviconEgress({ ...request, url: current }, "doc", authorize), true);
  assert.equal(authorizeBrowserFaviconEgress({ ...request, url: "https://redirect.example/icon.png" }, "doc", authorize), false);
  for (const url of ["file:///secret", "javascript:alert(1)", "wss://site.example", "https://user:pass@site.example/icon"]) {
    assert.equal(authorizeBrowserFaviconEgress({ ...request, url }, "doc", () => true), false);
  }
  const service = readFileSync(new URL("../browser/service.ts", import.meta.url), "utf8");
  assert.match(service, /owner\.documentId === documentId/u);
  assert.match(service, /!owner\.isDestroyed\(\) && !tab\.closing/u);
  assert.match(service, /tab\.state\.favicon === url/u);
  const start = service.slice(service.indexOf('wc.on("did-start-navigation"'));
  assert.ok(start.indexOf("tab.state.favicon = undefined") < start.indexOf('wc.on("will-navigate"'));
});
