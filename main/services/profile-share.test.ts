import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

// Execute the service with controlled Electron/filesystem boundaries so races
// are deterministic and never open a native menu or read a user's profile.
const serviceCode = transformSync(
  readFileSync(new URL("./profile-share.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs" },
).code;
const require = createRequire(import.meta.url);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const removed: string[] = [];
  const popups: Array<{ window: unknown; callback: () => void }> = [];
  const timers = new Set<{ run: () => void; delay: number; unref: () => void }>();
  const state = {
    cleanup: async () => {},
    write: async () => {},
    decodeError: false,
    popupError: false,
    constructorError: false,
    removeError: false,
    writes: 0,
    focusedWindow: null as unknown,
    liveWindows: [] as unknown[],
  };
  const exports = {} as { shareProfilePng: (data: unknown, parent: unknown) => Promise<void> };
  const module = { exports };
  runInNewContext(serviceCode, {
    module,
    process: { platform: "darwin" },
    setTimeout: (run: () => void, delay: number) => {
      const timer = { run, delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: (typeof timers extends Set<infer T> ? T : never)) => timers.delete(timer),
    require: (specifier: string) => {
      if (specifier === "../platform.js") return {
        logger: { warn() {} },
        nativeImage: { createFromBuffer: () => ({
          isEmpty: () => state.decodeError,
          getSize: () => ({ width: 1200, height: 1600 }),
          toPNG: () => Buffer.from("synthetic PNG"),
        }) },
        ShareMenu: class {
          constructor() {
            if (state.constructorError) throw new Error("constructor failed");
          }
          popup(options: (typeof popups)[number]) {
            if (state.popupError) throw new Error("popup failed");
            // Electron 43.1.1 lib/browser/api/menu.ts:119-130 selects by
            // BaseWindow.getAllWindows() membership, not isDestroyed().
            let window = options.window;
            const wins = state.liveWindows;
            if (!wins.includes(window)) {
              window = state.focusedWindow;
              if (!window && wins.length > 0) window = wins[0];
              if (!window) throw new Error("Cannot open Menu without a BaseWindow present");
            }
            popups.push({ ...options, window });
          }
        },
      };
      if (specifier === "./profile-share-core.js") return {
        decodeProfileSharePng: () => Buffer.from("synthetic PNG"),
        PROFILE_SHARE_WIDTH: 1200,
        PROFILE_SHARE_HEIGHT: 1600,
        MAX_SHARE_IMAGE_BYTES: 16 * 1024 * 1024,
      };
      if (specifier === "./profile-share-files.js") return {
        cleanupStaleProfileShareDirectories: () => state.cleanup(),
        createProfileShareFile: async () => {
          state.writes += 1;
          await state.write();
          return { directory: `/synthetic/share-${state.writes}`, filePath: "/synthetic/image.png" };
        },
        removeProfileShareDirectory: async (directory: string) => {
          removed.push(directory);
          if (state.removeError) throw new Error("remove failed");
        },
      };
      return require(specifier);
    },
  });
  function windowOwner(name = "owner") {
    const window = {
      name,
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      destroy() {
        this.destroyed = true;
        state.liveWindows = state.liveWindows.filter((live) => live !== this);
        if (state.focusedWindow === this) state.focusedWindow = null;
      },
    };
    state.liveWindows.push(window);
    return window;
  }
  return { state, removed, popups, timers, windowOwner, share: module.exports.shareProfilePng };
}

for (const fallback of ["focused", "first live"] as const) {
  test(`popup models Electron's ${fallback} fallback using membership independently of isDestroyed`, async () => {
    const h = harness();
    const owner = h.windowOwner();
    const first = h.windowOwner("first live replacement");
    const focused = h.windowOwner("focused replacement");
    // Deliberately separate the two mock inputs to verify that popup selects
    // by live membership. This is a harness contract, not a new lifecycle claim.
    h.state.liveWindows = [first, focused];
    h.state.focusedWindow = fallback === "focused" ? focused : null;
    assert.equal(owner.isDestroyed(), false);
    await h.share("synthetic", owner);
    assert.equal(h.popups[0].window, fallback === "focused" ? focused : first);
  });
}

test("popup models Electron's error when no live window is available", async () => {
  const h = harness();
  const owner = h.windowOwner();
  h.state.liveWindows = [];
  await assert.rejects(h.share("synthetic", owner), /Cannot open Menu without a BaseWindow/u);
  assert.deepEqual(h.removed, ["/synthetic/share-1"]);
});

for (const boundary of ["cleanup", "write"] as const) {
  for (const fallback of ["focused", "first live"] as const) {
    test(`closing the owner during ${boundary} cannot use Electron's ${fallback} fallback`, async () => {
      const h = harness();
      const entered = deferred();
      const release = deferred();
      h.state[boundary] = async () => { entered.resolve(); await release.promise; };
      const owner = h.windowOwner();
      const pending = h.share("synthetic", owner);
      await entered.promise;
      owner.destroy();
      const first = h.windowOwner("first live replacement");
      const focused = h.windowOwner("focused replacement");
      h.state.focusedWindow = fallback === "focused" ? focused : null;
      const replacement = fallback === "focused" ? focused : first;
      release.resolve();
      const error: unknown = await pending.then(() => undefined, (error: unknown) => error);
      // On the pre-fix service this reports which replacement received the
      // popup, proving both fallback paths before the owner-loss assertion.
      assert.deepEqual(h.popups.map((popup) => popup.window), []);
      assert.match(String(error), /no longer available/u);
      assert.deepEqual(h.removed, boundary === "write" ? ["/synthetic/share-1"] : []);
      assert.equal(h.timers.size, 0);
      await h.share("synthetic", replacement);
      assert.equal(h.popups.length, 1);
      assert.equal(h.popups[0].window, replacement);
    });
  }

  test(`preparation reserves admission during ${boundary} and releases it on failure`, async () => {
    const h = harness();
    const entered = deferred();
    const release = deferred();
    h.state[boundary] = async () => { entered.resolve(); await release.promise; };
    const owner = h.windowOwner();
    const pending = h.share("synthetic", owner);
    await entered.promise;
    const competing = assert.rejects(h.share("synthetic", h.windowOwner()), /current share menu/u);
    owner.destroy();
    release.resolve();
    await pending.catch(() => {});
    await competing;
    await h.share("synthetic", h.windowOwner());
    assert.equal(h.popups.length, 1);
  });
}

test("normal menu dismissal permits retry while retaining the first file for its consumer", async () => {
  const h = harness();
  const owner = h.windowOwner();
  await h.share("synthetic", owner);
  assert.equal(h.popups[0].window, owner);
  await assert.rejects(h.share("synthetic", owner), /current share menu/u);
  h.popups[0].callback();
  assert.deepEqual(h.removed, []);
  const retention = [...h.timers].find((timer) => timer.delay === 5 * 60 * 1_000);
  assert.ok(retention);
  await h.share("synthetic", owner);
  retention.run();
  assert.deepEqual(h.removed, ["/synthetic/share-1"]);
  await assert.rejects(h.share("synthetic", owner), /current share menu/u);
  h.popups[1].callback();
  await h.share("synthetic", owner);
  assert.equal(h.popups.length, 3);
});

for (const failure of ["decodeError", "constructorError", "popupError"] as const) {
  test(`${failure} releases preparation and cleans any created file`, async () => {
    const h = harness();
    h.state[failure] = true;
    await assert.rejects(h.share("synthetic", h.windowOwner()));
    assert.deepEqual(h.removed, failure === "decodeError" ? [] : ["/synthetic/share-1"]);
    assert.equal(h.timers.size, 0);
    h.state[failure] = false;
    await h.share("synthetic", h.windowOwner());
    assert.equal(h.popups.length, 1);
  });
}

test("a failed file write permits a subsequent share", async () => {
  const h = harness();
  h.state.write = async () => { throw new Error("write failed"); };
  await assert.rejects(h.share("synthetic", h.windowOwner()), /write failed/u);
  assert.equal(h.popups.length, 0);
  h.state.write = async () => {};
  await h.share("synthetic", h.windowOwner());
  assert.equal(h.popups.length, 1);
});

test("cleanup failure does not mask owner loss or retain admission", async () => {
  const h = harness();
  const owner = h.windowOwner();
  h.state.write = async () => { owner.destroy(); };
  h.state.removeError = true;
  await assert.rejects(h.share("synthetic", owner), /no longer available/u);
  assert.deepEqual(h.removed, ["/synthetic/share-1"]);
  await h.share("synthetic", h.windowOwner());
  assert.equal(h.popups.length, 1);
});
