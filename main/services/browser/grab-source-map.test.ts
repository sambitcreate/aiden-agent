import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedLocalSourceMapFilePath,
  decodeSourceMapMappings,
  isAllowedSourceMapUrl,
  LocalGrabSourceMapResolver,
  lookupOriginalPosition,
  normalizeBundlerSourcePath,
  parseDebugStackFrames,
} from "./grab-source-map.js";

test("decodeSourceMapMappings and lookupOriginalPosition decode standard Source Map v3 VLQ segments", () => {
  // Line 1: genCol=0 -> src=0, origLine=10 (U = +10), origCol=4 (I = +4)
  // Line 2: genCol=2 (E) -> src=0 (A), origLine=12 (E = +2), origCol=8 (I = +4); genCol=10 (Q = +8) -> src=1 (C), origLine=0 (Z = -12), origCol=0 (R = -8)
  const indexed = decodeSourceMapMappings({
    version: 3,
    sourceRoot: "webpack-internal:///(app-pages-browser)/./",
    sources: ["src/components/Hero.tsx", "src/components/Button.tsx"],
    mappings: "AAUI;EAEI,QCZR",
  });

  const pos1 = lookupOriginalPosition(indexed, 1, 1);
  assert.deepEqual(pos1, {
    source: "webpack-internal:///(app-pages-browser)/./src/components/Hero.tsx",
    line: 11,
    column: 5,
  });

  const pos2 = lookupOriginalPosition(indexed, 2, 5);
  assert.deepEqual(pos2, {
    source: "webpack-internal:///(app-pages-browser)/./src/components/Hero.tsx",
    line: 13,
    column: 9,
  });

  const pos3 = lookupOriginalPosition(indexed, 2, 12);
  assert.deepEqual(pos3, {
    source: "webpack-internal:///(app-pages-browser)/./src/components/Button.tsx",
    line: 1,
    column: 1,
  });

  assert.equal(lookupOriginalPosition(indexed, 99, 1), null);
});

test("isAllowedSourceMapUrl strictly permits loopback and file URLs while rejecting remote/LAN/credentialed hosts", () => {
  assert.equal(isAllowedSourceMapUrl("http://localhost:3000/app.js.map"), true);
  assert.equal(isAllowedSourceMapUrl("https://127.0.0.1:8443/chunk.js"), true);
  assert.equal(isAllowedSourceMapUrl("http://[::1]:5173/src/main.tsx"), true);
  assert.equal(isAllowedSourceMapUrl("file:///Users/dev/app/dist/bundle.js"), true);

  assert.equal(isAllowedSourceMapUrl("https://example.com/app.js.map"), false);
  assert.equal(isAllowedSourceMapUrl("http://192.168.1.50:3000/app.js"), false);
  assert.equal(isAllowedSourceMapUrl("https://127.0.0.1.evil.test/app.js"), false);
  assert.equal(isAllowedSourceMapUrl("http://user:pass@localhost:3000/app.js"), false);
  assert.equal(isAllowedSourceMapUrl("javascript:alert(1)"), false);
});

test("normalizeBundlerSourcePath strips Webpack, Turbopack, Vite, RSC, and file:// prefixes and relativizes inside workspace", () => {
  const root = "/Users/dev/project";
  assert.equal(
    normalizeBundlerSourcePath("webpack-internal:///(app-pages-browser)/./src/Hero.tsx?v=12", root),
    "src/Hero.tsx",
  );
  assert.equal(
    normalizeBundlerSourcePath("turbopack:///[project]/app/page.tsx", root),
    "app/page.tsx",
  );
  assert.equal(
    normalizeBundlerSourcePath("rsc://React/Server/webpack-internal:///(rsc)/./app/layout.tsx", root),
    "app/layout.tsx",
  );
  assert.equal(
    normalizeBundlerSourcePath("http://localhost:5173/@fs/Users/dev/project/src/Button.tsx?t=999", root),
    "src/Button.tsx",
  );
  assert.equal(
    normalizeBundlerSourcePath("file:///Users/dev/project/src/Card.tsx", root),
    "src/Card.tsx",
  );
  // Path outside workspace stays clean without escaping with ..
  assert.equal(
    normalizeBundlerSourcePath("/tmp/external/Widget.tsx", root),
    "/tmp/external/Widget.tsx",
  );
});

test("LocalGrabSourceMapResolver symbolicates React 19 _debugStack via loopback inline/external source maps and never fetches remote URLs", async () => {
  const fetchedUrls: string[] = [];
  const fetchOptions: RequestInit[] = [];
  const sourceMapJson = JSON.stringify({
    version: 3,
    sources: ["turbopack:///[project]/src/components/LandingHeroClient.tsx"],
    mappings: "AAUI",
  });
  const inlineData = `data:application/json;base64,${Buffer.from(sourceMapJson, "utf8").toString("base64")}`;

  const resolver = new LocalGrabSourceMapResolver({
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (init) fetchOptions.push(init);
      if (url === "http://localhost:3000/chunks/hero.js") {
        return new Response(`console.log(1);\n//# sourceMappingURL=${inlineData}\n`, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch,
  });

  const debugStack = [
    "Error: react-stack-top-frame",
    "    at jsxDEV (http://localhost:3000/node_modules/react_jsx-dev-runtime.js:12:3)",
    "    at LandingHeroClient (http://localhost:3000/chunks/hero.js:1:1)",
  ].join("\n");

  const resolved = await resolver.resolveSourceHint({ debugStack }, "/Users/dev/app");
  assert.deepEqual(resolved, {
    filePath: "src/components/LandingHeroClient.tsx",
    line: 11,
    column: 5,
    symbolicated: true,
  });
  assert.deepEqual(fetchedUrls, ["http://localhost:3000/chunks/hero.js"]);
  assert.equal(fetchOptions[0]?.redirect, "error");

  // Second call hits LRU cache without re-fetching.
  const cached = await resolver.resolveSourceHint({ debugStack }, "/Users/dev/app");
  assert.deepEqual(cached, resolved);
  assert.equal(fetchedUrls.length, 1);

  // Remote URL must NEVER be fetched; gracefully returns un-symbolicated fallback.
  const remoteStack = "Error\n    at Widget (https://cdn.example.com/bundle.js:10:5)";
  const remote = await resolver.resolveSourceHint({ debugStack: remoteStack });
  assert.equal(fetchedUrls.length, 1);
  assert.deepEqual(remote, {
    filePath: "https://cdn.example.com/bundle.js",
    line: 10,
    column: 5,
    symbolicated: false,
  });
});

test("parseDebugStackFrames skips react-dom and node_modules frames", () => {
  const stack = [
    "Error",
    "    at renderWithHooks (http://localhost:3000/node_modules/react-dom.js:100:5)",
    "    at MyCard (http://localhost:3000/src/MyCard.tsx:24:11)",
  ].join("\n");
  assert.deepEqual(parseDebugStackFrames(stack), [
    { url: "http://localhost:3000/src/MyCard.tsx", line: 24, column: 11 },
  ]);
});

test("LocalGrabSourceMapResolver restricts file:// reads to script/map extensions inside workspaceRoot", async () => {
  const readPaths: string[] = [];
  const sourceMapJson = JSON.stringify({
    version: 3,
    sources: ["src/Widget.tsx"],
    mappings: "AAUI",
  });
  const resolver = new LocalGrabSourceMapResolver({
    readFileImpl: async (filePath: string) => {
      readPaths.push(filePath);
      if (filePath.endsWith(".map")) return Buffer.from(sourceMapJson, "utf8");
      return Buffer.from("//# sourceMappingURL=bundle.js.map\n", "utf8");
    },
  });

  // Non-script/map file extension is rejected before reading disk.
  assert.equal(allowedLocalSourceMapFilePath("file:///etc/passwd", "/Users/dev/app"), null);
  await resolver.resolveSourceHint(
    { debugStack: "Error\n    at Evil (file:///etc/passwd:1:1)" },
    "/Users/dev/app",
  );
  assert.deepEqual(readPaths, []);

  // Out-of-workspace script is rejected before reading disk.
  assert.equal(allowedLocalSourceMapFilePath("file:///Users/other/secret.js", "/Users/dev/app"), null);
  assert.equal(
    allowedLocalSourceMapFilePath("file:///Users/dev/app/../other/secret.js", "/Users/dev/app"),
    null,
  );
  await resolver.resolveSourceHint(
    { debugStack: "Error\n    at Evil (file:///Users/other/secret.js:1:1)" },
    "/Users/dev/app",
  );
  assert.deepEqual(readPaths, []);

  // In-workspace .js + .map succeeds.
  const resolved = await resolver.resolveSourceHint(
    { debugStack: "Error\n    at Widget (file:///Users/dev/app/dist/bundle.js:1:1)" },
    "/Users/dev/app",
  );
  assert.deepEqual(resolved, {
    filePath: "src/Widget.tsx",
    line: 11,
    column: 5,
    symbolicated: true,
  });
  assert.equal(readPaths.length, 2);
});
