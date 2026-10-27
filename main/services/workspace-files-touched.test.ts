import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceFilesTouchedNotifier } from "./workspace-files-touched";

function harness() {
  const sent: string[] = [];
  const timers: Array<() => void> = [];
  const notify = createWorkspaceFilesTouchedNotifier({
    broadcast: (workspaceId) => sent.push(workspaceId),
    schedule: (callback) => timers.push(callback),
  });
  const flush = () => timers.splice(0).forEach((run) => run());
  return { sent, notify, flush };
}

test("a burst of edits in one workspace sends one notice after the burst", () => {
  const { sent, notify, flush } = harness();
  notify("ws-a", "edit_file");
  notify("ws-a", "write_file");
  notify("ws-a", "run_command");
  assert.deepEqual(sent, []);
  flush();
  assert.deepEqual(sent, ["ws-a"]);
  notify("ws-a", "edit_file");
  flush();
  assert.deepEqual(sent, ["ws-a", "ws-a"]);
});

test("each workspace gets its own notice", () => {
  const { sent, notify, flush } = harness();
  notify("ws-a", "edit_file");
  notify("ws-b", "codemode");
  flush();
  assert.deepEqual(sent.sort(), ["ws-a", "ws-b"]);
});

test("reads and chats without a folder send nothing", () => {
  const { sent, notify, flush } = harness();
  notify("ws-a", "read_file");
  notify("ws-a", "web_search");
  notify(undefined, "write_file");
  flush();
  assert.deepEqual(sent, []);
});
