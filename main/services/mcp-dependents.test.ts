import assert from "node:assert/strict";
import test from "node:test";
import { botsGrantingMcpServer, scheduledTasksUsingMcpServer } from "./mcp-dependents.js";

test("schedules depend on a server through exact ids or main-owned bindings, not by name", () => {
  const tasks = [
    { id: "t1", name: "Morning digest", mcpServerIds: ["linear", "notion"] },
    { id: "t2", name: "Bound", mcpServerBindings: [{ id: "linear" }] },
    { id: "t3", name: "Unrelated", mcpServerIds: ["notion"] },
    // Legacy tasks without a scope inherit every enabled server; they name none.
    { id: "t4", name: "Legacy" },
  ];
  assert.deepEqual(scheduledTasksUsingMcpServer("linear", tasks), [
    { id: "t1", name: "Morning digest" },
    { id: "t2", name: "Bound" },
  ]);
  assert.deepEqual(scheduledTasksUsingMcpServer("missing", tasks), []);
});

test("only Bots whose Custom binding includes one of the server's connections depend on it", async () => {
  const bindings: Record<string, { connections: { sourceId: string }[] } | undefined> = {
    custom: { connections: [{ sourceId: "linear" }, { sourceId: "gmail" }] },
    other: { connections: [{ sourceId: "gmail" }] },
    full: undefined,
  };
  const bots = [
    { id: "custom", name: "Planner" },
    { id: "other", name: "Mailer" },
    { id: "full", name: "Everything" },
  ];
  assert.deepEqual(
    await botsGrantingMcpServer("linear", bots, async (id) => bindings[id]),
    [{ id: "custom", name: "Planner" }],
  );
});
