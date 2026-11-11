import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  DESIGN_NEIGHBOURHOOD_LIMIT,
  DESIGN_OWN_WRITE_WINDOW_MS,
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

test("five quick changes to a watched file are reported once, after the quiet period", async (t) => {
  // The debounce is timing, so it runs on a fake watch and mocked timers: a busy
  // machine must not split one burst into two reports. Real files are covered below.
  const root = await workspace(t, { "design/hero.html": "<p>1</p>" });
  const watched: { emit?: (event: string, filename: string | null) => void } = {};
  const updates: DesignFilesChanged[] = [];
  const instance = new DesignFileWatcher({
    onChange: (update) => updates.push(update),
    watch: (_folder, _options, listener) => {
      watched.emit = listener as (event: string, filename: string | null) => void;
      return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as fs.FSWatcher;
    },
  });
  t.after(() => instance.clearAll());
  await instance.set("chat-1", root, ["design/hero.html"]);
  const emit = watched.emit;
  assert.ok(emit, "the page's folder is watched");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  for (let index = 0; index < 5; index += 1) {
    emit("change", "hero.html");
    t.mock.timers.tick(DESIGN_WATCH_DEBOUNCE_MS - 1);
  }
  assert.equal(updates.length, 0, "each change restarts the quiet period");
  t.mock.timers.tick(1);
  assert.deepEqual(updates, [{ chatId: "chat-1", paths: ["design/hero.html"] }]);
  t.mock.timers.tick(10 * DESIGN_WATCH_DEBOUNCE_MS);
  assert.equal(updates.length, 1, "reported once");
});

test("a write to a watched file on disk is reported", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<p>1</p>" });
  const { instance, updates } = watcher(t);
  await instance.set("chat-1", root, ["design/hero.html"]);
  await streamStarted();
  await fsp.writeFile(path.join(root, "design/hero.html"), "<p>2</p>");
  await eventually(() => updates.length > 0);
  assert.deepEqual(updates[0], { chatId: "chat-1", paths: ["design/hero.html"], at: updates[0]!.at });
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

test("the canvas's own write to a page is reported only to other chats, and the page's next change is reported", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<h1>Ship faster</h1>" });
  const { instance, updates } = watcher(t);
  await instance.set("chat-1", root, ["design/hero.html"]);
  await instance.set("chat-2", root, ["design/hero.html"]);
  await streamStarted();
  const file = path.join(root, "design/hero.html");
  const settle = instance.ownWrite("chat-1", "design/hero.html", "<h1>Ship sooner</h1>");
  await fsp.writeFile(file, "<h1>Ship sooner</h1>");
  // The file system can report one write more than once.
  await fsp.writeFile(file, "<h1>Ship sooner</h1>");
  settle(true);
  await eventually(() => updates.some((update) => update.chatId === "chat-2"));
  await sleep(DESIGN_WATCH_DEBOUNCE_MS + 200);
  assert.deepEqual(
    updates.map(({ chatId, paths }) => ({ chatId, paths })),
    [{ chatId: "chat-2", paths: ["design/hero.html"] }],
    "the chat that wrote already shows its words; another chat's frame does not",
  );

  await fsp.writeFile(file, "<h1>Ship today</h1>");
  await eventually(() => updates.some((update) => update.chatId === "chat-1"));
  assert.deepEqual(updates.filter((update) => update.chatId === "chat-1").map((update) => update.paths), [["design/hero.html"]]);
  // That report reloads the page with the newer words, so the canvas's own
  // earlier words are a change again.
  await sleep(DESIGN_WATCH_DEBOUNCE_MS + 100);
  await fsp.writeFile(file, "<h1>Ship sooner</h1>");
  await eventually(() => updates.filter((update) => update.chatId === "chat-1").length >= 2);
  assert.equal(updates.filter((update) => update.chatId === "chat-1").length, 2);
});

test("a report waits for the canvas's write in progress rather than reading the page before it lands", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<h1>Ship sooner</h1>" });
  const watched: { emit?: (event: string, filename: string | null) => void } = {};
  const updates: DesignFilesChanged[] = [];
  const instance = new DesignFileWatcher({
    onChange: (update) => updates.push(update),
    debounceMs: 5,
    watch: (_folder, _options, listener) => {
      watched.emit = listener as (event: string, filename: string | null) => void;
      return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as fs.FSWatcher;
    },
  });
  t.after(() => instance.clearAll());
  await instance.set("chat-1", root, ["design/hero.html"]);
  instance.ownWrite("chat-1", "design/hero.html", "<h1>Ship sooner</h1>")(true);
  // ⌘Z starts the next write just as the file system reports the earlier one, late.
  const settle = instance.ownWrite("chat-1", "design/hero.html", "<h1>Ship faster</h1>");
  watched.emit!("rename", "hero.html");
  await sleep(50);
  assert.deepEqual(updates, [], "nothing is read while the canvas is writing the page");
  await fsp.writeFile(path.join(root, "design/hero.html"), "<h1>Ship faster</h1>");
  settle(true);
  await sleep(50);
  assert.deepEqual(updates, [], "the page holds the canvas's own words");
});

test("after a page stops being watched, a later revert to the canvas's own words is reported", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<h1>Ship faster</h1>", "design/about.html": "<h1>About</h1>" });
  const watched: { emit?: (event: string, filename: string | null) => void } = {};
  const updates: DesignFilesChanged[] = [];
  const instance = new DesignFileWatcher({
    onChange: (update) => updates.push(update),
    debounceMs: 5,
    watch: (_folder, _options, listener) => {
      watched.emit = listener as (event: string, filename: string | null) => void;
      return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as fs.FSWatcher;
    },
  });
  t.after(() => instance.clearAll());
  const file = path.join(root, "design/hero.html");
  const A = "<h1>Ship sooner</h1>";
  const B = "<h1>Ship today</h1>";

  for (const away of [[], ["design/about.html"]]) {
    updates.splice(0);
    await instance.set("chat-1", root, ["design/hero.html", "design/about.html"]);
    // The person edits the words to A, and the file system reports the write.
    await fsp.writeFile(file, A);
    instance.ownWrite("chat-1", "design/hero.html", A)(true);
    watched.emit!("change", "hero.html");
    await sleep(50);
    assert.equal(updates.length, 0, "the canvas already shows its own words");

    // The canvas unmounts, or the page leaves the watched set, and something rewrites it to B.
    await instance.set("chat-1", root, away);
    await fsp.writeFile(file, B);
    // The frame comes back and loads B; then the file is put back to A.
    await instance.set("chat-1", root, ["design/hero.html", "design/about.html"]);
    await fsp.writeFile(file, A);
    watched.emit!("change", "hero.html");
    await eventually(() => updates.length > 0);
    assert.deepEqual(updates.map((update) => update.paths), [["design/hero.html"]], `away as ${JSON.stringify(away)}`);
  }
});

/** A watcher whose file-system events the test sends itself, as `fs.watch` would. */
function fakeWatcher(t: TestContext, options: { now?: () => number; noting?: () => Promise<void> } = {}) {
  const watched: { emit?: (event: string, filename: string | null) => void } = {};
  const updates: DesignFilesChanged[] = [];
  const instance = new DesignFileWatcher({
    onChange: (update) => updates.push(update),
    debounceMs: 5,
    ...(options.now ? { now: options.now } : {}),
    ...(options.noting ? { noting: options.noting } : {}),
    watch: (_folder, _options, listener) => {
      watched.emit = listener as (event: string, filename: string | null) => void;
      return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as fs.FSWatcher;
    },
  });
  t.after(() => instance.clearAll());
  return { instance, updates, emit: (filename: string | null) => watched.emit!("change", filename) };
}

test("an event naming no file leaves a page that holds the canvas's own write, and reports the other pages", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<h1>Ship faster</h1>", "design/about.html": "<h1>About</h1>" });
  const { instance, updates, emit } = fakeWatcher(t);
  await instance.set("chat-1", root, ["design/hero.html", "design/about.html"]);
  const written = "<h1>Ship sooner</h1>";
  const settle = instance.ownWrite("chat-1", "design/hero.html", written);
  await fsp.writeFile(path.join(root, "design/hero.html"), written);
  settle(true);
  // The file system reports the canvas's write without saying which file changed.
  emit(null);
  await eventually(() => updates.length > 0);
  await sleep(50);
  assert.deepEqual(
    updates.map((update) => update.paths),
    [["design/about.html"]],
    "the page being edited already shows its words; nothing shows the other page did not change",
  );
});

test("an event naming no file reports a page the canvas wrote once it holds other words, can't be read, or a file beside it changed", async (t) => {
  const root = await workspace(t, {
    "design/hero.html": "<h1>Ship faster</h1>",
    "design/about.html": "<h1>About</h1>",
    "design/pricing.html": "<h1>Pricing</h1>",
  });
  const { instance, updates, emit } = fakeWatcher(t);
  const pages = ["design/hero.html", "design/about.html", "design/pricing.html"];
  await instance.set("chat-1", root, pages);
  for (const [page, words] of [["design/hero.html", "<h1>Ship sooner</h1>"], ["design/about.html", "<h1>About us</h1>"], ["design/pricing.html", "<h1>Plans</h1>"]] as const) {
    const settle = instance.ownWrite("chat-1", page, words);
    await fsp.writeFile(path.join(root, page), words);
    settle(true);
  }
  // Then something else rewrites one page and removes another.
  await fsp.writeFile(path.join(root, "design/hero.html"), "<h1>Ship today</h1>");
  await fsp.rm(path.join(root, "design/about.html"));
  emit(null);
  await eventually(() => updates.length > 0);
  await sleep(50);
  assert.deepEqual(
    updates.map((update) => update.paths),
    [["design/hero.html", "design/about.html", "design/pricing.html"]],
    "pricing still holds the canvas's words, but the pages beside it changed since",
  );
});

test("an external change beside a page, reported once by an event naming no file inside the window, reloads the page", async (t) => {
  const root = await workspace(t, {
    "design/hero.html": "<link rel=stylesheet href=hero.css><h1>Ship faster</h1>",
    "design/hero.css": "h1{}",
  });
  let clock = 0;
  const { instance, updates, emit } = fakeWatcher(t, { now: () => clock });
  await instance.set("chat-1", root, ["design/hero.html"]);
  const written = "<link rel=stylesheet href=hero.css><h1>Ship sooner</h1>";
  const settle = instance.ownWrite("chat-1", "design/hero.html", written);
  await fsp.writeFile(path.join(root, "design/hero.html"), written);
  settle(true);
  await instance.noted("chat-1", "design/hero.html");

  // Someone else changes the stylesheet, and the file system's only report of it names no file.
  await fsp.writeFile(path.join(root, "design/hero.css"), "h1{color:red}");
  clock = 1;
  emit(null);
  await eventually(() => updates.length > 0);
  assert.deepEqual(updates.map((update) => update.paths), [["design/hero.html"]], "the page holds the canvas's words, but its stylesheet changed");
});

test("an event naming no file is put down to the canvas's write only for a few seconds after it", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<link rel=stylesheet href=hero.css><h1>Ship faster</h1>" });
  let clock = 0;
  const { instance, updates, emit } = fakeWatcher(t, { now: () => clock });
  await instance.set("chat-1", root, ["design/hero.html"]);
  const written = "<link rel=stylesheet href=hero.css><h1>Ship sooner</h1>";
  const settle = instance.ownWrite("chat-1", "design/hero.html", written);
  await fsp.writeFile(path.join(root, "design/hero.html"), written);
  settle(true);

  // A late report of the canvas's write, inside the window.
  clock = DESIGN_OWN_WRITE_WINDOW_MS - 1;
  emit(null);
  await sleep(50);
  assert.equal(updates.length, 0, "the page already shows its own words");

  // Past it, an unnamed event may be the stylesheet changing, so the page reloads.
  clock = DESIGN_OWN_WRITE_WINDOW_MS + 1;
  emit(null);
  await eventually(() => updates.length > 0);
  assert.deepEqual(updates.map((update) => update.paths), [["design/hero.html"]]);
});

test("a stylesheet changed while the canvas notes the files beside its page still reloads the page", async (t) => {
  const root = await workspace(t, {
    "design/hero.html": "<link rel=stylesheet href=hero.css><h1>Ship faster</h1>",
    "design/hero.css": "h1{}",
  });
  let changes = 0;
  const { instance, updates, emit } = fakeWatcher(t, {
    // Someone else changes the stylesheet after the walk has listed it and
    // before it reads its times, so the noted files already hold the change.
    noting: async () => {
      if ((changes += 1) === 1) await fsp.writeFile(path.join(root, "design/hero.css"), "h1{color:red}");
    },
  });
  await instance.set("chat-1", root, ["design/hero.html"]);
  const written = "<link rel=stylesheet href=hero.css><h1>Ship sooner</h1>";
  const settle = instance.ownWrite("chat-1", "design/hero.html", written);
  await fsp.writeFile(path.join(root, "design/hero.html"), written);
  settle(true);
  // The stylesheet's only report names no file, inside the window.
  emit(null);
  await eventually(() => updates.length > 0);
  assert.equal(changes, 1, "the walk ran once for the write");
  assert.deepEqual(updates.map((update) => update.paths), [["design/hero.html"]], "the stylesheet changed after the write began");
});

/** One file more than the walk beside a page looks at, under `folder`. */
function manyFiles(folder: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: DESIGN_NEIGHBOURHOOD_LIMIT + 1 }, (_, index) => [`${folder}/${index}.js`, "x"]));
}

test("a large hidden folder beside a page is not walked, so the canvas's own write is still recognised", async (t) => {
  const root = await workspace(t, {
    "design/hero.html": "<h1>Ship faster</h1>",
    "design/hero.css": "h1{}",
    ...manyFiles("design/.next/cache"),
  });
  // A walk that went in would fail here, and could prove nothing unchanged.
  const hidden = path.join(root, "design/.next");
  await fsp.chmod(hidden, 0o000);
  try {
    const { instance, updates, emit } = fakeWatcher(t);
    await instance.set("chat-1", root, ["design/hero.html"]);
    const written = "<h1>Ship sooner</h1>";
    const settle = instance.ownWrite("chat-1", "design/hero.html", written);
    await fsp.writeFile(path.join(root, "design/hero.html"), written);
    settle(true);
    await instance.noted("chat-1", "design/hero.html");
    emit(null);
    await sleep(50);
    assert.equal(updates.length, 0, "the page already shows its own words");
  } finally {
    await fsp.chmod(hidden, 0o755);
  }
});

test("past the most entries the walk looks at, nothing beside the page counts as unchanged", async (t) => {
  const root = await workspace(t, { "design/hero.html": "<h1>Ship faster</h1>", ...manyFiles("design/assets") });
  const { instance, updates, emit } = fakeWatcher(t);
  await instance.set("chat-1", root, ["design/hero.html"]);
  const written = "<h1>Ship sooner</h1>";
  const settle = instance.ownWrite("chat-1", "design/hero.html", written);
  await fsp.writeFile(path.join(root, "design/hero.html"), written);
  settle(true);
  await instance.noted("chat-1", "design/hero.html");
  emit(null);
  await eventually(() => updates.length > 0);
  assert.deepEqual(updates.map((update) => update.paths), [["design/hero.html"]]);
});

test("a change beside a page the canvas wrote, or a write that failed, is still reported", async (t) => {
  const root = await workspace(t, {
    "design/hero.html": "<link rel=stylesheet href=hero.css><h1>Ship faster</h1>",
    "design/hero.css": "h1{}",
  });
  const { instance, updates } = watcher(t);
  await instance.set("chat-1", root, ["design/hero.html"]);
  await streamStarted();
  const written = "<link rel=stylesheet href=hero.css><h1>Ship sooner</h1>";
  const settle = instance.ownWrite("chat-1", "design/hero.html", written);
  await fsp.writeFile(path.join(root, "design/hero.html"), written);
  settle(true);
  await fsp.writeFile(path.join(root, "design/hero.css"), "h1{color:red}");
  await eventually(() => updates.length > 0);
  assert.deepEqual(updates[0]?.paths, ["design/hero.html"], "the stylesheet changed what the page shows");

  await sleep(DESIGN_WATCH_DEBOUNCE_MS + 100);
  const before = updates.length;
  // A write the canvas gave up on leaves the file to whoever writes it next.
  instance.ownWrite("chat-1", "design/hero.html", "<h1>Never written</h1>")(false);
  await fsp.writeFile(path.join(root, "design/hero.html"), "<h1>Never written</h1>");
  await eventually(() => updates.length > before);
  assert.deepEqual(updates[before]?.paths, ["design/hero.html"]);
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
