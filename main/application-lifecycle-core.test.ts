import assert from "node:assert/strict";
import test from "node:test";
import {
  createLifecycleCheck,
  createUpdateInstallIntent,
  settleUpdateInstallQuit,
  whenLifecycleCheckFree,
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

test("an accepted update install that never reaches the quit is withdrawn", async () => {
  const outcomes: Array<[string, () => Promise<boolean>, number]> = [
    ["the quit began", async () => true, 0],
    ["another lifecycle action held the check", async () => false, 1],
    ["the quit failed", async () => { throw new Error("window gone"); }, 1],
  ];
  for (const [name, quit, expected] of outcomes) {
    let withdrawn = 0;
    const errors: unknown[] = [];
    await settleUpdateInstallQuit(quit, () => { withdrawn += 1; }, (error) => errors.push(error));
    assert.equal(withdrawn, expected, name);
    assert.equal(errors.length, name === "the quit failed" ? 1 : 0, name);
  }
});

test("deferred quit work waits for the action holding the check, whoever that is", () => {
  const check = createLifecycleCheck(() => assert.fail("no action should throw"));
  const ran: string[] = [];
  assert.equal(check.tryBegin(), true);
  whenLifecycleCheckFree(check, () => { ran.push("install quit"); });
  assert.equal(ran.length, 0, "a quit already deciding owns the outcome until it releases");

  // The first queued action takes the check, so the next must keep waiting.
  whenLifecycleCheckFree(check, () => { ran.push("second"); });
  check.release();
  assert.deepEqual(ran, ["install quit", "second"]);

  whenLifecycleCheckFree(check, () => { ran.push("free"); });
  assert.deepEqual(ran, ["install quit", "second", "free"], "a free check runs at once");
});

test("work queued behind a check retaken during release runs after that release", () => {
  const check = createLifecycleCheck(() => assert.fail("no action should throw"));
  const ran: string[] = [];
  assert.equal(check.tryBegin(), true);
  whenLifecycleCheckFree(check, () => {
    ran.push("takes the check");
    assert.equal(check.tryBegin(), true);
  });
  whenLifecycleCheckFree(check, () => { ran.push("waits for it"); });
  check.release();
  assert.deepEqual(ran, ["takes the check"]);
  check.release();
  assert.deepEqual(ran, ["takes the check", "waits for it"]);
});

function installIntent() {
  const state = { shutdownStarted: false, announced: 0 };
  const intent = createUpdateInstallIntent({
    shutdownStarted: () => state.shutdownStarted,
    onWithdrawn: () => { state.announced += 1; },
  });
  return { state, intent };
}

test("a renderer veto keeps the install for its retry, however many callers withdraw", () => {
  const { state, intent } = installIntent();
  intent.arm();
  intent.retryScheduled();
  // The vetoed quit's own cleanup and the wrapper around it both withdraw.
  intent.withdraw();
  intent.withdraw();
  assert.equal(intent.armed, true);
  assert.equal(state.announced, 0);
  intent.retryBegan();
  assert.equal(intent.take(), true, "the retried quit installs the update");
  assert.equal(intent.armed, false);
});

test("a retry the person then declines withdraws the install once", () => {
  const { state, intent } = installIntent();
  intent.arm();
  intent.retryScheduled();
  intent.retryBegan();
  intent.withdraw();
  intent.withdraw();
  assert.equal(intent.armed, false);
  assert.equal(state.announced, 1);
  assert.equal(intent.take(), false, "a later ordinary quit installs nothing");
});

test("a shutdown under way keeps the install, and failing it lets the withdrawal through", () => {
  const { state, intent } = installIntent();
  intent.arm();
  state.shutdownStarted = true;
  intent.withdraw();
  assert.equal(intent.armed, true);
  state.shutdownStarted = false;
  intent.withdraw();
  assert.equal(intent.armed, false);
});
