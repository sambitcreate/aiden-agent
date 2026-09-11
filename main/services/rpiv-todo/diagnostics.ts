import type { TodoSnapshotViewV1 } from "../../../renderer/shared/todo.js";
import type { DiagnosticEventInput } from "../diagnostics-contract.js";

/** Closed availability evidence shared by reads and generations, without chat or task data. */
export function todoSnapshotDiagnostic(snapshot: TodoSnapshotViewV1): DiagnosticEventInput | undefined {
  if (snapshot.availability !== "unavailable") return undefined;
  if (snapshot.unavailableReason === "storage_not_enabled") {
    return { level: "info", area: "generation", event: "todo-storage-disabled" };
  }
  if (snapshot.unavailableReason !== "invalid_snapshot") return undefined;
  return { level: "warn", area: "generation", event: "todo-snapshot-invalid", outcome: "failed", code: "corrupt-data" };
}
