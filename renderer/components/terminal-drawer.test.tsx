import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("the workspace terminal hosts libghostty-vt instead of xterm.js", () => {
  const drawer = source("./terminal-drawer.tsx");
  const styles = source("../styles.css");
  const csp = source("../../main-window.html");
  const commands = source("../lib/command-system.tsx");
  const packageJson = source("../../package.json");
  const runtime = source("../lib/ghostty-terminal/runtime.ts");
  const wasmAssets = source("../lib/ghostty-terminal/wasm-assets.ts");

  assert.match(drawer, /GhosttyTerminalSurface\.create/u);
  assert.match(source("../lib/ghostty-terminal/surface.ts"), /from "\.\/wasm-assets"|import "\.\/wasm-assets"/u);
  assert.match(drawer, /data-command-scope="terminal"/u);
  assert.doesNotMatch(drawer, /@xterm\/xterm/u);
  assert.doesNotMatch(drawer, /from "@xterm\/addon-fit"/u);
  assert.match(styles, /\.ghostty-screen/u);
  assert.doesNotMatch(styles, /\.xterm-viewport/u);
  assert.match(csp, /wasm-unsafe-eval/u);
  assert.match(commands, /\.ghostty-screen/u);
  assert.match(runtime, /import\("\.\/wasm-assets"\)/u);
  assert.match(runtime, /`\.\/vendor\/\$\{filename\}`/u);
  assert.doesNotMatch(runtime, /new URL\("\.\/vendor\/ghostty-vt\.wasm"/u);
  assert.doesNotMatch(runtime, /new URL\("\.", import\.meta\.url\)/u);
  assert.match(wasmAssets, /new URL\("\.\/vendor\/ghostty-vt\.wasm", import\.meta\.url\)/u);
  assert.match(wasmAssets, /new URL\("\.\/vendor\/ghostty-write-pty\.wasm", import\.meta\.url\)/u);
  assert.match(source("../../vite.config.ts"), /assetsInlineLimit/u);
  assert.doesNotMatch(packageJson, /"@xterm\/xterm"/u);
  assert.doesNotMatch(packageJson, /"@xterm\/addon-fit"/u);
});
