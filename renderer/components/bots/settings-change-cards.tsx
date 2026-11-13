// Settings from chat (docs/plans/bot-ux-simplification.md §4.6). A change the
// Bot made in a run the person started is a receipt line, "Settings updated ·
// Undo", that reads "Restored" once undone. A change from any other run waits
// in the Needs-you slot as "Update instructions?" with Apply, Edit and Dismiss.

import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button, Text } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import { ReceiptLine } from "./receipt-line";
import {
  botSettingsHeldTitle,
  botSettingsReceiptLabel,
  type BotSettingsChangeEntryData,
  type BotSettingsChangeStatus,
} from "../../shared/bot-settings-changes";

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
        settled === "pending"
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
        {botName} asked to change its settings in a run you didn't start.
      </Text>
      {other.length > 0 ? (
        <Text as="p" variant="small" color="secondary">
          {other.join(" · ")}
        </Text>
      ) : null}
      {change.instructions !== undefined ? (
        <Text as="p" variant="small" color="tertiary" className="mt-1 line-clamp-4 whitespace-pre-wrap [overflow-wrap:anywhere]" data-held-instructions>
          {change.instructions}
        </Text>
      ) : null}
    </BotNoticeCard>
  );
}
