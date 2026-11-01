import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  DESIGN_WATCH_DEBOUNCE_MS,
  DESIGN_WATCH_LIMIT,
  DesignFileWatcher,
  type DesignFilesChanged,
} from "./watch.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** macOS starts a file-system event stream asynchronously; a write in its first moments can go unseen. */
const streamStarted = () => sleep(100);

/** Waits up to two seconds for a report, so a busy machine does not fail the test. */
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await sleep(25);
}

async function workspace(t: TestContext, files: Record<string, string>) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aiden-design-watch-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), content);
  }
  // Let the file system settle so creating the fixture is not reported as a change.
  await sleep(50);
  return root;
}

function watcher(t: TestContext, options: { allowed?: (chatId: string, root: string) => boolean } = {}) {
  const updates: Array<DesignFilesChanged & { at: number }> = [];
  let open = 0;
  const instance = new DesignFileWatcher({
    onChange: (update) => updates.push({ ...update, at: Date.now() }),
    allowed: options.allowed,
    watch: (folder, watchOptions, listener) => {
      const handle = fs.watch(folder, watchOptions, listener);
      open += 1;
      const close = handle.close.bind(handle);
      handle.close = () => {
        open -= 1;
        close();
      };
      return handle;
    },
  });
  t.after(() => instance.clearAll());
  return { instance, updates, open: () => open };
}

test("five quick writes to a watched file are reported once, after the quiet period", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<p>1</p>" });
  const { instance, updates } = watcher(t);
  await instance.set("chat-1", root, ["design/hero.html"]);
  await streamStarted();
  const started = Date.now();
  for (let index = 0; index < 5; index += 1) {
    await fsp.writeFile(path.join(root, "design/hero.html"), `<p>${index}</p>`);
    await sleep(10);
  }
  await sleep(450);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { chatId: "chat-1", paths: ["design/hero.html"], at: updates[0]!.at });
  const delay = updates[0]!.at - started;
  assert.ok(delay >= DESIGN_WATCH_DEBOUNCE_MS, `reported after ${delay} ms`);
  assert.ok(delay <= 400 + 50, `reported after ${delay} ms`);
});

test("a change to an asset in the same folder reports the watched page", async (t) => {
  const root = await workspace(t, {
    "design/hero.html": "<link rel=stylesheet href=hero.css>",
    "design/hero.css": "body{}",
    "design/assets/logo.svg": "<svg/>",
    "other/page.html": "<p></p>",
  });
  const { instance, updates } = watcher(t);
  await instance.set("chat-1", root, ["design/hero.html", "other/page.html"]);
  await streamStarted();
  await fsp.writeFile(path.join(root, "design/hero.css"), "body{color:red}");
  await eventually(() => updates.length >= 1);
  assert.deepEqual(
    updates.map((update) => update.paths),
    [["design/hero.html"]],
  );
  await fsp.writeFile(path.join(root, "design/assets/logo.svg"), "<svg></svg>");
  await eventually(() => updates.length >= 2);
  assert.deepEqual(updates[1]?.paths, ["design/hero.html"], "assets in a subfolder count too");
});

test("rewriting one page reloads only that page, not the other pages in its folder", async (t) => {
  const root = await workspace(t, {
    "design/hero.html": "<p>hero</p>",
    "design/about.html": "<p>about</p>",
  });
  const { instance, updates } = watcher(t);
  await instance.set("chat-1", root, ["design/hero.html", "design/about.html"]);
  await streamStarted();
  await fsp.writeFile(path.join(root, "design/hero.html"), "<p>hero 2</p>");
  await eventually(() => updates.length >= 1);
  await sleep(DESIGN_WATCH_DEBOUNCE_MS + 100);
  assert.deepEqual(
    updates.map((update) => update.paths),
    [["design/hero.html"]],
  );
});

test("replacing the watched set closes the old watchers", async (t) => {
  const root = await workspace(t, { "a/one.html": "1", "b/two.html": "2" });
  const { instance, updates, open } = watcher(t);
  await instance.set("chat-1", root, ["a/one.html"]);
  assert.equal(open(), 1);
  await instance.set("chat-1", root, ["b/two.html"]);
  assert.equal(open(), 1, "the old folder's watcher is closed");
  await streamStarted();
  await fsp.writeFile(path.join(root, "a/one.html"), "changed");
  await sleep(400);
  assert.equal(updates.length, 0);
  await fsp.writeFile(path.join(root, "b/two.html"), "changed");
  await eventually(() => updates.length >= 1);
  assert.deepEqual(
    updates.map((update) => update.paths),
    [["b/two.html"]],
  );
  await instance.set("chat-1", root, []);
  assert.equal(open(), 0);
});

test("at most 50 paths are watched", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`design/f${index}.html`, "x"]));
  const root = await workspace(t, files);
  const { instance, updates } = watcher(t);
  const paths = Object.keys(files);
  await instance.set("chat-1", root, paths);
  await streamStarted();
  await fsp.writeFile(path.join(root, "design/f59.html"), "changed");
  await eventually(() => updates.length >= 1);
  await sleep(DESIGN_WATCH_DEBOUNCE_MS * 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.paths.length, DESIGN_WATCH_LIMIT);
  assert.deepEqual(updates[0]!.paths, paths.slice(0, 50));
});

test("unsafe paths and folders that lead outside the workspace are not watched", async (t) => {
  const outside = await workspace(t, { "secret.html": "s" });
  const root = await workspace(t, { "design/page.html": "p" });
  await fsp.symlink(outside, path.join(root, "escape"));
  const { instance, updates, open } = watcher(t);
  await instance.set("chat-1", root, ["../x.html", ".git/config", "escape/secret.html", "missing/page.html"]);
  assert.equal(open(), 0);
  await fsp.writeFile(path.join(outside, "secret.html"), "changed");
  await sleep(400);
  assert.equal(updates.length, 0);
});

test("a chat that may no longer frame its workspace stops being watched", async (t) => {
  const root = await workspace(t, { "design/page.html": "p" });
  let allowed = true;
  const { instance, updates, open } = watcher(t, { allowed: () => allowed });
  await instance.set("chat-1", root, ["design/page.html"]);
  allowed = false;
  await fsp.writeFile(path.join(root, "design/page.html"), "changed");
  await sleep(400);
  assert.equal(updates.length, 0);
  assert.equal(open(), 0);
});
