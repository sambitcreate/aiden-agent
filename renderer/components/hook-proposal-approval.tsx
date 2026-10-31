import type * as React from "react";
import type { HookProposalApprovalDetails, HookProposalApprovalHook } from "../shared/hook-proposal-approval";
import { Text } from "./ui";

export function hookProposalHeadline(details: HookProposalApprovalDetails): string {
  return details.action === "delete" ? "Delete this hook?" : details.action === "update" ? "Change this hook?" : "Add this hook?";
}

export const HOOK_PROPOSAL_APPROVAL_FOOTER =
  "Review this exact hook. Once saved, it runs on every matching event until you turn it off in Settings → Hooks.";

function matcherLabel(matcher: string): string {
  return matcher === "" ? "Everything" : matcher;
}

function timeoutLabel(seconds: number): string {
  return `${seconds.toLocaleString("en-US")} s`;
}

function failureLabel(failClosed: boolean): string {
  return failClosed ? "Blocks the tool" : "Lets the tool run";
}

function envLabel(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "Default only";
}

/** One row of the summary grid; for an update, the old value is shown struck through beside the new one. */
function Row({
  label,
  value,
  previous,
  mono = false,
}: {
  label: string;
  value: string;
  previous?: string;
  mono?: boolean;
}): React.ReactElement {
  const changed = previous !== undefined && previous !== value;
  return (
    <>
      <dt className="text-tertiary">{label}</dt>
      <dd className={mono ? "min-w-0 break-all font-mono text-primary" : "min-w-0 break-words text-primary"} data-hook-row-changed={changed ? "true" : undefined}>
        {changed ? (
          <>
            <del className="text-tertiary" aria-label={`Was ${previous}`}>
              {previous}
            </del>{" "}
            <ins className="no-underline" aria-label={`Now ${value}`}>
              {value}
            </ins>
          </>
        ) : (
          value
        )}
      </dd>
    </>
  );
}

function CommandBlock({ label, command, ariaLabel }: { label: string; command: string; ariaLabel: string }): React.ReactElement {
  return (
    <div>
      <Text as="p" variant="small-strong" color="tertiary">
        {label}
      </Text>
      <pre
        className="mt-1 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded-control bg-well px-3 py-2 text-small text-primary"
        aria-label={ariaLabel}
      >
        {command}
      </pre>
    </div>
  );
}

/**
 * The owner's review of a hook the agent proposed: where and when it runs,
 * the complete command, and for an update what changes. "Allow once" is the
 * only way to save it; there is nothing to remember.
 */
export function HookProposalApproval({
  details,
  descriptionId,
}: {
  details: HookProposalApprovalDetails;
  descriptionId: string;
}): React.ReactElement {
  const previous: HookProposalApprovalHook | undefined = details.previous ?? undefined;
  const commandChanged = previous !== undefined && previous.command !== details.command;
  return (
    <div id={descriptionId} className="mt-2.5 space-y-2.5 text-left" data-hook-proposal-approval={details.action}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control bg-well px-3 py-2 text-small">
        <Row label="Name" value={details.name} />
        <Row label="Runs in" value={details.scopeLabel} />
        <Row label="Event" value={details.event} previous={previous?.event} mono />
        <Row label="Matches" value={matcherLabel(details.matcher)} previous={previous ? matcherLabel(previous.matcher) : undefined} mono />
        <Row label="Time limit" value={timeoutLabel(details.timeoutSeconds)} previous={previous ? timeoutLabel(previous.timeoutSeconds) : undefined} />
        {details.event === "PreToolUse" || previous?.event === "PreToolUse" ? (
          <Row label="If it fails" value={failureLabel(details.failClosed)} previous={previous ? failureLabel(previous.failClosed) : undefined} />
        ) : null}
        <Row label="Environment" value={envLabel(details.envAllow)} previous={previous ? envLabel(previous.envAllow) : undefined} mono />
        <Row label="Digest" value={details.digestPrefix} mono />
      </dl>
      {commandChanged ? (
        <>
          <CommandBlock label="Current command" command={previous.command} ariaLabel="Current hook command" />
          <CommandBlock label="New command" command={details.command} ariaLabel="Complete new hook command" />
        </>
      ) : (
        <CommandBlock
          label={details.action === "delete" ? "Command to delete" : "Complete command"}
          command={details.command}
          ariaLabel="Complete hook command"
        />
      )}
      {details.warnings.length > 0 ? (
        <ul className="space-y-1 rounded-control bg-status-warning-surface px-3 py-2 text-small text-status-warning" aria-label="Warnings">
          {details.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <Text as="p" variant="small" color="secondary">
        {details.action === "delete"
          ? "Aiden suggested removing this hook. It stops running as soon as you allow this."
          : "Aiden suggested this hook. It runs as a shell command with your user's access, outside any sandbox, each time the event matches."}
      </Text>
    </div>
  );
}
