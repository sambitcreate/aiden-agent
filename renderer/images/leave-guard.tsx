import { useBlocker } from "@tanstack/react-router";
import * as React from "react";
import { AlertDialog } from "../components/ui";
import type { WorkflowController } from "./use-workflow-controller";

/**
 * Leaving the editor saves first. When the save fails (changed elsewhere, invalid, or the save
 * itself failed), navigation stops and the user chooses: stay and resolve it, or discard the edits.
 */
export function LeaveGuard({ title, controller }: { title: string; controller: Pick<WorkflowController, "settle" | "discard"> }) {
  const { settle, discard } = controller;
  const shouldBlockFn = React.useCallback(async () => !(await settle()), [settle]);
  const blocker = useBlocker({ shouldBlockFn, withResolver: true, enableBeforeUnload: false });
  return (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
      title="Leave without saving?"
      description={`Changes to “${title}” could not be saved. If you leave now, they are discarded.`}
      confirmLabel="Discard Changes"
      confirmVariant="destructive"
      onConfirm={() => {
        discard();
        blocker.proceed?.();
      }}
    />
  );
}
