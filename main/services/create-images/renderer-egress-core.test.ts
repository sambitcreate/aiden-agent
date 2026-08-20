import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAidenMainRendererUrl, shouldBlockAidenRendererEgress } from "./renderer-egress-core.js";

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

test("main renderer CSP has no broad remote image, media, or connection source", () => {
  const html = readFileSync(new URL("../../../main-window.html", import.meta.url), "utf8");
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u)?.[1] ?? "";
  const directive = (name: string) =>
    policy
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name} `)) ?? "";
  for (const name of ["connect-src", "img-src", "media-src"]) {
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
