import type { SubagentRunGrantApprovalDetails } from "../shared/assistant";
import { Text } from "./ui";

export function SubagentRunGrantApproval({
  details,
  descriptionId,
}: {
  details: SubagentRunGrantApprovalDetails;
  descriptionId: string;
}) {
  return (
    <div id={descriptionId} className="mt-2.5 space-y-2.5" data-subagent-run-grant="true">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control bg-well px-3 py-2 text-small">
        <dt className="text-tertiary">Subagent</dt>
        <dd className="min-w-0 break-words text-primary">{details.childLabel}</dd>
        <dt className="text-tertiary">Workspace</dt>
        <dd className="min-w-0 break-words text-primary">{details.workspaceLabel}</dd>
        {details.isManagedWorktree && details.worktreeLabel ? (
          <>
            <dt className="text-tertiary">Worktree</dt>
            <dd className="min-w-0 break-words text-primary">{details.worktreeLabel}</dd>
          </>
        ) : null}
        <dt className="text-tertiary">Scope</dt>
        <dd className="text-primary">This subagent run only</dd>
      </dl>
      <Text as="p" variant="small" color="secondary">
        {details.lane === "write"
          ? "Allow this subagent to write and edit files for this run. Later file changes will not ask again. Aiden checks each target and refuses changes if the file or workspace has drifted."
          : "Allow this subagent to run commands for this run. Later commands will not ask again. Commands have the macOS user’s full host and network access; they are not OS sandboxed and cannot be rolled back. Detached processes may survive cancellation."}
      </Text>
    </div>
  );
}
