import type { SubagentShellApprovalDetails } from "../shared/assistant";
import { Text } from "./ui";

export function SubagentShellApproval({
  details,
  descriptionId,
}: {
  details: SubagentShellApprovalDetails;
  descriptionId: string;
}) {
  return (
    <div id={descriptionId} className="mt-2.5 space-y-2.5" data-subagent-shell-approval="true">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control bg-well px-3 py-2 text-small">
        <dt className="text-tertiary">Initial cwd</dt>
        <dd className="min-w-0 break-all font-mono text-primary">{details.initialCwd}</dd>
        <dt className="text-tertiary">Shell</dt>
        <dd className="font-mono text-primary">{details.shell}</dd>
        <dt className="text-tertiary">Workspace</dt>
        <dd className="text-primary">
          {details.workspaceLabel}
          {details.worktreeLabel ? ` · worktree ${details.worktreeLabel}` : ""}
        </dd>
        <dt className="text-tertiary">Limits</dt>
        <dd className="text-primary">
          {details.timeoutMs.toLocaleString("en-US")} ms · stdout/stderr 512 KiB each
        </dd>
        <dt className="text-tertiary">Digests</dt>
        <dd className="min-w-0 break-all font-mono text-primary">
          arguments {details.argumentDigestPrefix} · root {details.rootDigestPrefix} · effect{" "}
          {details.effectDigestPrefix}
        </dd>
      </dl>
      <div>
        <Text as="p" variant="small-strong" color="tertiary">
          Complete exact command
        </Text>
        <pre
          className="mt-1 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded-control bg-well px-3 py-2 text-small text-primary"
          aria-label="Complete exact full-host command"
        >
          {details.command}
        </pre>
      </div>
      <Text as="p" variant="small" color="secondary">
        This command is not OS-sandboxed. It has the current user&apos;s filesystem, process,
        system-tool, Keychain/API, and arbitrary network reach. The minimal environment only reduces
        ambient secrets. There is no rollback, output is sent to the configured model, and
        deliberately detached processes may survive cancellation.
      </Text>
    </div>
  );
}
