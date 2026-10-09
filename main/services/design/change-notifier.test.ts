import assert from "node:assert/strict";
import test from "node:test";
import { createProjectChangeNotifier } from "./change-notifier.js";

/** A throttle that runs at once, so each notify shows its broadcast; disposal is recorded. */
function immediateTriggers() {
  const created: Array<{ disposed: boolean }> = [];
  return {
    created,
    createTrigger: (run: () => void) => {
      const entry = { disposed: false, trigger: () => run(), dispose: () => (entry.disposed = true) };
      created.push(entry);
      return entry;
    },
  };
}

test("each project change is broadcast with its revision through one throttle per project", () => {
  const triggers = immediateTriggers();
  const events: unknown[] = [];
  const notify = createProjectChangeNotifier({
    broadcast: (event) => events.push(event),
    revisionOf: (projectId) => (projectId === "project-1" ? 4 : 9),
    createTrigger: triggers.createTrigger,
  });
  notify("project-1");
  notify("project-1");
  notify("project-2");
  assert.deepEqual(events, [
    { projectId: "project-1", revision: 4 },
    { projectId: "project-1", revision: 4 },
    { projectId: "project-2", revision: 9 },
  ]);
  assert.equal(triggers.created.length, 2);
});

test("a deleted project is announced with revision 0 and its throttle is released", () => {
  const triggers = immediateTriggers();
  const revisions = new Map([["project-1", 4]]);
  const events: unknown[] = [];
  const notify = createProjectChangeNotifier({
    broadcast: (event) => events.push(event),
    revisionOf: (projectId) => revisions.get(projectId),
    createTrigger: triggers.createTrigger,
  });
  notify("project-1");
  revisions.delete("project-1");
  notify("project-1");
  assert.deepEqual(events[events.length - 1], { projectId: "project-1", revision: 0 });
  assert.equal(triggers.created[0]!.disposed, true, "no timer outlives a deleted project");
});
