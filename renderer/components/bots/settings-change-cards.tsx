// Settings from chat (docs/plans/bot-ux-simplification.md §4.6). A change the
// Bot made in a run the person started is a receipt line, "Settings updated ·
// Undo", that reads "Restored" once undone. A change that waits (another run
// asked, the chat read outside content, or the Bot would reach out more) sits
// in the Needs-you slot as "Update instructions?" with Apply, Edit and Dismiss,
// and shows the whole proposed text, what changes marked, before Apply.

import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button, Text } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import { ReceiptLine } from "./receipt-line";
import {
  botInstructionsDiff,
  botSettingsHeldTitle,
  botSettingsReceiptLabel,
  type BotSettingsChangeEntryData,
  type BotSettingsChangeStatus,
  type BotSettingsHeldReason,
} from "../../shared/bot-settings-changes";
import { cn } from "../../lib/ui-utils";

/** What the receipt reads, from its status. */
export function settingsReceiptText(change: BotSettingsChangeEntryData, status: "pending" | BotSettingsChangeStatus): string {
  const label = botSettingsReceiptLabel(change.fields);
  const detail = change.fields.includes("instructions") && change.fields.length === 1 ? "" : ` · ${change.lines.join(", ")}`;
  if (status === "restored") return `${label}${detail} · Restored`;
  if (status === "undo_refused") return `${label}${detail} · Changed again since, so not undone`;
  return `${label}${detail}`;
}

export function SettingsChangeReceipt({
  change,
  status,
  onUndo,
}: {
  change: BotSettingsChangeEntryData;
  status: "pending" | BotSettingsChangeStatus;
  /** Resolves to the settled status, or rejects after saying why. */
  onUndo(): Promise<BotSettingsChangeStatus>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [answered, setAnswered] = React.useState<BotSettingsChangeStatus | null>(null);
  const settled = status !== "pending" ? status : answered ?? "pending";
  return (
    <ReceiptLine
      icon={<SlidersHorizontal />}
      text={settingsReceiptText(change, settled)}
      data-settings-receipt
      actions={
        settled === "pending" && change.undoable !== false
          ? [
              {
                label: busy ? "Undoing…" : "Undo",
                ariaLabel: `Undo: ${botSettingsReceiptLabel(change.fields)}`,
                disabled: busy,
                onClick: () => {
                  setBusy(true);
                  void onUndo().then(setAnswered, () => undefined).finally(() => setBusy(false));
                },
              },
            ]
          : []
      }
    />
  );
}

export function HeldSettingsCard({
  change,
  botName,
  onRespond,
  onEdit,
}: {
  change: BotSettingsChangeEntryData;
  botName: string;
  onRespond(decision: "apply" | "dismiss"): Promise<void>;
  /** Opens the instructions editor seeded with the proposed text; shown when the change has instructions. */
  onEdit?(instructions: string): void;
}) {
  const [busy, setBusy] = React.useState<"apply" | "dismiss" | null>(null);
  const title = botSettingsHeldTitle(change.fields);
  const respond = (decision: "apply" | "dismiss") => {
    if (busy) return;
    setBusy(decision);
    void onRespond(decision).catch(() => undefined).finally(() => setBusy(null));
  };
  const other = change.lines.filter((line) => line !== "Instructions");
  return (
    <BotNoticeCard
      label={title}
      icon={<SlidersHorizontal />}
      title={title}
      elevated
      actions={
        <>
          <Button variant="transparent" size="small" disabled={busy !== null} onClick={() => respond("dismiss")}>
            Dismiss
          </Button>
          {onEdit && change.instructions !== undefined ? (
            <Button variant="filled" size="small" disabled={busy !== null} onClick={() => onEdit(change.instructions!)}>
              Edit
            </Button>
          ) : null}
          <Button variant="accent" size="small" disabled={busy !== null} onClick={() => respond("apply")}>
            {busy === "apply" ? "Applying…" : "Apply"}
          </Button>
        </>
      }
    >
      <Text as="p" variant="small" color="secondary">
        {heldReasonText(botName, change.heldReason ?? "not_owner")}
      </Text>
      {other.length > 0 ? (
        <Text as="p" variant="small" color="secondary">
          {other.join(" · ")}
        </Text>
      ) : null}
      {change.instructions !== undefined ? (
        <ProposedInstructions proposed={change.instructions} previous={change.previousInstructions} />
      ) : null}
    </BotNoticeCard>
  );
}

function heldReasonText(botName: string, reason: BotSettingsHeldReason): string {
  switch (reason) {
    case "not_owner":
      return `${botName} asked to change its settings in a run you didn't start.`;
    case "outside_content":
      return `${botName} asked to change its settings after this chat read content from outside it, like a web page or an app's data.`;
    case "widens":
      return `${botName} asked to reach out to you more on its own.`;
  }
}

/**
 * The whole proposed instructions in a bounded scroller, so every line can be
 * read before Apply. With the earlier text, added and removed lines are marked.
 */
function ProposedInstructions({ proposed, previous }: { proposed: string; previous?: string }) {
  const lines = previous === undefined
    ? proposed.split(/\r?\n/u).map((text) => ({ kind: "same" as const, text }))
    : botInstructionsDiff(previous, proposed);
  const marked = lines.some((line) => line.kind !== "same");
  return (
    <div
      role="region"
      aria-label="Proposed instructions"
      // Scrollable by keyboard: the region takes a tab stop and shows the focus ring.
      tabIndex={0}
      className="mt-1 max-h-48 overflow-y-auto rounded-control bg-well px-1.5 py-1.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      data-held-instructions
    >
      {lines.map((line, index) => (
        <Text
          key={index}
          as="p"
          variant="small"
          color={line.kind === "same" ? "secondary" : "primary"}
          className={cn(
            "min-h-[1lh] whitespace-pre-wrap rounded-sm px-1.5 [overflow-wrap:anywhere]",
            line.kind === "added" && "bg-status-green-surface",
            line.kind === "removed" && "bg-status-red-surface line-through",
          )}
          data-line={marked ? line.kind : undefined}
        >
          {line.kind === "added" ? <span className="sr-only">Added: </span> : null}
          {line.kind === "removed" ? <span className="sr-only">Removed: </span> : null}
          {line.text}
        </Text>
      ))}
    </div>
  );
}
