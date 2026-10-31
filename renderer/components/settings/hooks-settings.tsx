// Settings → Hooks: the owner's view of every hook, what it runs and whether
// it may run. Approving, testing and deleting go through main, which checks
// every argument; Test executes the command, so it runs only from its button.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  Field,
  FieldSet,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  Textarea,
  toast,
} from "../ui";
import { hooksApi } from "../../lib/ipc";
import { cn } from "../../lib/ui-utils";
import {
  groupHooksByScope,
  HOOK_DEFAULT_TIMEOUT_SECONDS,
  HOOK_EVENT_DESCRIPTIONS,
  HOOK_EVENTS,
  HOOK_MAX_COMMAND_LENGTH,
  HOOK_MAX_MATCHER_LENGTH,
  HOOK_MAX_NAME_LENGTH,
  HOOK_MAX_TIMEOUT_SECONDS,
  HOOK_TOOL_EVENTS,
  hookMatcherLabel,
  hookNeedsApproval,
  hookScopeKey,
  hookScopeLabel,
  hookShortDigest,
  hookStatusPresentation,
  hookSwitchAvailable,
  hookSwitchOn,
  parseHookTimeoutField,
  type HookEvent,
  type HookListing,
  type HookProposal,
  type HookRunRecord,
  type HookSaveRequest,
  type HooksOverview,
  type HookTestResult,
  type HooksWorkspaceLabel,
} from "../../shared/hooks-settings";

export const HOOKS_QUERY_KEY = ["hooks", "overview"] as const;
const runLogKey = (hookId: string) => ["hooks", "runLog", hookId] as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function eventAndMatcher(listing: Pick<HookListing, "event" | "configuredEvent" | "matcher">): string {
  const event = listing.event === "unknown" ? listing.configuredEvent : listing.event;
  const matcher = hookMatcherLabel(listing);
  return matcher ? `${event} · ${matcher}` : event;
}

function CommandBlock({ command, className }: { command: string; className?: string }) {
  return (
    <code
      data-hook-command=""
      className={cn(
        "block whitespace-pre-wrap break-all rounded-control bg-control/60 px-2.5 py-1.5 font-mono text-small text-primary select-text",
        className,
      )}
    >
      {command}
    </code>
  );
}

function StatusBadge({ listing }: { listing: Pick<HookListing, "status"> }) {
  const status = hookStatusPresentation(listing);
  return <Badge color={status.color}>{status.label}</Badge>;
}

function sourceLabel(listing: Pick<HookListing, "source">): string {
  switch (listing.source) {
    case "settings":
      return "Added in Settings";
    case "workspace-file":
      return "From the repo’s .aiden/hooks.json";
    case "agent":
      return "Proposed by the agent";
    case "bot":
      return "A Bot’s hook";
  }
}

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const RUN_RESULT_LABEL: Record<HookRunRecord["result"], { label: string; color: "green" | "red" | "warning" | "blue" }> = {
  ok: { label: "OK", color: "green" },
  blocked: { label: "Blocked", color: "warning" },
  asked: { label: "Asked you", color: "blue" },
  error: { label: "Failed", color: "red" },
};

// ---------------------------------------------------------------------------
// Row

function HookRow({
  listing,
  enabled,
  busy,
  onOpen,
  onToggle,
  onApprove,
}: {
  listing: HookListing;
  enabled: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onApprove: () => void;
}) {
  const unsupported = listing.status === "unsupported";
  return (
    <Field
      label={
        <button
          type="button"
          onClick={onOpen}
          className="-mx-1 rounded-md px-1 text-left text-strong text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {listing.name}
        </button>
      }
      description={
        <span className="flex min-w-0 flex-col gap-1.5 pt-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span>{eventAndMatcher(listing)}</span>
            <StatusBadge listing={listing} />
          </span>
          <CommandBlock command={listing.handler.command} />
          {unsupported && listing.unsupportedReason ? <span>{listing.unsupportedReason}</span> : null}
        </span>
      }
    >
      <span className="flex items-center justify-end gap-2">
        {hookNeedsApproval(listing) ? (
          <Button size="small" variant="accent" disabled={busy} onClick={onApprove}>
            {listing.status === "changed" ? "Re-approve" : "Approve"}
          </Button>
        ) : null}
        <Switch
          aria-label={`Run ${listing.name}`}
          checked={enabled}
          disabled={busy || !hookSwitchAvailable(listing)}
          onCheckedChange={onToggle}
        />
      </span>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Detail sheet

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-small text-secondary">{label}</dt>
      <dd className="min-w-0 text-small text-primary break-words">{children}</dd>
    </div>
  );
}

function TestResultView({ result }: { result: HookTestResult }) {
  const decision = result.outcome.decision;
  const outcome = result.timedOut
    ? "It timed out."
    : decision === "deny"
      ? `Aiden would block the tool${result.outcome.reason ? `: ${result.outcome.reason}` : "."}`
      : decision === "ask"
        ? `Aiden would ask you first${result.outcome.reason ? `: ${result.outcome.reason}` : "."}`
        : result.outcome.blockPrompt
          ? "Aiden would refuse the message."
          : result.outcome.continueTurn
            ? "Aiden would keep the turn going."
            : result.outcome.additionalContext
              ? "Aiden would give its output to the model as data."
              : "Aiden would carry on as normal.";
  return (
    <div role="status" className="flex flex-col gap-2 rounded-card bg-control/50 p-3">
      <Text variant="small-strong">
        Exit {result.exitCode ?? "none"} · {result.durationMs} ms
      </Text>
      <Text variant="small" color="secondary">
        {outcome}
        {result.matched ? "" : " Its matcher would skip this sample; it ran anyway."}
      </Text>
      {result.stdout ? <CommandBlock command={result.stdout} /> : null}
      {result.stderr ? <CommandBlock command={result.stderr} className="text-secondary" /> : null}
    </div>
  );
}

function HookDetailSheet({
  listing,
  workspaces,
  enabled,
  onOpenChange,
  onApproved,
  onDeleted,
}: {
  listing: HookListing;
  workspaces: readonly HooksWorkspaceLabel[];
  enabled: boolean;
  onOpenChange: (open: boolean) => void;
  onApproved: () => void;
  onDeleted: () => void;
}) {
  const runLog = useQuery({ queryKey: runLogKey(listing.id), queryFn: () => hooksApi.runLog(listing.id) });
  const [testing, setTesting] = React.useState(false);
  const [confirmTest, setConfirmTest] = React.useState(false);
  const [testResult, setTestResult] = React.useState<HookTestResult | null>(null);
  const [testError, setTestError] = React.useState<string | null>(null);
  const [approving, setApproving] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const unsupported = listing.status === "unsupported";
  const needsApproval = hookNeedsApproval(listing);
  const repoHook = listing.source === "workspace-file";

  const runTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      setTestResult(await hooksApi.test(listing.id));
    } catch (error) {
      setTestResult(null);
      setTestError(errorMessage(error, "The test could not run."));
    } finally {
      setTesting(false);
    }
  };

  const approve = async () => {
    setApproving(true);
    try {
      await hooksApi.approveDigest(listing.id, listing.digest);
      toast.success(`${listing.name} is approved.`);
      onApproved();
    } catch (error) {
      toast.error(errorMessage(error, "Couldn’t approve this hook."));
    } finally {
      setApproving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await hooksApi.delete(listing.id);
      setConfirmDelete(false);
      onDeleted();
    } catch (error) {
      toast.error(errorMessage(error, "Couldn’t delete this hook."));
    } finally {
      setDeleting(false);
    }
  };

  const timeout = listing.handler.timeout ?? HOOK_DEFAULT_TIMEOUT_SECONDS;
  const runs = runLog.data ?? [];

  return (
    <>
      <Dialog
        open
        onOpenChange={onOpenChange}
        size="large"
        title={listing.name}
        description={<StatusBadge listing={listing} />}
        confirmLabel={listing.status === "changed" ? "Re-approve" : "Approve"}
        confirmHidden={!needsApproval}
        busy={approving}
        onConfirm={approve}
      >
        <div className="flex flex-col gap-4">
          {unsupported && listing.unsupportedReason ? <Callout>{listing.unsupportedReason}</Callout> : null}
          {listing.status === "changed" ? (
            <Callout color="warning">This hook changed since you approved it. It won’t run until you approve the new version.</Callout>
          ) : null}
          {listing.status === "disabled-after-failures" ? (
            <Callout color="red">It failed several times in a row, so Aiden turned it off. Turn it back on once it’s fixed.</Callout>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Text variant="small-strong">Command</Text>
            <CommandBlock command={listing.handler.command} />
          </div>
          <dl className="flex flex-col">
            <DetailRow label="Event">{eventAndMatcher(listing)}</DetailRow>
            <DetailRow label="Where">{hookScopeLabel(listing.scope, workspaces)}</DetailRow>
            <DetailRow label="Source">{sourceLabel(listing)}</DetailRow>
            <DetailRow label="Timeout">{timeout} seconds</DetailRow>
            {listing.event === "PreToolUse" ? (
              <DetailRow label="If it fails">{listing.handler.failClosed ? "Block the tool" : "Let the tool run"}</DetailRow>
            ) : null}
            <DetailRow label="Extra environment">
              {listing.handler.envAllow?.length ? (
                <span className="font-mono">{listing.handler.envAllow.join(", ")}</span>
              ) : (
                "None"
              )}
            </DetailRow>
            <DetailRow label="Digest">
              <span className="font-mono" title={listing.digest}>
                {hookShortDigest(listing.digest)}
              </span>
            </DetailRow>
            <DetailRow label="Runs">{enabled ? "On" : "Off"}</DetailRow>
          </dl>

          <div className="flex flex-col gap-2">
            <Text variant="small-strong">Last runs</Text>
            {runLog.isError ? (
              <Text variant="small" color="secondary">Couldn’t read its runs.</Text>
            ) : runLog.isSuccess && runs.length === 0 ? (
              <Text variant="small" color="secondary">It hasn’t run yet.</Text>
            ) : (
              <ul aria-label="Last runs" className="flex flex-col gap-2">
                {runs.slice(-10).reverse().map((run) => {
                  const result = RUN_RESULT_LABEL[run.result];
                  return (
                    <li key={`${run.startedAt}-${run.event}`} className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 text-small text-secondary">
                        <Badge color={result.color}>{result.label}</Badge>
                        <span>{formatWhen(run.startedAt)}</span>
                        <span>
                          {run.timedOut ? "Timed out" : `Exit ${run.exitCode ?? "none"}`} · {run.durationMs} ms
                        </span>
                      </span>
                      {run.outputExcerpt ? <CommandBlock command={run.outputExcerpt} className="text-secondary" /> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {testResult ? <TestResultView result={testResult} /> : null}
          {testError ? (
            <Callout color="red" role="alert">
              {testError}
            </Callout>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="filled"
              disabled={unsupported || testing}
              onClick={() => (needsApproval ? setConfirmTest(true) : void runTest())}
            >
              {testing ? "Testing…" : "Test"}
            </Button>
            {repoHook && needsApproval ? null : (
              <Button variant="transparent" className="text-status-red" disabled={deleting} onClick={() => setConfirmDelete(true)}>
                {repoHook ? "Remove approval" : "Delete"}
              </Button>
            )}
            <Text variant="small" color="secondary" className="min-w-0 flex-1 text-pretty">
              Test runs the command once now with a sample payload. Its result isn’t logged.
            </Text>
          </div>
        </div>
      </Dialog>
      <AlertDialog
        open={confirmTest}
        onOpenChange={setConfirmTest}
        title="Run this command now?"
        description={
          <span className="flex flex-col gap-2">
            <span>You haven’t approved this version. Testing runs it once on this Mac.</span>
            <CommandBlock command={listing.handler.command} />
          </span>
        }
        confirmLabel="Run once"
        onConfirm={() => {
          setConfirmTest(false);
          void runTest();
        }}
      />
      <AlertDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={repoHook ? `Remove approval for ${listing.name}?` : `Delete ${listing.name}?`}
        description={
          repoHook
            ? "It stays in the repo’s .aiden/hooks.json and won’t run until you approve it again."
            : "It stops running and is removed from Aiden. This can’t be undone."
        }
        confirmLabel={deleting ? "Deleting…" : repoHook ? "Remove approval" : "Delete"}
        confirmVariant="destructive"
        busy={deleting}
        keepOpenOnConfirm
        onConfirm={remove}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Proposals

interface DiffLine {
  label: string;
  before?: string;
  after?: string;
}

function definitionFields(definition: Pick<HookListing, "event" | "matcher" | "handler" | "scope">, workspaces: readonly HooksWorkspaceLabel[]) {
  return {
    Event: String(definition.event),
    Matcher: definition.matcher.trim() === "" || definition.matcher === "*" ? "Every tool" : definition.matcher,
    Command: definition.handler.command,
    Timeout: `${definition.handler.timeout ?? HOOK_DEFAULT_TIMEOUT_SECONDS} seconds`,
    "If it fails": definition.handler.failClosed ? "Block the tool" : "Let the tool run",
    "Extra environment": definition.handler.envAllow?.length ? definition.handler.envAllow.join(", ") : "None",
    Where: hookScopeLabel(definition.scope, workspaces),
  };
}

/** Where a proposed hook would run, as the end of a sentence. */
function proposalWhere(scope: HookListing["scope"], workspaces: readonly HooksWorkspaceLabel[]): string {
  switch (scope.kind) {
    case "global":
      return "in every chat";
    case "workspace":
      return `in chats in ${hookScopeLabel(scope, workspaces)}`;
    case "chat":
      return "in the chat that proposed it";
    case "bot":
      return "for this Bot";
  }
}

/** The fields an edit changes, before and after; unchanged fields are left out. */
export function hookProposalDiff(
  existing: Pick<HookListing, "event" | "matcher" | "handler" | "scope">,
  proposed: Pick<HookListing, "event" | "matcher" | "handler" | "scope">,
  workspaces: readonly HooksWorkspaceLabel[],
): DiffLine[] {
  const before = definitionFields(existing, workspaces);
  const after = definitionFields(proposed, workspaces);
  return (Object.keys(after) as (keyof typeof after)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ label: key, before: before[key], after: after[key] }));
}

function ProposalCard({
  proposal,
  existing,
  workspaces,
  busy,
  onApprove,
  onReject,
}: {
  proposal: HookProposal;
  existing?: HookListing;
  workspaces: readonly HooksWorkspaceLabel[];
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const definition = proposal.definition;
  const action =
    proposal.action === "create" ? "New hook" : proposal.action === "update" ? "Change" : "Delete";
  const diff = proposal.action === "update" && existing ? hookProposalDiff(existing, definition, workspaces) : null;
  return (
    <Field
      orientation="vertical"
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span>{definition.name}</span>
          <Badge color={proposal.action === "delete" ? "red" : "blue"}>{action}</Badge>
        </span>
      }
      description={proposal.summary}
    >
      <div aria-label={`What ${definition.name} will run`} className="flex flex-col gap-2">
        {diff ? (
          diff.length === 0 ? (
            <Text variant="small" color="secondary">Nothing that runs changes.</Text>
          ) : (
            <dl className="flex flex-col gap-2">
              {diff.map((line) => (
                <div key={line.label} className="flex flex-col gap-1">
                  <dt className="text-small text-secondary">{line.label}</dt>
                  <dd className="flex flex-col gap-1">
                    <span
                      data-diff="removed"
                      className="block whitespace-pre-wrap break-all rounded-control bg-status-red-surface px-2.5 py-1 font-mono text-small text-status-red"
                    >
                      <span aria-hidden="true">− </span>
                      <span className="sr-only">Before: </span>
                      {line.before}
                    </span>
                    <span
                      data-diff="added"
                      className="block whitespace-pre-wrap break-all rounded-control bg-status-green-surface px-2.5 py-1 font-mono text-small text-status-green"
                    >
                      <span aria-hidden="true">+ </span>
                      <span className="sr-only">After: </span>
                      {line.after}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          )
        ) : (
          <>
            <Text variant="small" color="secondary">
              {proposal.action === "delete" ? "Stops running" : "Runs"} on {eventAndMatcher({ ...definition, configuredEvent: definition.event })},{" "}
              {proposalWhere(definition.scope, workspaces)}
            </Text>
            <CommandBlock command={definition.handler.command} />
          </>
        )}
        {proposal.warnings.length ? (
          <Callout color="warning">
            <ul className="flex flex-col gap-1">
              {proposal.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Text variant="small" color="tertiary" className="mr-auto">
            Expires {formatWhen(proposal.expiresAt)}
          </Text>
          <Button variant="filled" disabled={busy} onClick={onReject}>
            Reject
          </Button>
          <Button variant={proposal.action === "delete" ? "destructive" : "accent"} disabled={busy} onClick={onApprove}>
            {proposal.action === "delete" ? "Approve delete" : "Approve"}
          </Button>
        </div>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Add hook sheet

function FormRow({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-small-strong">
        {label}
      </Label>
      {children}
      {hint ? (
        <Text variant="small" color="secondary">
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

function AddHookSheet({
  workspaces,
  onOpenChange,
  onSaved,
}: {
  workspaces: readonly HooksWorkspaceLabel[];
  onOpenChange: (open: boolean) => void;
  onSaved: (listing: HookListing | undefined) => void;
}) {
  const ids = React.useId();
  const [scopeKey, setScopeKey] = React.useState("global");
  const [event, setEvent] = React.useState<HookEvent>("PreToolUse");
  const [matcher, setMatcher] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [name, setName] = React.useState("");
  const [timeout, setTimeoutField] = React.useState("");
  const [failClosed, setFailClosed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const toolEvent = HOOK_TOOL_EVENTS.has(event);
  const parsedTimeout = parseHookTimeoutField(timeout);
  const ready = command.trim() !== "" && parsedTimeout !== null;

  const save = async () => {
    if (!ready || parsedTimeout === null) return;
    const workspace = workspaces.find((entry) => hookScopeKey({ kind: "workspace", workspaceRoot: entry.workspaceRoot }) === scopeKey);
    const request: HookSaveRequest = {
      scope: workspace ? { kind: "workspace", workspaceRoot: workspace.workspaceRoot } : { kind: "global" },
      event,
      command: command.trim(),
      ...(toolEvent && matcher.trim() ? { matcher: matcher.trim() } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(parsedTimeout !== undefined ? { timeout: parsedTimeout } : {}),
      ...(event === "PreToolUse" && failClosed ? { failClosed: true } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      onSaved(await hooksApi.save(request));
    } catch (saveError) {
      setError(errorMessage(saveError, "Couldn’t add this hook."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="large"
      title="Add hook"
      description="A hook runs your shell command at one point in every chat it covers. Hooks you add here are approved as you save them."
      confirmLabel={saving ? "Adding…" : "Add hook"}
      confirmDisabled={!ready}
      busy={saving}
      onConfirm={save}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormRow label="Where" htmlFor={`${ids}-scope`}>
            <Select value={scopeKey} onValueChange={setScopeKey}>
              <SelectTrigger id={`${ids}-scope`} aria-label="Where">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Every chat</SelectItem>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.workspaceRoot} value={hookScopeKey({ kind: "workspace", workspaceRoot: workspace.workspaceRoot })}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow label="When" htmlFor={`${ids}-event`} hint={HOOK_EVENT_DESCRIPTIONS[event]}>
            <Select
              value={event}
              onValueChange={(value) => {
                setEvent(value as HookEvent);
                if (value !== "PreToolUse") setFailClosed(false);
              }}
            >
              <SelectTrigger id={`${ids}-event`} aria-label="When">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOOK_EVENTS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
        </div>
        {toolEvent ? (
          <FormRow
            label="Tools"
            htmlFor={`${ids}-matcher`}
            hint="A tool name such as Bash, a list such as Edit|Write, or a pattern. Leave blank for every tool."
          >
            <Input
              id={`${ids}-matcher`}
              value={matcher}
              maxLength={HOOK_MAX_MATCHER_LENGTH}
              placeholder="Every tool"
              spellCheck={false}
              className="font-mono"
              onChange={(change) => setMatcher(change.target.value)}
            />
          </FormRow>
        ) : null}
        <FormRow
          label="Command"
          htmlFor={`${ids}-command`}
          hint="Runs with your shell in the workspace folder, or your home folder for chats outside one. It reads the event as JSON on stdin."
        >
          <Textarea
            id={`${ids}-command`}
            value={command}
            maxLength={HOOK_MAX_COMMAND_LENGTH}
            placeholder="~/.aiden/hooks/guard-shell.sh"
            spellCheck={false}
            className="code-font-sized"
            onChange={(change) => setCommand(change.target.value)}
          />
        </FormRow>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormRow label="Name" htmlFor={`${ids}-name`} hint="Optional. Shown in chats when it runs.">
            <Input
              id={`${ids}-name`}
              value={name}
              maxLength={HOOK_MAX_NAME_LENGTH}
              placeholder="From the command"
              onChange={(change) => setName(change.target.value)}
            />
          </FormRow>
          <FormRow label="Timeout" htmlFor={`${ids}-timeout`} hint={`Seconds, up to ${HOOK_MAX_TIMEOUT_SECONDS}.`}>
            <Input
              id={`${ids}-timeout`}
              value={timeout}
              inputMode="numeric"
              placeholder={String(HOOK_DEFAULT_TIMEOUT_SECONDS)}
              aria-invalid={parsedTimeout === null || undefined}
              onChange={(change) => setTimeoutField(change.target.value)}
            />
          </FormRow>
        </div>
        {event === "PreToolUse" ? (
          <div className="flex items-center justify-between gap-4 rounded-card bg-control/50 px-3 py-2.5">
            <span className="flex min-w-0 flex-col">
              <Label htmlFor={`${ids}-fail-closed`} className="text-small-strong">
                Block if the hook fails
              </Label>
              <Text variant="small" color="secondary">
                If it crashes or times out, block the tool instead of letting it run.
              </Text>
            </span>
            <Switch id={`${ids}-fail-closed`} checked={failClosed} onCheckedChange={setFailClosed} />
          </div>
        ) : null}
        {error ? (
          <Callout color="red" role="alert">
            {error}
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// What hooks can see

function WhatHooksSeeSheet({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const section = (title: string, body: React.ReactNode) => (
    <section className="flex flex-col gap-1.5">
      <Text as="h3" variant="small-strong">
        {title}
      </Text>
      {body}
    </section>
  );
  const mono = (names: string[]) => <span className="font-mono text-small text-primary">{names.join(", ")}</span>;
  return (
    <Dialog open onOpenChange={onOpenChange} title="What hooks can see" confirmHidden size="large">
      <div className="flex flex-col gap-4 text-small text-secondary">
        {section(
          "The event, as JSON on stdin",
          <p>
            Every hook gets {mono(["hook_event_name", "session_id", "cwd"])}. Tool hooks also get{" "}
            {mono(["tool_name", "tool_input"])}, and {mono(["tool_response"])} after the tool runs. Message hooks get{" "}
            {mono(["prompt"])}; others get {mono(["source", "message", "trigger"])} when they apply.
          </p>,
        )}
        {section(
          "A minimal environment",
          <p>
            Only {mono(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL"])} come from your Mac, plus{" "}
            {mono(["AIDEN_PROJECT_DIR", "AIDEN_HOOK_EVENT", "AIDEN_SESSION_ID"])}. API keys and other variables reach a hook only if it
            names them, and that list is part of what you approve.
          </p>,
        )}
        {section(
          "Its output is data",
          <p>
            Text a hook adds is given to the model as data, never as instructions, and capped at 10,000 characters per hook and 20,000
            per event. A hook can block a tool, ask you first or add context. It can never let a chat do more than it already may.
          </p>,
        )}
        {section(
          "Only what you approve runs",
          <p>
            Hooks from a repo’s .aiden/hooks.json and hooks the agent proposes wait for your approval. Any change to what runs needs
            approval again.
          </p>,
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page

export function HooksSettings() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: HOOKS_QUERY_KEY, queryFn: hooksApi.list });
  const [pausedOverride, setPausedOverride] = React.useState<boolean | null>(null);
  const [enabledOverrides, setEnabledOverrides] = React.useState<ReadonlyMap<string, boolean>>(new Map());
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [explaining, setExplaining] = React.useState(false);
  const [confirmApprove, setConfirmApprove] = React.useState<HookListing | null>(null);

  React.useEffect(
    () =>
      hooksApi.onChanged(() => {
        void queryClient.invalidateQueries({ queryKey: ["hooks"] });
      }),
    [queryClient],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["hooks"] });
  const withBusy = async (key: string, work: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(key));
    try {
      await work();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  // Instant: the switch moves at once and rolls back if main refuses.
  const setPaused = async (paused: boolean) => {
    setPausedOverride(paused);
    try {
      await hooksApi.setPaused(paused);
      queryClient.setQueryData<HooksOverview>(HOOKS_QUERY_KEY, (current) => (current ? { ...current, paused } : current));
      await refresh();
    } catch {
      toast.error("Couldn’t change Pause all hooks.");
    } finally {
      setPausedOverride(null);
    }
  };

  const setEnabled = async (listing: HookListing, enabled: boolean) => {
    setEnabledOverrides((current) => new Map(current).set(listing.id, enabled));
    try {
      await hooksApi.setEnabled(listing.id, enabled);
      await refresh();
    } catch {
      toast.error(enabled ? `Couldn’t turn on ${listing.name}.` : `Couldn’t turn off ${listing.name}.`);
    } finally {
      setEnabledOverrides((current) => {
        const next = new Map(current);
        next.delete(listing.id);
        return next;
      });
    }
  };

  const approve = (listing: HookListing) =>
    withBusy(listing.id, async () => {
      try {
        await hooksApi.approveDigest(listing.id, listing.digest);
        toast.success(`${listing.name} is approved.`);
      } catch (error) {
        toast.error(errorMessage(error, "Couldn’t approve this hook."));
      }
      await refresh();
    });

  const decideProposal = (proposal: HookProposal, approved: boolean) =>
    withBusy(proposal.id, async () => {
      // Instant: the card leaves at once and comes back if main refuses.
      queryClient.setQueryData<HooksOverview>(HOOKS_QUERY_KEY, (current) =>
        current ? { ...current, proposals: current.proposals.filter((entry) => entry.id !== proposal.id) } : current,
      );
      try {
        if (approved) await hooksApi.approveProposal(proposal.id);
        else await hooksApi.rejectProposal(proposal.id);
      } catch (error) {
        toast.error(errorMessage(error, approved ? "Couldn’t approve this hook." : "Couldn’t reject this hook."));
      }
      await refresh();
    });

  const data = overview.data;
  const listings = data?.hooks ?? [];
  const detail = detailId ? listings.find((listing) => listing.id === detailId) : undefined;
  const enabledOf = (listing: HookListing) => enabledOverrides.get(listing.id) ?? hookSwitchOn(listing);

  return (
    <HooksSettingsView
      overview={data ?? null}
      error={overview.isError ? errorMessage(overview.error, "Aiden could not read your hooks.") : null}
      paused={pausedOverride ?? data?.paused ?? false}
      pausePending={pausedOverride !== null}
      busy={busy}
      enabledOf={enabledOf}
      onSetPaused={(paused) => void setPaused(paused)}
      onSetEnabled={(listing, enabled) => void setEnabled(listing, enabled)}
      onApprove={setConfirmApprove}
      onOpen={(listing) => setDetailId(listing.id)}
      onAdd={() => setAdding(true)}
      onExplain={() => setExplaining(true)}
      onApproveProposal={(proposal) => void decideProposal(proposal, true)}
      onRejectProposal={(proposal) => void decideProposal(proposal, false)}
    >
      {detail && data ? (
        <HookDetailSheet
          key={detail.id}
          listing={detail}
          workspaces={data.workspaces}
          enabled={enabledOf(detail)}
          onOpenChange={(open) => !open && setDetailId(null)}
          onApproved={() => void refresh()}
          onDeleted={() => {
            setDetailId(null);
            toast.success(`${detail.name} is ${detail.source === "workspace-file" ? "no longer approved" : "deleted"}.`);
            void refresh();
          }}
        />
      ) : null}
      {adding && data ? (
        <AddHookSheet
          workspaces={data.workspaces}
          onOpenChange={setAdding}
          onSaved={(listing) => {
            setAdding(false);
            toast.success(listing ? `${listing.name} is on.` : "Hook added.");
            void refresh();
          }}
        />
      ) : null}
      {explaining ? <WhatHooksSeeSheet onOpenChange={setExplaining} /> : null}
      <AlertDialog
        open={confirmApprove !== null}
        onOpenChange={(open) => !open && setConfirmApprove(null)}
        title={confirmApprove ? `Approve ${confirmApprove.name}?` : "Approve hook?"}
        description={
          confirmApprove ? (
            <span className="flex flex-col gap-2">
              <span>
                It will run this command on {eventAndMatcher(confirmApprove)} in{" "}
                {hookScopeLabel(confirmApprove.scope, data?.workspaces ?? [])}, on this Mac.
              </span>
              <CommandBlock command={confirmApprove.handler.command} />
            </span>
          ) : null
        }
        confirmLabel="Approve"
        onConfirm={() => {
          const listing = confirmApprove;
          setConfirmApprove(null);
          if (listing) void approve(listing);
        }}
      />
    </HooksSettingsView>
  );
}

export interface HooksSettingsViewProps {
  /** `null` while the first read is in flight. */
  overview: HooksOverview | null;
  error: string | null;
  paused: boolean;
  pausePending: boolean;
  /** Hook or proposal ids with a request in flight. */
  busy: ReadonlySet<string>;
  enabledOf: (listing: HookListing) => boolean;
  onSetPaused: (paused: boolean) => void;
  onSetEnabled: (listing: HookListing, enabled: boolean) => void;
  onApprove: (listing: HookListing) => void;
  onOpen: (listing: HookListing) => void;
  onAdd: () => void;
  onExplain: () => void;
  onApproveProposal: (proposal: HookProposal) => void;
  onRejectProposal: (proposal: HookProposal) => void;
  children?: React.ReactNode;
}

export function HooksSettingsView({
  overview,
  error,
  paused,
  pausePending,
  busy,
  enabledOf,
  onSetPaused,
  onSetEnabled,
  onApprove,
  onOpen,
  onAdd,
  onExplain,
  onApproveProposal,
  onRejectProposal,
  children,
}: HooksSettingsViewProps) {
  if (!overview) {
    return (
      <FieldSet>
        <Field>
          {error ? (
            <Callout color="red" role="alert">
              {error}
            </Callout>
          ) : (
            <Text role="status" variant="small" color="secondary">
              Reading your hooks…
            </Text>
          )}
        </Field>
      </FieldSet>
    );
  }
  const groups = groupHooksByScope(overview);
  const byId = new Map(overview.hooks.map((hook) => [hook.id, hook]));
  const empty = groups.length === 0 && overview.proposals.length === 0;

  return (
    <>
      {overview.disabledByEnvironment ? (
        <Callout color="warning" role="status" className="mb-5">
          AIDEN_HOOKS=0 is set for this launch, so no hook runs. Quit Aiden and open it without that variable to use hooks.
        </Callout>
      ) : null}
      {!overview.available ? (
        <Callout role="status" className="mb-5">
          Hooks are still starting. This page fills in a moment.
        </Callout>
      ) : null}
      <FieldSet>
        <Field label="Pause all hooks" description="Nothing runs while paused. Your hooks and approvals stay as they are.">
          <Switch
            aria-label="Pause all hooks"
            checked={paused}
            disabled={pausePending || !overview.available}
            onCheckedChange={onSetPaused}
          />
        </Field>
        <Field label="What hooks can see" description="The data each hook gets, its environment, and what Aiden does with its output.">
          <span className="flex justify-end">
            <Button variant="filled" onClick={onExplain}>
              Show
            </Button>
          </span>
        </Field>
      </FieldSet>

      {overview.proposals.length ? (
        <FieldSet title="Proposed by the agent">
          {overview.proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              existing={byId.get(proposal.hookId)}
              workspaces={overview.workspaces}
              busy={busy.has(proposal.id)}
              onApprove={() => onApproveProposal(proposal)}
              onReject={() => onRejectProposal(proposal)}
            />
          ))}
        </FieldSet>
      ) : null}

      {empty ? (
        <FieldSet title="Hooks">
          <EmptyState
            title="No hooks yet"
            description="A hook runs your own shell command at a point in a chat, such as before a tool runs."
            action={
              <Button variant="accent" disabled={!overview.available} onClick={onAdd}>
                <Plus aria-hidden="true" />
                Add hook
              </Button>
            }
          />
        </FieldSet>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-end px-1">
            <Button variant="accent" disabled={!overview.available} onClick={onAdd}>
              <Plus aria-hidden="true" />
              Add hook
            </Button>
          </div>
          {groups.map((group) => (
            <FieldSet
              key={group.key}
              title={
                <span className="flex min-w-0 flex-col">
                  <span>{group.title}</span>
                  {group.scope.kind === "workspace" && group.detail ? (
                    <span className="truncate text-small font-normal text-secondary">{group.detail}</span>
                  ) : null}
                </span>
              }
            >
              {group.fileProblems.length || group.fileWarnings.length ? (
                <Field>
                  <Callout color={group.fileProblems.length ? "red" : "warning"}>
                    <Text variant="small-strong">.aiden/hooks.json</Text>
                    <ul className="flex flex-col gap-1">
                      {[...group.fileProblems, ...group.fileWarnings].map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </Callout>
                </Field>
              ) : null}
              {group.hooks.map((listing) => (
                <HookRow
                  key={listing.id}
                  listing={listing}
                  enabled={enabledOf(listing)}
                  busy={busy.has(listing.id)}
                  onOpen={() => onOpen(listing)}
                  onToggle={(enabled) => onSetEnabled(listing, enabled)}
                  onApprove={() => onApprove(listing)}
                />
              ))}
            </FieldSet>
          ))}
        </>
      )}
      {children}
    </>
  );
}
