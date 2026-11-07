// The aiden-design scheme serves only plain workspace files: these tests use
// real temp directories and real symlinks, because containment is decided on
// disk, not on the path text.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { designUrl, resolveDesignFile } from "./resolve-core.js";

async function workspace(t: TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-resolve-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "design"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, "design", "a.html"), "<p>a</p>");
  await fs.writeFile(path.join(root, "design", "my page.html"), "<p>spaced</p>");
  await fs.writeFile(path.join(base, "secret.txt"), "secret");
  await fs.writeFile(path.join(outside, "x.html"), "<p>outside</p>");
  return { base, root, outside };
}

test("a workspace HTML file is served as UTF-8 HTML with its real path and size", async (t) => {
  const { root } = await workspace(t);
  const result = await resolveDesignFile(root, "design/a.html");
  assert.deepEqual(result, {
    ok: true,
    absolute: path.join(root, "design", "a.html"),
    mimeType: "text/html; charset=utf-8",
    size: 8,
  });
});

test("percent-encoded segments are decoded before lookup", async (t) => {
  const { root } = await workspace(t);
  const result = await resolveDesignFile(root, "design/my%20page.html");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.absolute, path.join(root, "design", "my page.html"));
  assert.equal((await resolveDesignFile(root, "/design/a.html")).ok, true);
});

test("traversal, encoded or not, never leaves the workspace", async (t) => {
  const { root } = await workspace(t);
  for (const urlPath of [
    "%2e%2e/secret.txt",
    "%2E%2E/secret.txt",
    "../secret.txt",
    "design/../../secret.txt",
    "design/%2e%2e/%2e%2e/secret.txt",
    "design%2f..%2f..%2fsecret.txt",
    "design%5c..%5c..%5csecret.txt",
    "design/./a.html",
    "design//a.html",
    "",
    "%",
    "design/a.html%00.txt",
  ]) {
    assert.deepEqual(await resolveDesignFile(root, urlPath), { ok: false, status: 404 }, urlPath);
  }
});

test("a symlinked file pointing outside the workspace is not served", async (t) => {
  const { base, root } = await workspace(t);
  await fs.symlink(path.join(base, "secret.txt"), path.join(root, "design", "escape.txt"));
  await fs.symlink(path.join(base, "secret.txt"), path.join(root, "design", "escape.html"));
  assert.deepEqual(await resolveDesignFile(root, "design/escape.txt"), { ok: false, status: 404 });
  assert.deepEqual(await resolveDesignFile(root, "design/escape.html"), { ok: false, status: 404 });
});

test("a symlinked directory pointing outside the workspace is not served", async (t) => {
  const { outside, root } = await workspace(t);
  await fs.symlink(outside, path.join(root, "design", "inner"));
  assert.deepEqual(await resolveDesignFile(root, "design/inner/x.html"), {
    ok: false,
    status: 404,
  });
});

test("a symlink that stays inside the workspace is served at its real path", async (t) => {
  const { root } = await workspace(t);
  await fs.symlink(path.join(root, "design", "a.html"), path.join(root, "design", "alias.html"));
  const result = await resolveDesignFile(root, "design/alias.html");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.absolute, path.join(root, "design", "a.html"));
});

test("an in-workspace symlink to a hidden or unsupported file is not served", async (t) => {
  const { root } = await workspace(t);
  await fs.writeFile(path.join(root, ".env"), "TOKEN=1");
  await fs.writeFile(path.join(root, "key.pem"), "key");
  await fs.symlink(path.join(root, ".env"), path.join(root, "design", "env.txt"));
  await fs.symlink(path.join(root, "key.pem"), path.join(root, "design", "key.txt"));
  assert.deepEqual(await resolveDesignFile(root, "design/env.txt"), { ok: false, status: 404 });
  assert.deepEqual(await resolveDesignFile(root, "design/key.txt"), { ok: false, status: 404 });
});

test("missing files, directories and extensionless files are not found", async (t) => {
  const { root } = await workspace(t);
  await fs.mkdir(path.join(root, "design", "pages"));
  await fs.writeFile(path.join(root, "design", "README"), "readme");
  for (const urlPath of ["design/missing.html", "design", "design/pages", "design/README"]) {
    assert.deepEqual(await resolveDesignFile(root, urlPath), { ok: false, status: 404 }, urlPath);
  }
});

test("dotfiles, dot-folders and unsupported types are forbidden without reading disk", async (t) => {
  const { root } = await workspace(t);
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, ".git", "config"), "[core]");
  await fs.writeFile(path.join(root, "design", ".env"), "TOKEN=1");
  await fs.writeFile(path.join(root, "design", "a.exe"), "MZ");
  for (const urlPath of [".git/config", "design/.env", "design/a.exe", "%2egit/config"]) {
    assert.deepEqual(await resolveDesignFile(root, urlPath), { ok: false, status: 403 }, urlPath);
  }
  // Refused before any lookup: the same answer when nothing exists at all.
  assert.deepEqual(await resolveDesignFile("/nonexistent-aiden-root", "design/a.exe"), {
    ok: false,
    status: 403,
  });
});

test("a file above 8 MiB is refused as too large; 8 MiB exactly is served", async (t) => {
  const { root } = await workspace(t);
  await fs.writeFile(path.join(root, "design", "big.png"), Buffer.alloc(9 * 1024 * 1024));
  await fs.writeFile(path.join(root, "design", "edge.png"), Buffer.alloc(8 * 1024 * 1024));
  assert.deepEqual(await resolveDesignFile(root, "design/big.png"), { ok: false, status: 413 });
  const edge = await resolveDesignFile(root, "design/edge.png");
  assert.equal(edge.ok && edge.mimeType, "image/png");
});

test("a workspace root that no longer exists serves nothing", async (t) => {
  const { root } = await workspace(t);
  assert.deepEqual(await resolveDesignFile(path.join(root, "gone"), "design/a.html"), {
    ok: false,
    status: 404,
  });
});

test("designUrl encodes each segment and round-trips through resolveDesignFile", async (t) => {
  const { root } = await workspace(t);
  const grant = "a".repeat(52);
  const url = designUrl(grant, "design/my page.html");
  assert.equal(url, `aiden-design://${grant}/design/my%20page.html`);
  const rawPath = url.slice(`aiden-design://${grant}/`.length);
  assert.equal((await resolveDesignFile(root, rawPath)).ok, true);
  assert.equal(designUrl(grant, "a#b?.html"), `aiden-design://${grant}/a%23b%3F.html`);
});
