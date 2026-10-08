import assert from "node:assert/strict";
import test from "node:test";
import { ImageQuitCoverage, imageRunQuitConfirmation, imageRunsAllowQuit } from "./quit-confirm-core.js";

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

test("requests the user already agreed to cancel are not asked about again, new ones are", () => {
  const shown: string[] = [];
  const decide = (inFlight: number, covered: number) =>
    imageRunsAllowQuit(inFlight, (prompt) => (shown.push(prompt.message), 1), covered);
  assert.equal(decide(2, 2), true);
  assert.equal(decide(1, 2), true, "some finished since the confirmation");
  assert.deepEqual(shown, []);
  assert.equal(decide(3, 2), true, "the answer was Quit, but a run started mid-close so it asks first");
  assert.deepEqual(shown, ["3 image requests in progress."]);
});

test("window-close coverage across the quit it triggers", () => {
  const coverage = new ImageQuitCoverage();
  const live = { inFlight: 0 };
  const asked: string[] = [];
  /** What the no-window before-quit does: consume the coverage, then ask about anything it did not cover. */
  const beforeQuit = (): boolean =>
    imageRunsAllowQuit(
      live.inFlight,
      (prompt) => (asked.push(prompt.message), 1),
      coverage.consume(),
    );
  const prompts = () => asked.length;

  // Confirmed 2 on a close that quits: the quit it triggers does not ask again.
  live.inFlight = 2;
  coverage.recordWindowCloseConfirmation(true, 2);
  assert.equal(beforeQuit(), true);
  assert.equal(prompts(), 0);

  // The coverage is consumed once: a later quit with requests in flight asks.
  assert.equal(beforeQuit(), true);
  assert.equal(prompts(), 1);

  // A close that does not quit the app (macOS) covers nothing, whatever the user pressed.
  coverage.recordWindowCloseConfirmation(false, 2);
  assert.equal(beforeQuit(), true);
  assert.equal(prompts(), 2);

  // A close confirmed with nothing in flight covers nothing: a run that starts mid-close is asked about.
  live.inFlight = 0;
  coverage.recordWindowCloseConfirmation(true, 0);
  live.inFlight = 1;
  assert.equal(beforeQuit(), true);
  assert.equal(prompts(), 3);

  // A close that was confirmed and then aborted (veto, retry) leaves no stale coverage behind.
  live.inFlight = 2;
  coverage.recordWindowCloseConfirmation(true, 2);
  coverage.clear();
  assert.equal(beforeQuit(), true);
  assert.equal(prompts(), 4);

  // A run that started mid-close beyond the confirmed count is asked about, with the live count.
  coverage.recordWindowCloseConfirmation(true, 2);
  live.inFlight = 3;
  assert.equal(beforeQuit(), true);
  assert.equal(asked[asked.length - 1], "3 image requests in progress.");
});

test("an aborted close clears the coverage even when it is retried", () => {
  const coverage = new ImageQuitCoverage();
  coverage.recordWindowCloseConfirmation(true, 2);
  coverage.clear();
  assert.equal(coverage.consume(), 0);
  coverage.recordWindowCloseConfirmation(true, 2);
  assert.equal(coverage.consume(), 2);
  assert.equal(coverage.consume(), 0, "consumed once");
});
