// The fork's "What happened after this point" card. It sits after the last
// copied message and follows the summary from pending to ready or failed.

import * as React from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS,
  type ChatForkSummaryV1,
} from "../shared/chat-copy-contract";
import { Button, Callout, Dialog, Text, Textarea } from "./ui";
import { Markdown } from "./markdown";
import { cn } from "../lib/ui-utils";

export interface ForkSummaryCardProps {
  summary: ChatForkSummaryV1;
  /** A summary action is in flight; its buttons wait for it. */
  busy?: boolean;
  /** Expand a ready summary on first render. */
  defaultOpen?: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onSkip: () => void;
}

export function ForkSummaryCard({
  summary,
  busy = false,
  defaultOpen = false,
  onCancel,
  onRetry,
  onSkip,
}: ForkSummaryCardProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const bodyId = React.useId();
  const title = "What happened after this point";

  if (summary.state === "pending") {
    return (
      <Callout data-fork-summary="pending" aria-busy="true">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <Loader2
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-[spin_1.5s_linear_infinite] text-tertiary motion-reduce:animate-none"
            />
            <span className="min-w-0">
              <Text as="p" variant="small-strong">
                {title}
              </Text>
              <Text as="p" role="status" variant="small" color="secondary">
                Summarizing the original chat…
              </Text>
            </span>
          </span>
          <Button variant="transparent" size="small" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <FocusLine instructions={summary.instructions} />
      </Callout>
    );
  }

  if (summary.state === "failed") {
    return (
      <Callout data-fork-summary="failed">
        <Text as="p" variant="small-strong">
          {title}
        </Text>
        <Text as="p" role="alert" variant="small" color="secondary">
          {summary.error ?? "The summary could not be generated."} Messages you send wait until you
          retry or continue without it.
        </Text>
        <FocusLine instructions={summary.instructions} />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button size="small" disabled={busy} onClick={onRetry}>
            Retry
          </Button>
          <Button variant="transparent" size="small" disabled={busy} onClick={onSkip}>
            Continue without summary
          </Button>
        </div>
      </Callout>
    );
  }

  const read = summary.files?.read ?? [];
  const modified = summary.files?.modified ?? [];
  return (
    <Callout data-fork-summary="ready">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
        className="-mx-1 flex items-center gap-1.5 rounded-control px-1 py-0.5 text-left text-small-strong text-primary outline-none hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-tertiary transition-transform duration-150 ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        {title}
      </button>
      <Text as="p" variant="small" color="secondary">
        The model sees this summary. None of it happened in this chat.
      </Text>
      {open ? (
        <div id={bodyId} className="mt-1 flex min-w-0 flex-col gap-2">
          <FocusLine instructions={summary.instructions} />
          <div className="select-text text-small">
            <Markdown content={summary.text ?? ""} />
          </div>
          <FileList label="Read" paths={read} />
          <FileList label="Modified" paths={modified} />
        </div>
      ) : null}
    </Callout>
  );
}

function FocusLine({ instructions }: { instructions?: string }) {
  if (!instructions) return null;
  return (
    <Text as="p" variant="small" color="tertiary" className="break-words">
      Focus: {instructions}
    </Text>
  );
}

function FileList({ label, paths }: { label: string; paths: readonly string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="min-w-0">
      <Text as="p" variant="small-strong" color="secondary">
        {label}
      </Text>
      <ul aria-label={`${label} files`} className="mt-0.5 flex min-w-0 flex-col gap-0.5">
        {paths.map((item) => (
          <li key={item} className="select-text truncate font-mono text-mini text-secondary" title={item}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ForkSummaryDialogProps {
  open: boolean;
  /** "edit" forks before a prompt to edit it; "fork" keeps the chosen reply. */
  kind: "fork" | "edit";
  onOpenChange: (open: boolean) => void;
  /** Create the fork. Resolve when it opened; reject to keep the dialog open. */
  onConfirm: (instructions: string | undefined) => Promise<void>;
}

/** Confirms "Fork with summary…" with an optional focus for the summary. */
export function ForkSummaryDialog({ open, kind, onOpenChange, onConfirm }: ForkSummaryDialogProps) {
  const [instructions, setInstructions] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setInstructions("");
  }, [open]);
  const tooLong = instructions.length > MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS;
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(instructions.trim() || undefined);
      onOpenChange(false);
    } catch {
      // The caller explains the failure; keep the dialog so nothing typed is lost.
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={kind === "edit" ? "Edit in fork with summary" : "Fork with summary"}
      description="The new chat keeps the conversation up to this point. Aiden summarizes what happened after it in the original chat and gives that summary to the model."
      confirmLabel="Fork"
      confirmDisabled={tooLong}
      busy={busy}
      submitOnEnter
      onConfirm={confirm}
    >
      <label className="flex flex-col gap-1.5">
        <Text variant="small-strong">Focus the summary on (optional)</Text>
        <Textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="For example: the decisions about the parser"
          maxLength={MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS}
          aria-invalid={tooLong || undefined}
          autoFocus
        />
      </label>
    </Dialog>
  );
}
