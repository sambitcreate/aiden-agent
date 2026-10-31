import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

const happy = new Window();
Object.assign(globalThis, { window: happy, document: happy.document });

const guard = await import("./lifecycle-guard.js");

/** Main's view of the renderer: what it reads, and the globals it calls through executeJavaScript. */
function guardRevision(): number {
  return Number(document.documentElement.dataset.aidenGuardRevision);
}

test("an approval main armed in time lets exactly one unload through", () => {
  guard.setRendererLifecycleGuard({ dirty: true });
  const revision = guardRevision();
  assert.equal(window.__aidenArmUnloadApproval?.(revision, Date.now() + 5_000, Date.now() + 8_000), true);
  assert.equal(guard.consumeRendererLifecycleUnloadApproval(), true);
  assert.equal(guard.consumeRendererLifecycleUnloadApproval(), false);
  guard.setRendererLifecycleGuard({ dirty: false });
});

test("an arm call that runs after main stopped waiting installs no approval", () => {
  guard.setRendererLifecycleGuard({ dirty: true });
  const revision = guardRevision();
  const armBy = 1_000;
  assert.equal(guard.armRendererLifecycleUnloadApproval(revision, armBy, armBy + 3_000, armBy + 1), false);
  // The person then declines the repeated confirmation; a later reload is still vetoed.
  assert.equal(guard.rendererLifecycleGuarded(), true);
  assert.equal(guard.consumeRendererLifecycleUnloadApproval(armBy + 2), false);
  guard.setRendererLifecycleGuard({ dirty: false });
});

test("a declined action withdraws an approval its earlier arm call installed", () => {
  guard.setRendererLifecycleGuard({ dirty: true });
  const revision = guardRevision();
  assert.equal(window.__aidenArmUnloadApproval?.(revision, Date.now() + 5_000, Date.now() + 8_000), true);
  window.__aidenClearUnloadApproval?.();
  assert.equal(guard.rendererLifecycleGuarded(), true);
  assert.equal(guard.consumeRendererLifecycleUnloadApproval(), false);
  guard.setRendererLifecycleGuard({ dirty: false });
});

test("an approval nobody used expires instead of authorizing a later unload", () => {
  guard.setRendererLifecycleGuard({ dirty: true });
  const revision = guardRevision();
  assert.equal(guard.armRendererLifecycleUnloadApproval(revision, 5_000, 8_000, 4_000), true);
  assert.equal(guard.consumeRendererLifecycleUnloadApproval(8_001), false);
  guard.setRendererLifecycleGuard({ dirty: false });
});

test("an approval for an older guard revision is refused", () => {
  guard.setRendererLifecycleGuard({ dirty: true });
  const stale = guardRevision();
  guard.setRendererLifecycleGuard({ saving: true });
  assert.equal(guard.armRendererLifecycleUnloadApproval(stale, Date.now() + 5_000, Date.now() + 8_000), false);
  assert.equal(guard.consumeRendererLifecycleUnloadApproval(), false);
  guard.setRendererLifecycleGuard({ dirty: false, saving: false });
});
