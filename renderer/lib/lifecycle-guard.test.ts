import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRendererLifecycleGuard,
  rendererLifecycleGuarded,
  setRendererLifecycleGuard,
} from "./lifecycle-guard.js";

test("renderer lifecycle guards aggregate independent owners", () => {
  clearRendererLifecycleGuard("create-images-test");
  clearRendererLifecycleGuard("environment-test");

  setRendererLifecycleGuard("create-images-test", { dirty: true, saving: false });
  assert.equal(rendererLifecycleGuarded(), true);

  setRendererLifecycleGuard("environment-test", {
    dirty: false,
    gitBusy: false,
    saving: false,
  });
  assert.equal(rendererLifecycleGuarded(), true);

  clearRendererLifecycleGuard("environment-test");
  assert.equal(rendererLifecycleGuarded(), true);
  clearRendererLifecycleGuard("create-images-test");
  assert.equal(rendererLifecycleGuarded(), false);
});
