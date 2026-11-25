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
  BOT_COMPUTER_SHARED_DEFAULT_NAME,
  BOT_COMPUTER_SHARED_ID,
  type BotComputerAssignTarget,
  type BotComputerVmStatus,
} from "../../shared/bot-computers";
import {
  botInstructionsDiff,
  botSettingsHeldTitle,
  botSettingsReceiptLabel,
  formatBotSettingsComputerLine,
  type BotSettingsChangeEntryData,
  type BotSettingsChangeStatus,
  type BotSettingsField,
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

function targetFromLegacyComputerLine(line: string): BotComputerAssignTarget | undefined {
  if (!line.startsWith("Computer: ")) return undefined;
  const raw = line.slice("Computer: ".length).trim();
  if (!raw || raw === "None") return undefined;
  if (raw === BOT_COMPUTER_SHARED_DEFAULT_NAME || raw === BOT_COMPUTER_SHARED_ID) {
    return { kind: "shared" };
  }
  if (raw === "New dedicated computer") return { kind: "new" };
  const newNamed = /^New dedicated computer \((.+)\)$/u.exec(raw);
  if (newNamed) return { kind: "new", name: newNamed[1] };
  return { kind: "existing", computerId: raw };
}

function resolveHeldComputerTarget(
  target: BotComputerAssignTarget,
  botId: string | undefined,
  computers: readonly BotComputerVmStatus[] | undefined,
  botNames: ReadonlyMap<string, string> | undefined,
): { text: string; sharedWarning?: string } {
  if (target.kind === "new") {
    return { text: formatBotSettingsComputerLine(target) };
  }
  const targetId = target.kind === "shared" ? BOT_COMPUTER_SHARED_ID : target.computerId;
  // Match strictly by exact VM id — never by display name, which can be user/Bot-chosen and collide with another VM's id.
  const matched = computers?.find((vm) => vm.id === targetId);
  if (!matched) {
    return {
      text: formatBotSettingsComputerLine(target, (entry) =>
        entry.kind === "shared"
          ? BOT_COMPUTER_SHARED_DEFAULT_NAME
          : entry.kind === "existing"
            ? entry.computerId
            : "New dedicated computer",
      ),
      sharedWarning:
        target.kind === "shared"
          ? `Bots on ${BOT_COMPUTER_SHARED_DEFAULT_NAME} share one Linux desktop, user (aiden-bot), and Chromium sign-ins.`
          : undefined,
    };
  }
  const otherNames = matched.assignedBotIds
    .filter((id) => id !== botId)
    .map((id) => botNames?.get(id) ?? id);
  const text = formatBotSettingsComputerLine(target, () =>
    otherNames.length > 0 ? `${matched.name} (already used by ${otherNames.join(", ")})` : matched.name,
  );
  const sharedWarning =
    matched.kind === "shared" || otherNames.length > 0
      ? `Bots on ${matched.name} share one Linux desktop, user (aiden-bot), and Chromium sign-ins.`
      : undefined;
  return { text, sharedWarning };
}

export function HeldSettingsCard({
  change,
  botId,
  botName,
  currentInstructions,
  computers,
  botNames,
  onRespond,
  onEdit,
}: {
  change: BotSettingsChangeEntryData;
  botId?: string;
  botName: string;
  /** The Bot's instructions now: what the marks compare against, since the person may have edited them since. */
  currentInstructions?: string;
  /** Known Linux Bot computers, used to resolve computer IDs to VM names and assigned Bots. */
  computers?: readonly BotComputerVmStatus[];
  /** Bot ID -> display name map for showing who is already assigned to a target VM. */
  botNames?: ReadonlyMap<string, string>;
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
  const computerTarget =
    change.computer ??
    (change.fields.includes("computer")
      ? change.lines.map(targetFromLegacyComputerLine).find((target) => target !== undefined)
      : undefined);
  const needsComputersLoaded = Boolean(
    change.fields.includes("computer") && computerTarget !== undefined && computerTarget.kind !== "new",
  );
  const waitingForComputers = needsComputersLoaded && computers === undefined;
  const resolvedComputer = computerTarget
    ? resolveHeldComputerTarget(computerTarget, botId, computers, botNames)
    : undefined;
  const other = change.lines
    .filter((line) => line !== "Instructions")
    .map((line) => (line.startsWith("Computer: ") && resolvedComputer ? resolvedComputer.text : line));
  const sharedWarning = resolvedComputer?.sharedWarning;
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
          <Button
            variant="accent"
            size="small"
            disabled={busy !== null || waitingForComputers}
            onClick={() => respond("apply")}
          >
            {busy === "apply" ? "Applying…" : "Apply"}
          </Button>
        </>
      }
    >
      <Text as="p" variant="small" color="secondary">
        {heldReasonText(botName, change.heldReason ?? "not_owner", change.fields)}
      </Text>
      {waitingForComputers ? (
        <Text as="p" variant="small" color="tertiary">
          Loading computer details…
        </Text>
      ) : other.length > 0 ? (
        <Text as="p" variant="small" color="secondary">
          {other.join(" · ")}
        </Text>
      ) : null}
      {!waitingForComputers && sharedWarning ? (
        <Text as="p" variant="small" color="secondary">
          {sharedWarning}
        </Text>
      ) : null}
      {change.instructions !== undefined ? (
        <>
          <Text as="p" variant="small" color="secondary">
            Apply replaces {botName}&apos;s instructions with this text.
          </Text>
          <ProposedInstructions proposed={change.instructions} previous={currentInstructions ?? change.previousInstructions} />
        </>
      ) : null}
    </BotNoticeCard>
  );
}

function heldReasonText(botName: string, reason: BotSettingsHeldReason, fields: readonly BotSettingsField[]): string {
  switch (reason) {
    case "not_owner":
      return `${botName} asked to change its settings in a run you didn't start.`;
    case "outside_content":
      return `${botName} asked to change its settings after this chat read content from outside it, like a web page or an app's data.`;
    case "widens": {
      const hasComputer = fields.includes("computer");
      const hasReachOut = fields.includes("dailyCheckIns") || fields.includes("notifications");
      if (hasComputer && !hasReachOut) {
        return `${botName} asked to change its Linux computer.`;
      }
      if (hasComputer && hasReachOut) {
        return `${botName} asked to change its Linux computer and reach out to you more on its own.`;
      }
      return `${botName} asked to reach out to you more on its own.`;
    }
  }
}

/**
 * The whole proposed instructions in a bounded scroller, so every line can be
 * read before Apply. Against the instructions as they are now (or, when those
 * can't be read, as they were when proposed), added and removed lines are marked.
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
