import assert from "node:assert/strict";
import test from "node:test";
import { SkillRegistry } from "./skill-registry";
import type { DiscoveredSkill } from "./types";
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

test("a skill the agent writes is in the catalog a window reads after the notice", async () => {
  let discovered: DiscoveredSkill[] = [];
  const registry = new SkillRegistry({
    getWorkspace: async (id) => ({ id, name: id, folderPath: "/trusted/ws-a", permission: "ask", createdAt: 1, updatedAt: 1 }),
    listConfigured: async () => [],
    discover: async (root) => (root === undefined ? [] : structuredClone(discovered)),
    now: () => 100,
    invocationKey: new Uint8Array(32).fill(7),
    cacheTtlMs: 5_000,
    cacheLimit: 4,
  });
  assert.deepEqual((await registry.snapshot("ws-a")).catalog, []);
  discovered = [
    {
      id: "workspace:/trusted/ws-a/.agents/skills/release/SKILL.md",
      name: "Release",
      description: "Cut a release.",
      instructions: "Steps.",
      source: "workspace",
      path: "/trusted/ws-a/.agents/skills/release/SKILL.md",
    },
  ];
  const timers: Array<() => void> = [];
  const read: Promise<string[]>[] = [];
  const notify = createWorkspaceFilesTouchedNotifier({
    invalidate: (workspaceId) => registry.invalidate(workspaceId),
    // A window re-reads the catalog as soon as the notice arrives, inside the cache's lifetime.
    broadcast: (workspaceId) =>
      read.push(registry.snapshot(workspaceId).then((snapshot) => snapshot.catalog.map((entry) => entry.name))),
    schedule: (callback) => timers.push(callback),
  });
  notify("ws-a", "write_file");
  timers.splice(0).forEach((run) => run());
  assert.deepEqual(await Promise.all(read), [["Release"]]);
});
