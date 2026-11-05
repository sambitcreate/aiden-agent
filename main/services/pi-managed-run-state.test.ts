import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_PI_MANAGED_RUN_STATE,
  piManagedQueueBlock,
  transitionPiManagedRun,
  type PiManagedRunEvent,
  type PiManagedRunState,
} from "./pi-managed-run-state.js";

const run = (events: PiManagedRunEvent["type"][], from = INITIAL_PI_MANAGED_RUN_STATE) =>
  events.reduce<PiManagedRunState>((state, type) => transitionPiManagedRun(state, { type }), from);

test("queued input is accepted only between agent start and a closing event", () => {
  const block = (events: PiManagedRunEvent["type"][]) => piManagedQueueBlock(run(events), false);
  assert.equal(block([]), "not-active");
  assert.equal(block(["run-started"]), "not-active");
  assert.equal(block(["run-started", "agent-started"]), undefined);
  assert.equal(block(["run-started", "agent-started", "queue-closed"]), "not-active");
  assert.equal(block(["run-started", "agent-started", "run-settled"]), "not-active");
});

test("a disposed harness takes no input from a live run", () => {
  assert.equal(piManagedQueueBlock(run(["run-started", "agent-started"]), true), "not-active");
});

test("a Stop before the run starts cancels that run once, not the one after", () => {
  const stopped = run(["stop-requested", "run-started", "agent-started"]);
  assert.equal(stopped.stop, "requested");
  assert.equal(stopped.queue, "closed", "A stopped run never opens its queue");
  const next = run(["run-settled", "run-started", "agent-started"], stopped);
  assert.equal(next.stop, "none");
  assert.equal(piManagedQueueBlock(next, false), undefined);
});

test("a Stop during a run does not carry into the next one", () => {
  const state = run(["run-started", "agent-started", "stop-requested", "run-settled", "run-started"]);
  assert.equal(state.stop, "none");
});

test("a parent abort reports cancelled while the queue is still open", () => {
  const state = run(["run-started", "agent-started", "parent-aborted"]);
  assert.equal(piManagedQueueBlock(state, false), "cancelled");
});

test("reset forgets a Stop that never reached a run", () => {
  const state = run(["stop-requested", "reset", "run-started"]);
  assert.equal(state.stop, "none");
});

test("a shutdown is recorded for one finish only", () => {
  const stopping = run(["run-started", "shutdown-requested", "stop-requested"]);
  assert.equal(stopping.shutdownInterrupted, true);
  assert.equal(run(["shutdown-recorded"], stopping).shutdownInterrupted, false);
});

test("generated event orders never admit input after a Stop in the same run", () => {
  const types: PiManagedRunEvent["type"][] = [
    "run-started", "agent-started", "queue-closed", "stop-requested", "shutdown-requested",
    "parent-aborted", "shutdown-recorded", "run-settled", "reset",
  ];
  let seed = 20261104;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sequence = 0; sequence < 500; sequence += 1) {
    let state = INITIAL_PI_MANAGED_RUN_STATE;
    let stoppedThisRun = false;
    const trace: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const type = types[next() % types.length]!;
      // The harness refuses reset while a run is live.
      if (type === "reset" && state.running) continue;
      trace.push(type);
      const before = state;
      state = transitionPiManagedRun(state, { type });
      if (type === "run-started") stoppedThisRun = before.stopBeforeRun;
      if (type === "reset") stoppedThisRun = false;
      if (state.running && (type === "stop-requested" || type === "parent-aborted")) stoppedThisRun = true;
      if (state.running && stoppedThisRun) {
        assert.notEqual(piManagedQueueBlock(state, false), undefined, trace.join(" "));
      }
      if (!state.running) assert.notEqual(piManagedQueueBlock(state, false), undefined, trace.join(" "));
    }
  }
});
