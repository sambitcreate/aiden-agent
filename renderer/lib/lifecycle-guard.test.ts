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

/** What main's close-guard read sees for the quit prompt. */
function mainView() {
  const dataset = document.documentElement.dataset;
  return {
    dirty: dataset.aidenDirty === "1",
    saving: dataset.aidenSaving === "1",
    dirtySources: dataset.aidenDirtySources ?? "",
    savingSources: dataset.aidenSavingSources ?? "",
    imagesLabel: dataset.aidenImagesLabel ?? null,
  };
}

test("an unsaved image workflow is named as the dirty source, with its title", () => {
  guard.setRendererLifecycleGuard({ dirty: true, saving: false }, { source: "images", label: "Product shots" });
  assert.deepEqual(mainView(), { dirty: true, saving: false, dirtySources: "images", savingSources: "", imagesLabel: "Product shots" });
  guard.setRendererLifecycleGuard({ dirty: false, saving: false }, { source: "images" });
  assert.deepEqual(mainView(), { dirty: false, saving: false, dirtySources: "", savingSources: "", imagesLabel: null });
});

test("the Files editor clearing its own state keeps an image workflow's unsaved changes guarded", () => {
  guard.setRendererLifecycleGuard({ dirty: true }, { source: "images", label: "Moodboard" });
  guard.setRendererLifecycleGuard({ dirty: true });
  assert.equal(mainView().dirtySources, "editor images");
  // Switching workspace clears the editor's dirty and saving state only.
  guard.setRendererLifecycleGuard({ dirty: false, saving: false });
  assert.equal(guard.rendererLifecycleGuarded(), true);
  assert.deepEqual(mainView(), { dirty: true, saving: false, dirtySources: "images", savingSources: "", imagesLabel: "Moodboard" });
  guard.setRendererLifecycleGuard({ dirty: false }, { source: "images" });
  assert.equal(guard.rendererLifecycleGuarded(), false);
});

test("a change in one source invalidates an approval even while another keeps the guard dirty", () => {
  guard.setRendererLifecycleGuard({ dirty: true });
  const revision = guardRevision();
  assert.equal(guard.armRendererLifecycleUnloadApproval(revision, Date.now() + 5_000, Date.now() + 8_000), true);
  // The person approved discarding the file's edits; an image workflow then became unsaved.
  guard.setRendererLifecycleGuard({ dirty: true }, { source: "images", label: "Later" });
  assert.equal(guard.consumeRendererLifecycleUnloadApproval(), false);
  guard.setRendererLifecycleGuard({ dirty: false }, { source: "images" });
  guard.setRendererLifecycleGuard({ dirty: false });
});
