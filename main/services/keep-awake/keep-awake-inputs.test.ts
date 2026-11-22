import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS,
  backgroundJobKeepAwakeInput,
  doneWhenKeepAwakeInput,
  hostRunKeepAwakeInput,
  usageLimitKeepAwakeInput,
  type KeepAwakeUsageLimitWait,
} from "./keep-awake-inputs.js";
import { HostRunRegistry } from "../host-run-registry.js";

const NOW = 5_000_000;
const minutes = (count: number) => count * 60_000;

test("a working run holds; a run waiting on an approval or a question doesn't", () => {
  const registry = new HostRunRegistry({ now: () => NOW });
  const input = hostRunKeepAwakeInput({ runs: () => registry.list(), waits: () => [] });
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  assert.deepEqual(input.read(NOW).reasons, [{ kind: "chat", id: "chat-1" }]);

  for (const state of ["needs_approval", "needs_input", "done", "failed", "cancelled"]) {
    const fixed = hostRunKeepAwakeInput({ runs: () => [{ chatId: "chat-2", state }], waits: () => [] });
    assert.deepEqual(fixed.read(NOW).reasons, [], state);
  }
});

test("a run waiting on a usage limit far away doesn't hold until the last 10 minutes", () => {
  let waits: KeepAwakeUsageLimitWait[] = [{ owner: { kind: "chat", id: "chat-1" }, nextTryAt: NOW + minutes(45) }];
  const runs = hostRunKeepAwakeInput({ runs: () => [{ chatId: "chat-1", state: "working" }], waits: () => waits });
  const limits = usageLimitKeepAwakeInput(() => waits);

  const far = runs.read(NOW);
  assert.deepEqual(far.reasons, []);
  assert.equal(far.recheckAt, NOW + minutes(35));
  assert.deepEqual(limits.read(NOW).reasons, []);
  assert.equal(limits.read(NOW).recheckAt, NOW + minutes(35));

  const later = NOW + minutes(35);
  assert.deepEqual(runs.read(later).reasons, [{ kind: "chat", id: "chat-1" }]);
  assert.deepEqual(limits.read(later).reasons, [{ kind: "usage-limit", id: "chat:chat-1" }]);

  // A Bot's wait ending soon holds too; it never hides an ordinary chat's run.
  waits = [{ owner: { kind: "bot", id: "chat-1" }, nextTryAt: NOW + KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS }];
  assert.deepEqual(runs.read(NOW).reasons, [{ kind: "chat", id: "chat-1" }]);
  assert.deepEqual(limits.read(NOW).reasons, [{ kind: "usage-limit", id: "bot:chat-1" }]);
});

test("a build job holds; a server, a finished job and a leftover background process don't", () => {
  const input = backgroundJobKeepAwakeInput(() => [
    { id: "job_build", state: "running" },
    { id: "job_tests", state: "running", ports: [] },
    { id: "job_server", state: "running", ports: [5173] },
    { id: "job_done", state: "exited" },
    { id: "job_leftover", state: "running", origin: "command" },
  ]);
  assert.deepEqual(input.read(NOW).reasons, [
    { kind: "job", id: "job_build" },
    { kind: "job", id: "job_tests" },
  ]);
});

test("a done-when check holds only while its command runs", () => {
  const input = doneWhenKeepAwakeInput(() => [
    { chatId: "chat-1", state: "running" },
    { chatId: "chat-2", state: "waiting" },
    { chatId: "chat-3", state: "passed" },
  ]);
  assert.deepEqual(input.read(NOW).reasons, [{ kind: "check", id: "chat-1" }]);
});
