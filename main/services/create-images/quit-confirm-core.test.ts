import assert from "node:assert/strict";
import test from "node:test";
import { imageRunQuitConfirmation, imageRunsAllowQuit } from "./quit-confirm-core.js";

test("no prompt without in-flight image requests", () => {
  assert.equal(imageRunQuitConfirmation(0), null);
  assert.equal(imageRunQuitConfirmation(-1), null);
});

test("the prompt counts in-flight requests, defaults to staying open and says they may be billed", () => {
  const one = imageRunQuitConfirmation(1)!;
  assert.equal(one.message, "1 image request in progress.");
  assert.match(one.detail, /cancels them.*already sent may still be billed/u);
  assert.equal(one.buttons[one.defaultId], "Keep Aiden Open");
  assert.equal(one.cancelId, one.defaultId);
  assert.equal(imageRunQuitConfirmation(3)!.message, "3 image requests in progress.");
});

test("the prompt states the real situation: no mock wording and no zero-dollar claim", () => {
  const prompt = imageRunQuitConfirmation(2)!;
  const text = [prompt.title, prompt.message, prompt.detail, ...prompt.buttons].join(" ");
  assert.doesNotMatch(text, /mock|fake|\$\s*0|free/iu);
  assert.deepEqual(prompt.buttons, ["Keep Aiden Open", "Quit and Cancel Requests"]);
  assert.equal(imageRunQuitConfirmation(1)!.buttons[1], "Quit and Cancel Request");
});

test("quitting is decided by the in-flight count and the pressed button", () => {
  const shown: string[] = [];
  const decide = (inFlight: number, button: number) =>
    imageRunsAllowQuit(inFlight, (prompt) => {
      shown.push(prompt.message);
      return button;
    });
  assert.equal(decide(0, 0), true);
  assert.deepEqual(shown, [], "no prompt when nothing is on the wire");
  assert.equal(decide(2, 0), false, "Keep Aiden Open");
  assert.equal(decide(2, 1), true, "Quit and Cancel Requests");
  assert.equal(decide(1, -1), false, "a dismissed prompt keeps Aiden open");
  assert.deepEqual(shown, ["2 image requests in progress.", "2 image requests in progress.", "1 image request in progress."]);
});
