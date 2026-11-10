import assert from "node:assert/strict";
import test from "node:test";
import { LiveActivityStore } from "./live-activity.js";
import { LiveAppControlController } from "./live-app-control.js";
import { LiveSessionBus } from "./live-session-bus.js";

function setup() {
  const bus = new LiveSessionBus();
  const activity = new LiveActivityStore();
  const controller = new LiveAppControlController({ bus, activity, lingerMs: 0, confirmTimeoutMs: 5_000 });
  const context = (abort = new AbortController()) => ({ sessionId: "s1", signal: abort.signal, commit: () => {} });
  return { bus, activity, controller, context };
}

test("tapping Confirm on the ribbon answers yes; the prompt then leaves the ribbon", async () => {
  const { activity, controller, context } = setup();
  const answer = controller.handle({ op: "confirm", label: "Delete chat? — “Delete”" }, context());
  const shown = activity.get();
  assert.equal(shown?.kind, "confirm");
  if (shown?.kind === "confirm") shown.confirm();
  assert.deepEqual(await answer, { ok: true, confirmed: true, reason: "confirmed" });
  assert.equal(activity.get(), null);
  controller.dispose();
});

test("the ribbon's Take over ends the watch and refuses actions until the user speaks", async () => {
  const { bus, activity, controller, context } = setup();
  assert.deepEqual(await controller.handle({ op: "admit", label: "Pressing “Settings”" }, context()), { ok: true, remaining: 29 });
  const watch = controller.handle({ op: "watch" }, context());
  const shown = activity.get();
  assert.equal(shown?.kind === "acting" ? shown.label : null, "Pressing “Settings”");
  if (shown?.kind === "acting") shown.takeOver();
  assert.deepEqual(await watch, { ok: true, takenOver: true });
  assert.equal(activity.get(), null);
  assert.equal(controller.get().acting, false);
  const refused = await controller.handle({ op: "admit", label: "Pressing “Save”" }, context());
  assert.equal((refused.error as { code: string }).code, "taken_over");
  bus.publishVoiceInput("go on");
  assert.equal((await controller.handle({ op: "admit", label: "Pressing “Save”" }, context())).ok, true);
  controller.dispose();
});

test("main ending the watch clears the outline, and a guarded prompt is never replaced by acting", async () => {
  const { activity, controller, context } = setup();
  const abort = new AbortController();
  await controller.handle({ op: "admit", label: "Typing in “Search”" }, context());
  const watch = controller.handle({ op: "watch" }, context(abort));
  abort.abort();
  assert.deepEqual(await watch, { ok: true, ended: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(controller.get().acting, false);
  assert.equal(activity.get(), null);

  const confirm = controller.handle({ op: "confirm", label: "Press “Sign out”" }, context());
  // A late admit or watch must not hide the question the user has to answer.
  await controller.handle({ op: "admit", label: "Pressing “Other”" }, context());
  assert.equal(activity.get()?.kind, "confirm");
  controller.reset();
  assert.deepEqual(await confirm, { ok: true, confirmed: false, reason: "cancelled" });
  assert.equal(activity.get(), null, "a session that ends leaves nothing on the ribbon");
  controller.dispose();
});

test("the user's input between Live's steps takes over until they speak; before Live acts it changes nothing", async () => {
  const { bus, controller, context } = setup();
  // The user types and clicks as usual while Live hasn't acted for them.
  controller.userInput({ type: "keydown", key: "a", isTrusted: true });
  controller.userInput({ type: "pointerdown", isTrusted: true });
  assert.equal((await controller.handle({ op: "admit", label: "Pressing “Settings”" }, context())).ok, true);
  const abort = new AbortController();
  const watch = controller.handle({ op: "watch" }, context(abort));
  abort.abort();
  await watch;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(controller.get().acting, false, "between steps no outline shows");
  controller.userInput({ type: "wheel", isTrusted: true });
  const refused = await controller.handle({ op: "admit", label: "Pressing “Save”" }, context());
  assert.equal((refused.error as { code: string }).code, "taken_over", "the next step is refused");
  bus.publishVoiceInput("ok, carry on");
  assert.equal((await controller.handle({ op: "admit", label: "Pressing “Save”" }, context())).ok, true);
  controller.dispose();
});

test("while Live waits for an OK, the user's own click, scroll, touch or key elsewhere refuses it and takes over", async () => {
  for (const input of [
    { type: "pointerdown", isTrusted: true },
    { type: "wheel", isTrusted: true },
    { type: "touchstart", isTrusted: true },
    { type: "keydown", key: "Enter", isTrusted: true },
    { type: "keydown", key: "Backspace", isTrusted: true },
  ]) {
    const { bus, activity, controller, context } = setup();
    const answer = controller.handle({ op: "confirm", label: "Delete chat? — “Delete”" }, context());
    controller.userInput(input);
    assert.deepEqual(await answer, { ok: true, confirmed: false, reason: "taken_over" }, JSON.stringify(input));
    assert.equal(activity.get(), null, "the question leaves the ribbon");
    const refused = await controller.handle({ op: "admit", label: "Pressing “Delete”" }, context());
    assert.equal((refused.error as { code: string }).code, "taken_over", "Live waits for new words");
    bus.publishVoiceInput("ok, go on");
    assert.equal((await controller.handle({ op: "admit", label: "Pressing “Delete”" }, context())).ok, true);
    controller.dispose();
  }
});

test("while Live waits for an OK, Escape refuses it and takes over too", async () => {
  const { controller, context } = setup();
  const answer = controller.handle({ op: "confirm", label: "Press “Sign out”" }, context());
  controller.userInput({ type: "keydown", key: "Escape", isTrusted: true });
  assert.deepEqual(await answer, { ok: true, confirmed: false, reason: "cancelled" });
  const refused = await controller.handle({ op: "admit", label: "Pressing “Sign out”" }, context());
  assert.equal((refused.error as { code: string }).code, "taken_over");
  controller.dispose();
});

test("pressing or keying the ribbon's Confirm or Cancel answers it; Tab to reach them and Live's own events change nothing", async () => {
  const { activity, controller, context } = setup();
  const answer = controller.handle({ op: "confirm", label: "Delete chat? — “Delete”" }, context());
  let settled = false;
  void answer.then(() => (settled = true));
  controller.userInput({ type: "keydown", key: "Tab", isTrusted: true });
  controller.userInput({ type: "keydown", key: "Shift", isTrusted: true });
  controller.userInput({ type: "pointerdown", isTrusted: false });
  controller.userInput({ type: "pointerdown", isTrusted: true, answersConfirmation: true });
  controller.userInput({ type: "keydown", key: "Enter", isTrusted: true, answersConfirmation: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, "still waiting for the answer");
  const shown = activity.get();
  assert.equal(shown?.kind, "confirm");
  if (shown?.kind === "confirm") shown.confirm();
  assert.deepEqual(await answer, { ok: true, confirmed: true, reason: "confirmed" });

  const second = controller.handle({ op: "confirm", label: "Press “Sign out”" }, context());
  controller.userInput({ type: "keydown", key: " ", isTrusted: true, answersConfirmation: true });
  const again = activity.get();
  if (again?.kind === "confirm") again.cancel();
  assert.deepEqual(await second, { ok: true, confirmed: false, reason: "cancelled" });
  assert.equal((await controller.handle({ op: "admit", label: "Pressing “Other”" }, context())).ok, true, "Cancel is an answer, not a take-over");
  controller.dispose();
});
