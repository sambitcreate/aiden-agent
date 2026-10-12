import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Loader2, MousePointer2 } from "lucide-react";
import { Button, Text } from "./ui";
import { computerUseApi, type ApprovalPrompt } from "../lib/ipc";
import { userFacingErrorMessage } from "../lib/ipc-error";
import { computerUseReadinessReady } from "../lib/computer-use-control";
import { queryKeys, useComputerUseStatus } from "../lib/queries";
import { cn } from "../lib/ui-utils";
import type { ComputerUseStatus } from "../lib/types";
import type { ChatApprovalDecisionOptions } from "./chat-approval-card";

/** How often a surface waiting on macOS permissions re-checks Computer Use status. */
export const COMPUTER_USE_STATUS_POLL_MS = 2_000;

export const COMPUTER_USE_ALWAYS_ALLOW_HINT =
  "Allow Computer Use in every chat. Turn this off in Settings → Computer Use.";

export const COMPUTER_USE_RESTART_NOTE =
  "If macOS asks you to quit and reopen Aiden, do that, then click Continue in this chat.";

/** Live local readiness: re-checks on window focus and polls until status is ready. */
export function useLiveComputerUseReadiness(enabled: boolean) {
  const status = useComputerUseStatus(enabled, { pollUntilReadyMs: COMPUTER_USE_STATUS_POLL_MS });
  const ready = computerUseReadinessReady(status.data?.ready === true, status.isError);
  return { status, ready };
}

const PERMISSION_ROWS = [
  { key: "accessibility", label: "Accessibility" },
  { key: "screenRecording", label: "Screen Recording" },
] as const;

function permissionStateLabel(granted: boolean | null | undefined): string {
  if (granted === true) return "Allowed";
  if (granted === false) return "Not allowed";
  return "Checking…";
}

/**
 * The macOS permissions Computer Use needs, each with its live state, plus the
 * one action that opens System Settings. Shared by the access card and the
 * Continue callout so both walk the user through the same steps.
 */
export function ComputerUsePermissionChecklist({
  status,
  failed,
  id,
}: {
  status: ComputerUseStatus | undefined;
  failed: boolean;
  id?: string;
}) {
  const queryClient = useQueryClient();
  const [requesting, setRequesting] = React.useState(false);
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const requestPermissions = async () => {
    if (requesting) return;
    setRequesting(true);
    setRequestError(null);
    try {
      queryClient.setQueryData(queryKeys.computerUseStatus, await computerUseApi.requestPermissions());
    } catch (error) {
      setRequestError(userFacingErrorMessage(error, "Couldn’t open System Settings."));
    } finally {
      setRequesting(false);
    }
  };
  const detail = failed
    ? "Aiden couldn’t check Computer Use. Open Settings → Computer Use and try again."
    : (status?.detail ?? "Checking Computer Use…");
  return (
    <div id={id} className="mt-2.5 space-y-2.5 rounded-control bg-well px-3 py-2.5">
      <ul aria-label="macOS permissions" className="space-y-1.5">
        {PERMISSION_ROWS.map(({ key, label }) => {
          const granted = status?.permissions[key];
          const Icon = granted === true ? CheckCircle2 : granted === false ? CircleAlert : Loader2;
          return (
            <li key={key} className="flex items-center gap-2 text-small">
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full",
                  granted === true
                    ? "bg-status-green-surface text-status-green"
                    : granted === false
                      ? "bg-status-warning-surface text-status-warning"
                      : "text-tertiary",
                )}
              >
                <Icon className={cn("size-3.5", granted == null && "animate-spin")} />
              </span>
              <span className="min-w-0 flex-1 text-primary">{label}</span>
              <span className="shrink-0 text-secondary">{permissionStateLabel(granted)}</span>
            </li>
          );
        })}
      </ul>
      {status?.canRequestPermissions && !failed ? null : (
        <Text as="p" variant="small" color="secondary" role={failed ? "alert" : undefined}>
          {detail}
        </Text>
      )}
      <Text as="p" variant="small" color="secondary">
        {COMPUTER_USE_RESTART_NOTE}
      </Text>
      {requestError ? (
        <Text as="p" variant="small" color="secondary" role="alert">
          {requestError}
        </Text>
      ) : null}
      {status?.canRequestPermissions ? (
        <div className="flex justify-end">
          <Button
            size="small"
            variant="filled"
            onClick={() => void requestPermissions()}
            disabled={requesting}
            aria-busy={requesting || undefined}
          >
            {requesting ? <Loader2 className="animate-spin" /> : null}
            Open System Settings
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The once-per-chat Computer Use access request. The answer covers this chat or
 * every chat, so there is no "Allow once". On this Mac, allowing waits until
 * macOS permissions are in place; a remote viewer cannot check them, so the host
 * re-checks readiness when the decision arrives.
 */
export function ComputerUseAccessApproval({
  pending,
  deciding,
  onDecide,
  cardRef,
  denyRef,
  disabledReason,
  pendingCount = 1,
  host = "local",
}: {
  pending: ApprovalPrompt;
  deciding: boolean;
  onDecide: (decision: "allow" | "deny", options?: ChatApprovalDecisionOptions) => void;
  cardRef?: React.Ref<HTMLElement>;
  denyRef?: React.Ref<HTMLButtonElement>;
  disabledReason?: string;
  pendingCount?: number;
  host?: "local" | "remote";
}) {
  const local = host === "local";
  const { status, ready } = useLiveComputerUseReadiness(local);
  // The checklist waits for the first answer so it never flashes "Checking…" rows.
  const showChecklist = local && !ready && (status.data !== undefined || status.isError);
  const titleId = `approval-title-${pending.approvalId}`;
  const summaryId = `approval-summary-${pending.approvalId}`;
  const checklistId = `approval-checklist-${pending.approvalId}`;
  const allowBlockedId = `approval-allow-blocked-${pending.approvalId}`;
  const alwaysHintId = `approval-scope-always-${pending.approvalId}`;
  const canAllow = pending.canAllow !== false;
  const allowBlockedReason =
    local && !ready
      ? status.isLoading
        ? "Checking whether Computer Use is ready."
        : "Allow Accessibility and Screen Recording for Aiden first."
      : undefined;
  const disabled = deciding || disabledReason !== undefined;
  const allowDisabled = disabled || allowBlockedReason !== undefined;
  const allowDescription = [allowBlockedReason ? allowBlockedId : undefined, showChecklist ? checklistId : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <p className="sr-only" role="status">
        {`Approval needed for Computer Use${pendingCount > 1 ? `, 1 of ${pendingCount}` : ""}`}
      </p>
      <section
        ref={cardRef}
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        className="rounded-card bg-popover p-3 shadow-popover"
        data-computer-use-access="true"
      >
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-status-warning-surface text-status-warning">
            <MousePointer2 aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <Text variant="small-strong" as="p" id={titleId}>
              Aiden wants to use your computer
              {pendingCount > 1 ? (
                <span className="ml-1.5 font-normal text-tertiary">1 of {pendingCount}</span>
              ) : null}
            </Text>
            <Text variant="small" color="secondary" as="p" id={summaryId} className="mt-0.5 text-pretty">
              Screenshots and accessibility text from your apps go to the selected model. If you allow
              it, Aiden can click and type in this chat without asking again.
            </Text>
          </div>
        </div>
        {local ? (
          showChecklist ? (
            <ComputerUsePermissionChecklist id={checklistId} status={status.data} failed={status.isError} />
          ) : null
        ) : (
          <Text variant="small" color="secondary" as="p" role="note" className="mt-2.5">
            Finish any Computer Use setup on the host Mac.
          </Text>
        )}
        {disabledReason ? (
          <Text variant="small" color="secondary" as="p" role="note" className="mt-2.5">
            {disabledReason}
          </Text>
        ) : null}
        {allowBlockedReason ? (
          <span id={allowBlockedId} className="sr-only">
            {allowBlockedReason}
          </span>
        ) : null}
        <span id={alwaysHintId} className="sr-only">
          {COMPUTER_USE_ALWAYS_ALLOW_HINT}
        </span>
        <div className="mt-2.5 flex flex-wrap justify-end gap-2">
          <Button ref={denyRef} variant="transparent" size="small" disabled={disabled} onClick={() => onDecide("deny")}>
            Deny
          </Button>
          {canAllow ? (
            <>
              <Button
                variant="transparent"
                size="small"
                disabled={allowDisabled}
                title={COMPUTER_USE_ALWAYS_ALLOW_HINT}
                aria-describedby={[alwaysHintId, allowDescription].filter(Boolean).join(" ")}
                onClick={() => onDecide("allow", { scope: "always" })}
              >
                Always allow
              </Button>
              <Button
                variant="accent"
                size="small"
                disabled={allowDisabled}
                aria-describedby={allowDescription || undefined}
                onClick={() => onDecide("allow", { scope: "chat" })}
              >
                {deciding ? "Sending…" : "Allow for this chat"}
              </Button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/**
 * Shown above the composer after a Computer Use request stopped on missing
 * macOS permissions (often across a relaunch). Ready: offers to continue the
 * task. Not ready: the same permission checklist as the access card.
 */
export function ComputerUseContinueCallout({
  onContinue,
  onDismiss,
  continueDisabledReason,
}: {
  onContinue: () => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
  /** Why the chat cannot send right now (for example, no model is ready). */
  continueDisabledReason?: string;
}) {
  const { status, ready } = useLiveComputerUseReadiness(true);
  const [busy, setBusy] = React.useState<"continue" | "dismiss" | null>(null);
  const id = React.useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const blockedId = `${id}-blocked`;
  const known = ready || status.data !== undefined || status.isError;
  const run = async (action: "continue" | "dismiss") => {
    if (busy) return;
    setBusy(action);
    try {
      await (action === "continue" ? onContinue() : onDismiss());
    } finally {
      setBusy(null);
    }
  };
  // Wait for the first status answer instead of flashing the setup state.
  if (!known) return null;
  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="rounded-card bg-popover p-3 shadow-popover"
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full",
            ready ? "bg-status-green-surface text-status-green" : "bg-status-warning-surface text-status-warning",
          )}
        >
          <MousePointer2 aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small-strong" as="p" id={titleId}>
            {ready ? "Computer Use is ready." : "Finish setting up Computer Use"}
          </Text>
          <Text variant="small" color="secondary" as="p" id={descriptionId} className="mt-0.5 text-pretty">
            {ready
              ? "Continue where Aiden left off?"
              : "Aiden paused because macOS permissions were missing. Allow them, then continue."}
          </Text>
        </div>
      </div>
      {!ready ? <ComputerUsePermissionChecklist status={status.data} failed={status.isError} /> : null}
      {ready && continueDisabledReason ? (
        <Text variant="small" color="secondary" as="p" id={blockedId} role="note" className="mt-2.5">
          {continueDisabledReason}
        </Text>
      ) : null}
      <div className="mt-2.5 flex justify-end gap-2">
        <Button variant="transparent" size="small" disabled={busy !== null} onClick={() => void run("dismiss")}>
          Dismiss
        </Button>
        {ready ? (
          <Button
            variant="accent"
            size="small"
            disabled={busy !== null || continueDisabledReason !== undefined}
            aria-describedby={continueDisabledReason ? blockedId : undefined}
            onClick={() => void run("continue")}
          >
            {busy === "continue" ? "Continuing…" : "Continue"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
