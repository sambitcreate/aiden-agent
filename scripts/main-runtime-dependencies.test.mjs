import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { electronBuildOptions } from "./build-electron.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Packages that main loads through createRequire at runtime, which esbuild's
// metafile cannot see. Each must still ship in app.asar.
const RUNTIME_LOADED = new Map([
  ["minimatch", "coding-tool-matcher resolves it for glob matching in a worker"],
  ["node-pty", "terminal.ts resolves its package directory for the spawn helper"],
  ["sherpa-onnx-node", "parakeet-engine.ts requires the native transcription addon"],
  ["ws", "gemini-live/owned-sdk-connector.ts requires its WebSocket client"],
]);

const BUILTINS = new Set([...builtinModules, "electron"]);

function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return BUILTINS.has(name) || BUILTINS.has(specifier) ? null : name;
}

async function mainProcessGraph() {
  const externals = new Set();
  const bundled = new Set();
  // Same entry points and options as `npm run build`, analysed in memory.
  for (const options of electronBuildOptions({ production: true })) {
    const result = await build({ ...options, metafile: true, write: false, logLevel: "silent" });
    for (const [file, input] of Object.entries(result.metafile.inputs)) {
      const installed = file.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//u);
      if (installed) bundled.add(installed[1]);
      for (const entry of input.imports) {
        const name = entry.external ? packageName(entry.path) : null;
        if (name) externals.add(name);
      }
    }
  }
  return { externals, bundled };
}

test("every package main and preload load at runtime is installed for production", async () => {
  const [{ externals }, lockfile] = await Promise.all([
    mainProcessGraph(),
    readFile(path.join(repositoryRoot, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  assert.ok(externals.has("@earendil-works/pi-agent-core"), "the analysis sees main's external imports");

  const missing = [];
  for (const name of [...externals, ...RUNTIME_LOADED.keys()]) {
    const installed = lockfile.packages?.[`node_modules/${name}`];
    if (!installed || installed.dev === true) missing.push(name);
  }
  assert.deepEqual(missing, [], "packages main needs must not be dev-only, or app.asar will omit them");
});

test("production dependencies hold only what the main process reaches", async () => {
  const [{ externals, bundled }, manifest] = await Promise.all([
    mainProcessGraph(),
    readFile(path.join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  const unused = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !externals.has(name) && !bundled.has(name) && !RUNTIME_LOADED.has(name),
  );
  assert.deepEqual(
    unused,
    [],
    "renderer-only packages are bundled by Vite and belong in devDependencies so they stay out of app.asar",
  );
});
