// When a chat counts as answering, which decides whether the viewer's own pull
// request comment is the agent's echo. Runs come from a real, small host run
// registry; time and timers are faked.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { HostRunRegistry } from "../host-run-registry.js";
import { AnsweringRuns } from "./answering-runs.js";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 11, 12, 0, 0);

function harness(t: test.TestContext, maxRuns: number) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  t.after(() => mock.timers.reset());
  const busy = new Set<string>();
  const answering = new AnsweringRuns({ isChatBusy: (chatId) => busy.has(chatId) });
  const registry = new HostRunRegistry({ now: () => Date.now(), maxRuns });
  registry.onChange((summary, removed) => answering.hostRunChanged(summary, removed));
  const begin = (runId: string, chatId: string) => {
    registry.begin({ runId, chatId, origin: "renderer" });
    mock.timers.tick(1);
  };
  // A mocked tick only runs timers that were already due, so step a minute at a time.
  const advanceMinutes = (minutes: number) => {
    for (let minute = 0; minute < minutes; minute += 1) mock.timers.tick(MINUTE);
  };
  return { busy, answering, registry, begin, advanceMinutes };
}

test("an answer evicted while running keeps the agent's comments its own until the chat goes idle", (t) => {
  const { busy, answering, registry, begin, advanceMinutes } = harness(t, 2);
  busy.add("chat-1");
  begin("run-1", "chat-1");
  begin("run-2", "chat-2");
  begin("run-3", "chat-3");
  assert.equal(registry.summary("run-1"), undefined, "the registry evicted chat-1's running answer");

  advanceMinutes(30);
  assert.equal(answering.wasAnswering("chat-1", Date.now()), true, "a comment the answer posts now is its own");

  // The answer ends; the registry no longer knows the run and reports nothing.
  busy.delete("chat-1");
  const endedAt = Date.now();
  advanceMinutes(1);
  assert.equal(answering.wasAnswering("chat-1", endedAt), true, "comments posted while it ran stay its own");
  advanceMinutes(10);
  assert.equal(
    answering.wasAnswering("chat-1", Date.now()),
    false,
    "once the chat is idle, a later comment is the person's again",
  );
});

test("a finished answer counts from its start to its end, with a minute's slack", (t) => {
  const { answering, registry, begin, advanceMinutes } = harness(t, 4);
  const startedAt = Date.now();
  begin("run-1", "chat-1");
  advanceMinutes(5);
  registry.settle("run-1");
  const endedAt = Date.now();
  advanceMinutes(10);
  assert.equal(answering.wasAnswering("chat-1", startedAt + 2 * MINUTE), true);
  assert.equal(answering.wasAnswering("chat-1", endedAt + MINUTE / 2), true);
  assert.equal(answering.wasAnswering("chat-1", endedAt + 2 * MINUTE), false);
  assert.equal(answering.wasAnswering("chat-2", startedAt + 2 * MINUTE), false, "other chats were not answering");
});

test("deleting a chat forgets an evicted answer that was still running", (t) => {
  const { busy, answering, begin, advanceMinutes } = harness(t, 1);
  busy.add("chat-1");
  begin("run-1", "chat-1");
  begin("run-2", "chat-2");
  answering.deleteChat("chat-1");
  advanceMinutes(5);
  assert.equal(answering.wasAnswering("chat-1", Date.now()), false);
});
