import assert from "node:assert/strict";
import test from "node:test";
import { todoSnapshotDiagnostic } from "./diagnostics.js";
import { createDiagnosticEvent } from "../diagnostics-contract.js";

test("task diagnostics distinguish storage policy from invalid snapshots without content", () => {
  for (const reason of ["storage_not_enabled", "invalid_snapshot"] as const) {
    const diagnostic = todoSnapshotDiagnostic({
      version: 1, chatId: "private-chat", availability: "unavailable",
      unavailableReason: reason, tasks: [],
    });
    assert.ok(diagnostic);
    const event = createDiagnosticEvent(diagnostic, "session-test");
    assert.equal(event.event, reason === "storage_not_enabled" ? "todo-storage-disabled" : "todo-snapshot-invalid");
    assert.equal(event.outcome, reason === "storage_not_enabled" ? undefined : "failed");
    assert.doesNotMatch(JSON.stringify(event), /private-chat|tasks|chatId/u);
  }
  assert.equal(todoSnapshotDiagnostic({
    version: 1, chatId: "private-chat", availability: "ready", tasks: [],
  }), undefined);
  assert.equal(todoSnapshotDiagnostic({
    version: 1, chatId: "private-chat", availability: "unavailable", tasks: [],
  }), undefined);
});
