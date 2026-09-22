import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const rendererDirectory = resolve(import.meta.dirname, "../build/renderer");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
}

const files = await listFiles(rendererDirectory);

function findAsset(pattern, label) {
  const match = files.find((path) => pattern.test(path));
  assert.ok(match, `${label} must be emitted as a same-origin production asset.`);
  return match;
}

findAsset(/ghostty-vt[^/]*\.wasm$/u, "libghostty-vt");
findAsset(/ghostty-write-pty[^/]*\.wasm$/u, "libghostty-vt PTY trampoline");
findAsset(/SymbolsNerdFontMono-Regular[^/]*\.woff2$/u, "terminal Symbols Nerd Font");
