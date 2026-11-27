import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finished } from "node:stream/promises";
import { build, createServer } from "vite";
import { createPackage } from "@electron/asar";
import { productionRendererCsp } from "./renderer-csp.js";
// The release verifiers are JavaScript scripts also used outside TypeScript.
// @ts-expect-error The release script has no declaration file.
import { assertProductionRendererCsp, verifyPackagedRendererCsp, verifyRendererBuildCsp } from "./verify-renderer-csp.mjs";

const pages = ["main-window.html", "pill.html", "quick-chat.html", "bot-bubbles.html", "visual-snapshot.html"];
const devPolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:*; connect-src 'self' blob: https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*";
const html = (policy = devPolicy) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body><script type="module" src="/entry.js"></script></body></html>`;
const csp = (document: string): Map<string, string[]> => new Map((/content="([^"]+)"/u.exec(document)?.[1] ?? "").split(";").map(directive => {
  const [name, ...sources] = directive.trim().split(/\s+/u);
  return [name!, sources];
}));

test("actual Vite production HTML denies localhost code while preserving renderer connection policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-production-csp-"));
  try {
    await Promise.all(pages.map(page => writeFile(path.join(root, page), html())));
    await writeFile(path.join(root, "entry.js"), "document.body.dataset.loaded = 'yes';");
    const output = path.join(root, "package", "build", "renderer");
    await build({ configFile: false, root, plugins: [productionRendererCsp()], logLevel: "silent", build: {
      outDir: output, rollupOptions: { input: pages.map(page => path.join(root, page)) },
    } });
    await verifyRendererBuildCsp(output);
    for (const page of pages) {
      const policy = csp(await readFile(path.join(output, page), "utf8"));
      assert.deepEqual(policy.get("script-src"), ["'self'", "'wasm-unsafe-eval'"]);
      assert.deepEqual(policy.get("style-src"), ["'self'", "'unsafe-inline'"]);
      assert.deepEqual(policy.get("connect-src"), ["'self'", "blob:", "https:", "http://localhost:*", "http://127.0.0.1:*", "ws://localhost:*", "ws://127.0.0.1:*"]);
    }
    const asar = path.join(root, "accepted.asar");
    // Inspect the archive layout the packager actually ships.
    await finished(await createPackage(path.join(root, "package"), asar));
    verifyPackagedRendererCsp(asar);
    await writeFile(path.join(output, "future-window.html"), html());
    const rejected = path.join(os.tmpdir(), `${path.basename(root)}-rejected.asar`);
    try {
      await finished(await createPackage(path.join(root, "package"), rejected));
      assert.throws(() => verifyPackagedRendererCsp(rejected), /development code loading/u);
    } finally { await rm(rejected, { force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Vite development continues to permit the local script and stylesheet origins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-development-csp-"));
  const server = await createServer({ configFile: false, root, plugins: [productionRendererCsp()], server: { middlewareMode: true } });
  try {
    const transformed = await server.transformIndexHtml("/main-window.html", html());
    const policy = csp(transformed);
    assert.ok(policy.get("script-src")?.includes("http://localhost:*"));
    assert.ok(policy.get("style-src")?.includes("http://127.0.0.1:*"));
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("release checks reject missing policies, missing required windows and later HTML bypasses", async () => {
  assert.throws(() => assertProductionRendererCsp("<html></html>"), /exactly one CSP/u);
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-missing-csp-"));
  try {
    await mkdir(path.join(root, "build", "renderer"), { recursive: true });
    const archive = path.join(root, "missing.asar");
    await finished(await createPackage(path.join(root, "build"), archive));
    assert.throws(() => verifyPackagedRendererCsp(archive), /missing main-window/u);
    await assert.rejects(verifyRendererBuildCsp(path.join(root, "build", "renderer")), /missing main-window/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Design mode v2 Phase 3a (D11, S52, deviation 9): the main window may frame
// loopback app origins, and the release check holds every page's frame-src.
const mainFrameSrc = ["'self'", "aiden-genui:", "aiden-design:", "http://localhost:*", "http://127.0.0.1:*"];
const shippedPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const withFrameSrc = (sources: string[], base = shippedPolicy) => `${base}; frame-src ${sources.join(" ")}`;

test("the production build keeps the main window's loopback frame sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-frame-src-csp-"));
  try {
    await Promise.all(pages.map(page => writeFile(path.join(root, page), html(page === "main-window.html" ? withFrameSrc(mainFrameSrc, devPolicy) : devPolicy))));
    await writeFile(path.join(root, "entry.js"), "document.body.dataset.loaded = 'yes';");
    const output = path.join(root, "build", "renderer");
    await build({ configFile: false, root, plugins: [productionRendererCsp()], logLevel: "silent", build: {
      outDir: output, rollupOptions: { input: pages.map(page => path.join(root, page)) },
    } });
    await verifyRendererBuildCsp(output);
    const policy = csp(await readFile(path.join(output, "main-window.html"), "utf8"));
    assert.deepEqual(policy.get("frame-src"), mainFrameSrc);
    assert.deepEqual(policy.get("script-src"), ["'self'", "'wasm-unsafe-eval'"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the release check rejects a main window frame-src that is wider or missing a source", () => {
  assert.doesNotThrow(() => assertProductionRendererCsp(html(withFrameSrc([...mainFrameSrc].reverse())), "main-window.html"));
  for (const extra of ["https:", "http:", "*", "http://example.com", "http://[::1]:*"]) {
    assert.throws(() => assertProductionRendererCsp(html(withFrameSrc([...mainFrameSrc, extra])), "main-window.html"), /frame-src/u, extra);
    assert.throws(() => assertProductionRendererCsp(html(withFrameSrc([...mainFrameSrc, extra])), "build/renderer/main-window.html"), /frame-src/u, extra);
  }
  assert.throws(() => assertProductionRendererCsp(html(withFrameSrc(mainFrameSrc.filter(source => source !== "aiden-design:"))), "main-window.html"), /frame-src/u);
});

test("the release check rejects any other page that may frame the open web", () => {
  assert.doesNotThrow(() => assertProductionRendererCsp(html(withFrameSrc(["'self'", "aiden-genui:"])), "quick-chat.html"));
  assert.doesNotThrow(() => assertProductionRendererCsp(html(withFrameSrc(["'none'"])), "visual-snapshot.html"));
  for (const source of ["https:", "http:", "*", "http://example.com", "https://*.example.com", "data:"]) {
    assert.throws(() => assertProductionRendererCsp(html(withFrameSrc(["'self'", source])), "quick-chat.html"), /frame-src/u, source);
  }
  // With no frame-src, default-src decides what may be framed.
  assert.throws(() => assertProductionRendererCsp(html(shippedPolicy.replace("default-src 'self'", "default-src 'self' https:")), "pill.html"), /frame-src/u);
});
