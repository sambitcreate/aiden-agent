// A Bot chat's transcript rows (bubbles, recaps, chips and cards), shared by
// the Bot chat, a paired Mac's Bot chat and the bubble mini chat. Every action
// a row offers is an optional callback: a surface that can't do it leaves the
// callback out and the row hides that action (or the row itself).

import * as React from "react";
import { CircleAlert, CircleCheck, CircleSlash, FileText, LogIn, RotateCcw } from "lucide-react";
import { ConnectCard } from "../../components/bots/connect-card";
import { RoutinesSkippedCard } from "../../components/bots/routines-skipped-card";
import { RoutineProposalCard } from "../../components/bots/routine-proposal-card";
import { SkillProposalCard } from "../../components/bots/skill-proposal-card";
import { LearnedLine, LessonProposalCard } from "../../components/bots/lesson-cards";
import { SettingsChangeReceipt } from "../../components/bots/settings-change-cards";
import { BotNoticeCard } from "../../components/bots/bot-notice-card";
import { WakeUpChip } from "../../components/bots/wake-up-chip";
import { ReceiptLine } from "../../components/bots/receipt-line";
import { FoldedSuggestion } from "../../components/bots/suggestion-card";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import { SafeMessageBubble } from "../../components/message-bubble";
import { MessageAttachments } from "../../components/message-attachments";
import { Button, Text } from "../../components/ui";
import { useAppearancePreference } from "../../lib/use-appearance-preference";
import type { BotSettingsChangeStatus } from "../../shared/bot-settings-changes";
import type { BotChatActivityLevel } from "../../shared/bots";
import { BOT_FAILED_TURN_TEXT, type BotQueuedMessage, type BotTranscriptEntry } from "../../shared/bot-live";
import type { BotHandoffOutcome } from "../../shared/bot-handoffs";
import type {
  BotRoutineProposalDecision,
  BotRoutineProposalDeclineReason,
  BotRoutineProposalRespondResult,
} from "../../shared/bot-routine-proposals";
import { BotActivityRecap } from "./bot-activity-recap";
import { BotMessageActions } from "./bot-message-actions";
import { botTranscriptRows } from "./bot-transcript-rows";

export const BOT_INTERRUPTED_TEXT = "I got interrupted while working on this.";

/** "I couldn't finish that reply." with Retry, which resends the message as a new submission. */
export function BotFailedTurnCard({
  name,
  retryable,
  busy,
  errorMessage,
  onRetry,
}: {
  name: string;
  retryable: boolean;
  busy: boolean;
  errorMessage?: string;
  onRetry(): void;
}) {
  return (
    <BotNoticeCard
      label={`${name} couldn’t finish a reply`}
      icon={<CircleAlert />}
      iconTone="red"
      title={BOT_FAILED_TURN_TEXT}
      actions={
        retryable ? (
          <Button variant="filled" size="small" disabled={busy} onClick={onRetry}>
            <RotateCcw /> Retry
          </Button>
        ) : undefined
      }
    >
      {errorMessage ? <p className="whitespace-pre-wrap">{errorMessage}</p> : null}
    </BotNoticeCard>
  );
}

/** A file the Bot wrote: a chip that opens the panel's Files tab at that file. */
function BotFileChip({ path, operation, onOpen }: { path: string; operation: "written" | "edited"; onOpen(): void }) {
  const name = path.split("/").pop() || path;
  return (
    <div>
      <Button
        variant="filled"
        size="medium"
        className="max-w-full gap-2"
        aria-label={`Open ${name}`}
        title={path}
        onClick={onOpen}
      >
        <FileText aria-hidden="true" />
        <span className="truncate">{name}</span>
        <span className="text-secondary">{operation === "edited" ? "Edited" : "Created"}</span>
      </Button>
    </div>
  );
}

/** "Memory updated · Open": a receipt line that opens the panel's Memory tab. */
function BotMemoryUpdatedCaption({ onOpen }: { onOpen(): void }) {
  return <ReceiptLine icon={<MemoryCardIcon />} text="Memory updated" actions={[{ label: "Open", ariaLabel: "Memory updated. Open Memory", onClick: onOpen }]} />;
}

/** The person's answer to a hand-off card, on their side of the chat: what they did, then their note. */
function BotHandoffResultBubble({
  outcome,
  signedIn,
  text,
  note,
}: {
  outcome: BotHandoffOutcome;
  signedIn: boolean;
  text: string;
  note?: string;
}) {
  const Icon = outcome === "skipped" ? CircleSlash : signedIn ? LogIn : CircleCheck;
  return (
    <div className="flex justify-end" data-bot-handoff-result={outcome}>
      <div className="flex max-w-[80%] select-text items-start gap-2 rounded-2xl bg-control px-4 py-2.5">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-secondary" />
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <p className="text-regular text-primary">{text}</p>
          {note ? <p className="mt-0.5 whitespace-pre-wrap text-small text-secondary">{note}</p> : null}
        </div>
      </div>
    </div>
  );
}

const QUEUED_PREVIEW_CHARS = 40;

/** A follow-up waiting for the running turn: a faded bubble surface, "Queued", and Remove when it can be withdrawn. */
export function BotQueuedBubble({
  text,
  removing,
  onRemove,
}: {
  text: string;
  removing: boolean;
  onRemove?(button: HTMLButtonElement): void;
}) {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  const preview = oneLine.length > QUEUED_PREVIEW_CHARS ? `${oneLine.slice(0, QUEUED_PREVIEW_CHARS).trimEnd()}…` : oneLine;
  return (
    <div className="flex flex-col items-end gap-1" data-bot-queued>
      <div className="max-w-full [&_.bg-control]:bg-[color-mix(in_srgb,var(--color-control)_55%,transparent)]">
        <SafeMessageBubble role="user" content={text} showCopy={false} />
      </div>
      <div className="flex items-center gap-2 text-small text-tertiary">
        <span>Queued</span>
        {onRemove ? (
          <Button
            variant="transparent"
            size="small"
            disabled={removing}
            aria-label={`Remove queued message: ${preview}`}
            data-bot-queued-remove
            onClick={(event) => onRemove(event.currentTarget)}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Chat transcript rows: bubbles, recaps, chips, cards. A paired host's Bot
 * chat leaves out the actions its host does not offer remotely.
 */
export function TranscriptEntries({
  name,
  entries,
  partial,
  running,
  level,
  queued,
  removing,
  retrying,
  onRemoveQueued,
  onConnect,
  onDismissConnection,
  onAddConnection,
  onOpenFile,
  onReply,
  onRetry,
  onOpenMemory,
  onViewExchange,
  onRunRoutine,
  onRespondToProposal,
  onNewRoutineLink,
  proposalDeclineReasons = true,
  onRespondToSkill,
  onRespondToLesson,
  onUndoLearning,
  onUndoSettings,
  wakeUpPending,
  onCancelWakeUp,
  connectLabel,
  connecting,
}: {
  name: string;
  entries: readonly BotTranscriptEntry[];
  partial: string | null;
  running: boolean;
  level: BotChatActivityLevel;
  queued: readonly BotQueuedMessage[];
  removing: ReadonlySet<string>;
  retrying: boolean;
  onRemoveQueued?(submissionId: string, button: HTMLButtonElement): void;
  onConnect(pluginId: string): void;
  onDismissConnection?(pluginId: string): void;
  /** Connect on an app connected in Aiden but left out of the Bot's access. */
  onAddConnection?(pluginId: string): void;
  onOpenFile?(path: string): void;
  onReply(text: string): void;
  onRetry(failedId: string, text: string): void;
  onOpenMemory?(): void;
  onViewExchange?(exchangeId: string): void;
  /** Run now on a routine skipped while paused; rejects when it didn't start. Absent where routines can't run. */
  onRunRoutine?(routineId: string): Promise<void>;
  onRespondToProposal?(
    proposalId: string,
    decision: BotRoutineProposalDecision,
    reason?: BotRoutineProposalDeclineReason,
  ): Promise<BotRoutineProposalRespondResult | null>;
  /** A new link for a link routine a card added; the old one stops working. */
  onNewRoutineLink?(routineId: string): Promise<string | null>;
  /** Whether a routine suggestion's Not now offers "Why not?"; off where the reason can't be recorded. */
  proposalDeclineReasons?: boolean;
  /** One action on a "Needs you" issue card. */
  /** Undo on a "Settings updated" receipt; resolves to its settled status. */
  onUndoSettings?(changeId: string): Promise<BotSettingsChangeStatus>;
  /** Keep or decline a lesson from a routine's runs. */
  onRespondToLesson?(lessonId: string, decision: "keep" | "dismiss"): Promise<"active" | "dismissed" | null>;
  /** Undo a correction lesson or the newest memory tidy. */
  onUndoLearning?(target: { kind: "lesson"; lessonId: string } | { kind: "change"; changeId: string }): Promise<void>;
  /** Add or decline a proposed (or found) skill. */
  onRespondToSkill?(proposalId: string, decision: "add" | "dismiss"): Promise<"added" | "dismissed" | null>;
  /** Whether a wake-up the Bot set still waits; `undefined` while that is unknown. */
  wakeUpPending?(wakeUpId: string): boolean | undefined;
  /** Cancel on a wake-up chip; rejects (after saying why) when it couldn't. */
  onCancelWakeUp?(wakeUpId: string): Promise<void>;
  /** Connect cards' button text, e.g. where the connection is finished. */
  connectLabel?: string;
  /** A connection request is being sent. */
  connecting?: boolean;
}) {
  const rows = botTranscriptRows(entries, partial, { running, level, queued });
  // One suggestion in full per chat (§4.7): the newest one waiting, or the one
  // the person chose to see; earlier ones fold to a line with Show.
  const [chosenSuggestion, setChosenSuggestion] = React.useState<string | null>(null);
  const waitingSuggestions = rows
    .filter((row) =>
      (row.kind === "routine_proposal" && row.status === "pending" && !row.supersededBy && onRespondToProposal !== undefined) ||
      (row.kind === "skill_proposal" && row.status === "pending" && onRespondToSkill !== undefined) ||
      (row.kind === "lesson_proposal" && row.status === "pending" && onRespondToLesson !== undefined))
    .map((row) => row.id);
  const shownSuggestion =
    chosenSuggestion !== null && waitingSuggestions.includes(chosenSuggestion) ? chosenSuggestion : waitingSuggestions[waitingSuggestions.length - 1];
  const folded = (id: string, label: string) =>
    waitingSuggestions.includes(id) && id !== shownSuggestion ? (
      <FoldedSuggestion key={id} label={label} onShow={() => setChosenSuggestion(id)} />
    ) : null;
  const workDetails = useAppearancePreference("workDetails");
  const collapseTiming = useAppearancePreference("workDetailsCollapseTiming");
  const retainedRecaps = React.useMemo(() => {
    let latestUserIndex = 0;
    entries.forEach((entry, index) => { if (entry.type === "user" || entry.type === "bot_message") latestUserIndex = index; });
    return new Set(entries.slice(latestUserIndex).map((entry) => `${entry.id}:recap`));
  }, [entries]);
  return (
    <>
      {rows.map((row) => {
        switch (row.kind) {
          case "user":
            return (
              <BotMessageActions key={row.id} text={row.text} from="You" align="end" onReply={onReply}>
                <SafeMessageBubble role="user" content={row.text} showCopy={false} />
              </BotMessageActions>
            );
          case "handoff_result":
            return (
              <BotMessageActions
                key={row.id}
                text={row.note ? `${row.text}\n${row.note}` : row.text}
                from="You"
                align="end"
                onReply={onReply}
              >
                <BotHandoffResultBubble
                  outcome={row.outcome}
                  signedIn={row.signedIn}
                  text={row.text}
                  {...(row.note ? { note: row.note } : {})}
                />
              </BotMessageActions>
            );
          case "bot_message":
            return (
              <div key={row.id} className="flex flex-col items-end gap-1">
                <Text as="p" variant="small" color="secondary">{row.label}</Text>
                <div className="w-full min-w-0">
                  <BotMessageActions text={row.text} from={row.botName} align="end" onReply={onReply}>
                    <SafeMessageBubble role="user" content={row.text} showCopy={false} />
                  </BotMessageActions>
                </div>
              </div>
            );
          case "bot_message_status":
            return (
              <div key={row.id}>
                <Text as="p" variant="small" color="secondary" role="note">{row.label}</Text>
                {row.text ? <SafeMessageBubble role="assistant" content={row.text} showCopy={false} /> : null}
              </div>
            );
          case "routine":
            return (
              <React.Fragment key={row.id}>
                <Text as="p" variant="small" color="secondary" data-bot-routine-label>
                  {row.label}
                </Text>
                <BotMessageActions text={row.text} from="You" align="end" onReply={onReply}>
                  <SafeMessageBubble role="user" content={row.text} showCopy={false} />
                </BotMessageActions>
              </React.Fragment>
            );
          case "peer":
            return <div key={row.id} className="flex flex-wrap items-center gap-2 py-1" role="note"><Text variant="small" color="secondary">{row.messageKind === "result" ? "Exchange update" : row.messageKind === "fyi" ? "FYI" : row.messageKind[0]!.toUpperCase() + row.messageKind.slice(1)} {row.direction === "sent" ? "to" : "from"} {row.peerName}</Text>{onViewExchange && <Button size="small" variant="transparent" onClick={() => onViewExchange(row.exchangeId)}>View exchange</Button>}</div>;
          case "assistant":
            return (
              <BotMessageActions key={row.id} text={row.text} from={name} align="start" onReply={onReply}>
                <SafeMessageBubble imageScope={row.id} role="assistant" content={row.text} showCopy={false} streaming={row.streaming} />
              </BotMessageActions>
            );
          case "recap":
            return <BotActivityRecap key={row.id} steps={row.steps} durationMs={row.durationMs} live={row.live} level={level} mode={workDetails} retainDetails={collapseTiming === "next-input" && retainedRecaps.has(row.id)} />;
          case "queued":
            return (
              <BotQueuedBubble
                key={row.id}
                text={row.text}
                removing={removing.has(row.submissionId)}
                {...(onRemoveQueued ? { onRemove: (button: HTMLButtonElement) => onRemoveQueued(row.submissionId, button) } : {})}
              />
            );
          case "stopped":
            return (
              <Text key={row.id} as="p" variant="small" color="tertiary" role="note" className="py-1 text-center">
                You stopped this reply.
              </Text>
            );
          case "file":
            return onOpenFile ? (
              <BotFileChip key={row.id} path={row.path} operation={row.operation} onOpen={() => onOpenFile(row.path)} />
            ) : null;
          case "image":
            return (
              <MessageAttachments
                key={row.id}
                role="assistant"
                attachments={[{ id: row.id, name: row.name, mimeType: row.mimeType, kind: "image", size: row.size, data: row.data }]}
              />
            );
          case "notice":
            return (
              <Text key={row.id} as="p" variant="small" color="tertiary" role="note" className="py-1 text-center">
                {row.notice === "session_reset" ? "This conversation was reset." : BOT_INTERRUPTED_TEXT}
              </Text>
            );
          case "connect":
            return (
              <ConnectCard
                key={row.id}
                card={row.card}
                onConnect={onConnect}
                {...(onDismissConnection ? { onDismiss: onDismissConnection } : {})}
                {...(onAddConnection ? { onAddToBot: onAddConnection } : {})}
                {...(connectLabel ? { connectLabel } : {})}
                busy={connecting ?? false}
              />
            );
          case "failed":
            return (
              <BotFailedTurnCard
                key={row.id}
                name={name}
                retryable={row.retryText !== null}
                busy={retrying}
                {...(row.errorMessage ? { errorMessage: row.errorMessage } : {})}
                onRetry={() => row.retryText !== null && onRetry(row.id, row.retryText)}
              />
            );
          case "memory_update":
            return onOpenMemory ? <BotMemoryUpdatedCaption key={row.id} onOpen={onOpenMemory} /> : null;
          case "routines_skipped":
            return onRunRoutine ? <RoutinesSkippedCard key={row.id} routines={row.routines} onRunNow={onRunRoutine} /> : null;
          case "routine_proposal":
            return folded(row.id, `Routine suggestion: ${row.proposal.name}`) ?? (onRespondToProposal ? (
              <RoutineProposalCard
                key={row.id}
                proposal={row.proposal}
                status={row.status}
                {...(row.routineId ? { routineId: row.routineId } : {})}
                {...(row.supersededBy ? { supersededBy: row.supersededBy } : {})}
                onRespond={(decision, reason) => onRespondToProposal(row.proposal.proposalId, decision, reason)}
                {...(onNewRoutineLink ? { onNewLink: onNewRoutineLink } : {})}
                declineReasons={proposalDeclineReasons}
              />
            ) : null);
          case "lesson_proposal":
            return folded(row.id, `Lesson: ${row.lesson.lesson}`) ?? (onRespondToLesson ? (
              <LessonProposalCard
                key={row.id}
                lesson={row.lesson}
                status={row.status}
                onRespond={(decision) => onRespondToLesson(row.lesson.lessonId, decision)}
              />
            ) : null);
          case "lesson_learned":
            return onUndoLearning ? (
              <LearnedLine
                key={row.id}
                text={`Learned: ${row.lesson.lesson}`}
                undone={row.status === "retired"}
                onUndo={() => onUndoLearning({ kind: "lesson", lessonId: row.lesson.lessonId })}
              />
            ) : null;
          case "memory_tidy":
            return onUndoLearning && row.changeId ? (
              <LearnedLine key={row.id} text="Tidied memory" undone={false} onUndo={() => onUndoLearning({ kind: "change", changeId: row.changeId! })} />
            ) : null;
          case "wake_up":
            return (
              <WakeUpChip
                key={row.id}
                fireAt={row.fireAt}
                pending={wakeUpPending?.(row.wakeUpId)}
                {...(onCancelWakeUp ? { onCancel: () => onCancelWakeUp(row.wakeUpId) } : {})}
              />
            );
          case "skill_proposal":
            return folded(row.id, `Skill: ${row.proposal.name}`) ?? (onRespondToSkill ? (
              <SkillProposalCard
                key={row.id}
                proposal={row.proposal}
                status={row.status}
                onRespond={(decision) => onRespondToSkill(row.proposal.proposalId, decision)}
              />
            ) : null);
          case "settings_change":
            return (
              <SettingsChangeReceipt
                key={row.id}
                change={row.change}
                status={row.change.mode === "applied" ? row.status : row.status === "pending" ? "applied" : row.status}
                onUndo={onUndoSettings ? () => onUndoSettings(row.change.changeId) : undefined}
              />
            );
        }
      })}
    </>
  );
}
