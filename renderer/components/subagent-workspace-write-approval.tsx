import type { SubagentWorkspaceWriteApprovalDetails } from "../shared/assistant";
import { Text } from "./ui";

const OPERATION_LABELS: Record<SubagentWorkspaceWriteApprovalDetails["operation"], string> = {
  create: "Create file",
  replace: "Replace file",
  edit: "Edit file",
};

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function subagentWorkspaceWriteOperationLabel(
  operation: SubagentWorkspaceWriteApprovalDetails["operation"],
): string {
  return OPERATION_LABELS[operation];
}

export function SubagentWorkspaceWriteApproval({
  details,
  descriptionId,
}: {
  details: SubagentWorkspaceWriteApprovalDetails;
  descriptionId: string;
}) {
  const preimage =
    details.preDigestPrefix === null
      ? "Must not exist"
      : `${details.preDigestPrefix} · ${formatBytes(details.beforeBytes)}`;
  const postimage = `${details.postDigestPrefix} · ${formatBytes(details.afterBytes)}`;

  return (
    <div id={descriptionId} className="mt-2.5 space-y-2.5" data-subagent-write-approval="true">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control bg-well px-3 py-2 text-small">
        <dt className="text-tertiary">Action</dt>
        <dd className="text-primary">{subagentWorkspaceWriteOperationLabel(details.operation)}</dd>
        <dt className="text-tertiary">File</dt>
        <dd className="min-w-0 break-all font-mono text-primary">{details.path}</dd>
        <dt className="text-tertiary">Workspace</dt>
        <dd className="min-w-0 break-words text-primary">{details.workspaceLabel}</dd>
        {details.isManagedWorktree && details.worktreeLabel ? (
          <>
            <dt className="text-tertiary">Worktree</dt>
            <dd className="min-w-0 break-words text-primary">{details.worktreeLabel}</dd>
          </>
        ) : null}
        <dt className="text-tertiary">Before</dt>
        <dd className="font-mono text-primary">{preimage}</dd>
        <dt className="text-tertiary">After</dt>
        <dd className="font-mono text-primary">{postimage}</dd>
      </dl>

      <div>
        <Text as="p" variant="small-strong" color="tertiary">
          Change preview{details.diffTruncated ? " · truncated" : ""}
        </Text>
        <pre className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded-control bg-well px-3 py-2 text-small text-primary">
          {details.diffPreview}
        </pre>
      </div>

      <Text as="p" variant="small" color="secondary">
        No command will run. Aiden will refuse this change if the workspace or file has drifted
        since this preview.
      </Text>
    </div>
  );
}
