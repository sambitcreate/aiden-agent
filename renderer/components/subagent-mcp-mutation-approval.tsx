import type { SubagentMcpMutationApprovalDetails } from "../shared/assistant";
import { Text } from "./ui";

const CLASSIFICATION_LABELS: Record<SubagentMcpMutationApprovalDetails["classification"], string> =
  {
    declared_mutating: "Server declares mutation",
    unproven_mutating: "Mutation cannot be ruled out",
  };

const PROFILE_LABELS = {
  destructive: {
    destructive: "Destructive",
    additive: "Additive hint",
    unknown: "Destructiveness unknown",
  },
  idempotency: {
    idempotent: "Idempotent hint",
    not_declared: "Idempotency not declared",
  },
  openWorld: {
    open: "Open-world hint",
    closed: "Closed-world hint",
    unknown: "World scope unknown",
  },
  taskSupport: {
    forbidden: "Task mode forbidden",
    optional: "Task mode optional",
  },
} as const;

export function subagentMcpMutationAllowLabel(
  details: SubagentMcpMutationApprovalDetails,
): "Allow once" | "Allow once after unknown outcome" {
  return details.priorUnknownEffect ? "Allow once after unknown outcome" : "Allow once";
}

export function SubagentMcpMutationApproval({
  details,
  descriptionId,
}: {
  details: SubagentMcpMutationApprovalDetails;
  descriptionId: string;
}) {
  return (
    <div
      id={descriptionId}
      className="mt-2.5 space-y-2.5"
      data-subagent-mcp-mutation-approval="true"
    >
      {details.priorUnknownEffect ? (
        <Text
          as="p"
          variant="small-strong"
          className="rounded-control bg-status-warning-surface px-3 py-2 text-status-warning"
          role="alert"
        >
          A prior call to this target has an unknown outcome. Inspect the remote system before
          allowing another attempt.
        </Text>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control bg-well px-3 py-2 text-small">
        <dt className="text-tertiary">Server</dt>
        <dd className="min-w-0 break-all font-mono text-primary">{details.serverId}</dd>
        <dt className="text-tertiary">Tool</dt>
        <dd className="min-w-0 break-all font-mono text-primary">{details.toolName}</dd>
        <dt className="text-tertiary">Classification</dt>
        <dd className="text-primary">{CLASSIFICATION_LABELS[details.classification]}</dd>
        <dt className="text-tertiary">Profile</dt>
        <dd className="text-primary">
          {[
            PROFILE_LABELS.destructive[details.destructive],
            PROFILE_LABELS.idempotency[details.idempotency],
            PROFILE_LABELS.openWorld[details.openWorld],
            PROFILE_LABELS.taskSupport[details.taskSupport],
          ].join(" · ")}
        </dd>
        <dt className="text-tertiary">Timeout</dt>
        <dd className="text-primary">{details.timeoutMs.toLocaleString("en-US")} ms</dd>
        <dt className="text-tertiary">Digests</dt>
        <dd className="min-w-0 break-all font-mono text-primary">
          connection {details.connectionDigestPrefix} · schema {details.schemaDigestPrefix} ·
          profile {details.profileDigestPrefix} · arguments {details.argumentDigestPrefix}
        </dd>
      </dl>

      <div>
        <Text as="p" variant="small-strong" color="tertiary">
          Complete canonical arguments
        </Text>
        <pre
          className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-all rounded-control bg-well px-3 py-2 text-small text-primary"
          aria-label="Complete canonical MCP mutation arguments"
        >
          {details.canonicalArguments}
        </pre>
      </div>

      <Text as="p" variant="small" color="secondary">
        The configured server controls the effect. Data outside Aiden may change. Rollback is
        unavailable. Timeout or cancellation may leave the outcome unknown. Automatic retry is
        disabled.
      </Text>
    </div>
  );
}
