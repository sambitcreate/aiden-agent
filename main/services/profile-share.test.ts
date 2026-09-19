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
            // Electron falls back to another window when the requested owner
            // is no longer in its live window list; it need not throw here.
            const requested = options.window as { isDestroyed: () => boolean };
            popups.push({ ...options, window: requested.isDestroyed() ? state.focusedWindow : requested });
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
  return { state, removed, popups, timers, share: module.exports.shareProfilePng };
}

function windowOwner() {
  return { destroyed: false, isDestroyed() { return this.destroyed; } };
}

for (const boundary of ["cleanup", "write"] as const) {
  test(`closing the owner during ${boundary} cannot redirect sharing to a replacement window`, async () => {
    const h = harness();
    const entered = deferred();
    const release = deferred();
    h.state[boundary] = async () => { entered.resolve(); await release.promise; };
    const owner = windowOwner();
    const pending = h.share("synthetic", owner);
    await entered.promise;
    owner.destroyed = true;
    h.state.focusedWindow = windowOwner();
    release.resolve();
    await assert.rejects(pending, /no longer available/u);
    assert.equal(h.popups.length, 0);
    assert.deepEqual(h.removed, boundary === "write" ? ["/synthetic/share-1"] : []);
    assert.equal(h.timers.size, 0);
    await h.share("synthetic", h.state.focusedWindow);
    assert.equal(h.popups.length, 1);
    assert.equal(h.popups[0].window, h.state.focusedWindow);
  });

  test(`preparation reserves admission during ${boundary} and releases it on failure`, async () => {
    const h = harness();
    const entered = deferred();
    const release = deferred();
    h.state[boundary] = async () => { entered.resolve(); await release.promise; };
    const owner = windowOwner();
    const pending = h.share("synthetic", owner);
    await entered.promise;
    const competing = assert.rejects(h.share("synthetic", windowOwner()), /current share menu/u);
    owner.destroyed = true;
    release.resolve();
    await pending.catch(() => {});
    await competing;
    await h.share("synthetic", windowOwner());
    assert.equal(h.popups.length, 1);
  });
}

test("normal menu dismissal permits retry while retaining the first file for its consumer", async () => {
  const h = harness();
  const owner = windowOwner();
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
    await assert.rejects(h.share("synthetic", windowOwner()));
    assert.deepEqual(h.removed, failure === "decodeError" ? [] : ["/synthetic/share-1"]);
    assert.equal(h.timers.size, 0);
    h.state[failure] = false;
    await h.share("synthetic", windowOwner());
    assert.equal(h.popups.length, 1);
  });
}

test("a failed file write permits a subsequent share", async () => {
  const h = harness();
  h.state.write = async () => { throw new Error("write failed"); };
  await assert.rejects(h.share("synthetic", windowOwner()), /write failed/u);
  assert.equal(h.popups.length, 0);
  h.state.write = async () => {};
  await h.share("synthetic", windowOwner());
  assert.equal(h.popups.length, 1);
});

test("cleanup failure does not mask owner loss or retain admission", async () => {
  const h = harness();
  const owner = windowOwner();
  h.state.write = async () => { owner.destroyed = true; };
  h.state.removeError = true;
  await assert.rejects(h.share("synthetic", owner), /no longer available/u);
  assert.deepEqual(h.removed, ["/synthetic/share-1"]);
  await h.share("synthetic", windowOwner());
  assert.equal(h.popups.length, 1);
});
