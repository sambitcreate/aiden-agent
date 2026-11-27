import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const rendererDirectory = resolve(import.meta.dirname, "../build/renderer");

const files = (await readdir(rendererDirectory, { recursive: true, withFileTypes: true }))
  .filter((entry) => !entry.isDirectory())
  .map((entry) => resolve(entry.parentPath, entry.name));

function findAsset(pattern, label) {
  const match = files.find((path) => pattern.test(path));
  assert.ok(match, `${label} must be emitted as a same-origin production asset.`);
  return match;
}

findAsset(/ghostty-vt[^/]*\.wasm$/u, "libghostty-vt");
findAsset(/ghostty-write-pty[^/]*\.wasm$/u, "libghostty-vt PTY trampoline");
findAsset(/SymbolsNerdFontMono-Regular[^/]*\.woff2$/u, "terminal Symbols Nerd Font");
