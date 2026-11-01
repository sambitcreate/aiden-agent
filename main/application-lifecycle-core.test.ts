import assert from "node:assert/strict";
import test from "node:test";
import {
  createLifecycleCheck,
  shouldQuitAfterAllWindowsClose,
  shouldReleaseAuxiliaryWindows,
} from "./application-lifecycle-core.js";

test("macOS retains its conventional last-window behavior", () => {
  assert.equal(shouldQuitAfterAllWindowsClose("darwin", false), false);
});

test("Linux quits without background ownership and stays alive for Remote Access", () => {
  assert.equal(shouldQuitAfterAllWindowsClose("linux", false), true);
  assert.equal(shouldQuitAfterAllWindowsClose("linux", true), false);
});

test("a hidden helper window never keeps a closing app alive on Linux and Windows", () => {
  const helper = { auxiliary: true };
  const app = { auxiliary: false };
  // Only the hidden snapshot window is left: release it so the app can quit.
  assert.equal(shouldReleaseAuxiliaryWindows("linux", false, [helper]), true);
  assert.equal(shouldReleaseAuxiliaryWindows("win32", false, [helper, helper]), true);
  // A real window is still open, macOS keeps running, or Remote Access keeps Aiden alive.
  assert.equal(shouldReleaseAuxiliaryWindows("linux", false, [helper, app]), false);
  assert.equal(shouldReleaseAuxiliaryWindows("darwin", false, [helper]), false);
  assert.equal(shouldReleaseAuxiliaryWindows("linux", true, [helper]), false);
  // Nothing is left to release; Electron already reports every window closed.
  assert.equal(shouldReleaseAuxiliaryWindows("linux", false, []), false);
});

/**
 * Electron's order on Linux: destroying the last window fires closed,
 * window-all-closed, app.quit() and before-quit before destroy() returns.
 * before-quit ignores a quit while a lifecycle check is in flight.
 */
function lastWindowApp(check: ReturnType<typeof createLifecycleCheck>) {
  const quits: string[] = [];
  const beforeQuit = () => {
    if (check.inFlight) return;
    quits.push("shutdown");
  };
  return { quits, destroyWindow: () => beforeQuit() };
}

test("a forced close of the last window still quits the app", async () => {
  const check = createLifecycleCheck((error) => assert.fail(String(error)));
  const app = lastWindowApp(check);

  // The close path: claim the check, decide to force, release in finally.
  assert.equal(check.tryBegin(), true);
  try {
    await Promise.resolve();
    check.afterRelease(app.destroyWindow);
    assert.deepEqual(app.quits, [], "the window is not destroyed while the check is held");
  } finally {
    check.release();
  }
  assert.deepEqual(app.quits, ["shutdown"]);
});

test("only one lifecycle action holds the check, and queued work runs once", () => {
  const errors: unknown[] = [];
  const check = createLifecycleCheck((error) => errors.push(error));
  let runs = 0;
  assert.equal(check.tryBegin(), true);
  assert.equal(check.tryBegin(), false);
  check.afterRelease(() => {
    runs += 1;
  });
  check.afterRelease(() => {
    throw new Error("window already gone");
  });
  check.afterRelease(() => {
    runs += 1;
  });
  check.release();
  check.release();
  assert.equal(runs, 2);
  assert.equal(errors.length, 1);
  assert.equal(check.inFlight, false);
  assert.equal(check.tryBegin(), true);
});
