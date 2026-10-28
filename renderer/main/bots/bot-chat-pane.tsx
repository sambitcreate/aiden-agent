// A Bot's one conversation, rendered from the durable projection (`useBotLive`).
// Sends go through `bots:send` with a fresh request UUID per message, so a retried
// send never doubles. Stop, Resume and Dismiss map to their runtime actions.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleSlash, FileText, LogIn, Pause, RotateCcw, ShieldQuestion, Square } from "lucide-react";
import { AskUserQuestionComposer } from "../../components/ask-user-question-composer";
import { Composer } from "../../components/composer";
import { ConnectCard } from "../../components/bots/connect-card";
import { RoutinesSkippedCard } from "../../components/bots/routines-skipped-card";
import { RoutineProposalCard } from "../../components/bots/routine-proposal-card";
import { SkillProposalCard } from "../../components/bots/skill-proposal-card";
import { LearnedLine, LessonProposalCard } from "../../components/bots/lesson-cards";
import { BotIssueCard } from "../../components/bots/bot-issue-card";
import { HandoffCard, handoffNoNoteComposerText, handoffSignInComposerText } from "../../components/bots/handoff-card";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import { toolLabel } from "../../components/chat-approval-card";
import { SafeMessageBubble } from "../../components/message-bubble";
import { MessageAttachmentPreviewProvider, MessageAttachments } from "../../components/message-attachments";
import { insertTextIntoTextarea } from "../../lib/composer-type-focus";
import { Button, Callout, EmptyState, ScrollArea, Text, toast } from "../../components/ui";
import { BotNoticeCard } from "../../components/bots/bot-notice-card";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { Attachment } from "../../lib/types";
import { resolveBotChatActivity, type BotChatActivityLevel } from "../../shared/bots";
import { queryKeys, useBot } from "../../lib/queries";
import { useBotLive } from "../../lib/use-bot-live";
import { prefersReducedMotion } from "../../lib/appearance-runtime";
import {
  BOT_FAILED_TURN_TEXT,
  botLastReplyAt,
  type BotLiveSnapshot,
  type BotPendingQuestion,
  type BotQueuedMessage,
  type BotTranscriptEntry,
} from "../../shared/bot-live";
import type { AskUserQuestionPromptV1, AskUserQuestionResponseV1 } from "../../shared/ask-user-question";
import {
  BOT_HANDOFF_NOTE_MAX_CHARS,
  botHandoffTakesNote,
  type BotHandoffOutcome,
  type BotPendingHandoff,
} from "../../shared/bot-handoffs";
import type { BotApprovalPrompt } from "../../../main/services/bot-runtime/bot-approvals";
import type { BotRoutineProposalDecision,
  BotRoutineProposalDeclineReason, BotRoutineProposalRespondResult } from "../../shared/bot-routine-proposals";
import type { BotIssueAction } from "../../shared/bot-issues";
import { BotChatActions, BotChatNamePill, BotPanelToggle } from "./bot-chat-header";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bot-chat-mode";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotNeedsModel } from "./bot-needs-model";
import { BotPausedCard, botPausedText } from "./bot-paused-card";
import { BotActivityRecap } from "./bot-activity-recap";
import { BotStatusAnnouncer, BotStatusLine, botStatusSpeech } from "./bot-status-line";
import { BotMessageActions, botReplyQuote } from "./bot-message-actions";
import { useBotMenuActions } from "./bot-menu";
import { useBotPanelActions } from "./bot-panel-context";
import { useBotHandoffActions } from "./use-bot-handoff-actions";
import { botSidebarPreferenceActions, useIsBotPinned } from "./use-bot-sidebar-preferences";
import { botTranscriptRows } from "./bot-transcript-rows";
import { BOT_UNAVAILABLE_LABEL, type BotSessionState } from "./bot-session-state";
import { botRoutinesKey } from "./bot-routines";
import { useConnectionSetup } from "./use-connection-setup";

export const BOT_INTERRUPTED_TEXT = "I got interrupted while working on this.";
export const BOT_ACCESS_CHANGED_TEXT = "This Bot's access changed. Review it in Advanced.";

/** The Bot's pending-paused notice: Resume continues the turn, Dismiss drops it. */
export function BotInterruptedCard({
  name,
  blocked,
  onResume,
  onDismiss,
  onReviewAccess,
  busy,
}: {
  name: string;
  blocked?: "access_changed" | "bot_missing";
  onResume(): void;
  onDismiss(): void;
  onReviewAccess(): void;
  busy: boolean;
}) {
  const accessChanged = blocked === "access_changed";
  return (
    <BotNoticeCard
      label={`${name} was interrupted`}
      icon={<Pause />}
      iconTone="warning"
      title={BOT_INTERRUPTED_TEXT}
      actions={
        <>
          <Button variant="transparent" size="small" disabled={busy} onClick={onDismiss}>
            Dismiss
          </Button>
          {accessChanged ? (
            <Button variant="accent" size="small" onClick={onReviewAccess}>
              Open Advanced
            </Button>
          ) : (
            <Button variant="accent" size="small" disabled={busy} onClick={onResume}>
              Resume
            </Button>
          )}
        </>
      }
    >
      {accessChanged ? <p>{BOT_ACCESS_CHANGED_TEXT}</p> : null}
    </BotNoticeCard>
  );
}

/** Tool approvals a Bot is waiting on, live: pushed prompts and withdrawals, plus a read on mount. */
function useBotApprovals(botId: string | undefined) {
  const [prompts, setPrompts] = React.useState<BotApprovalPrompt[]>([]);
  React.useEffect(() => {
    if (!botId) return;
    let active = true;
    void botsApi.pendingApprovals(botId).then((pending) => {
      if (active) setPrompts((current) => mergePrompts(current, pending));
    }).catch(() => undefined);
    const offPrompt = botsApi.onApproval((prompt) => {
      if (prompt.botId === botId) setPrompts((current) => mergePrompts(current, [prompt]));
    });
    const offSettled = botsApi.onApprovalSettled((settled) => {
      if (settled.botId === botId) {
        setPrompts((current) => current.filter((prompt) => prompt.waitId !== settled.waitId));
      }
    });
    return () => {
      active = false;
      offPrompt();
      offSettled();
    };
  }, [botId]);
  const remove = React.useCallback(
    (waitId: string) => setPrompts((current) => current.filter((prompt) => prompt.waitId !== waitId)),
    [],
  );
  /** Puts a prompt back after its answer failed to send, so it can be answered again. */
  const restore = React.useCallback(
    (prompt: BotApprovalPrompt) => setPrompts((current) => mergePrompts(current, [prompt])),
    [],
  );
  return { prompts, remove, restore };
}

function mergePrompts(current: BotApprovalPrompt[], next: BotApprovalPrompt[]): BotApprovalPrompt[] {
  const byId = new Map(current.map((prompt) => [prompt.waitId, prompt] as const));
  for (const prompt of next) byId.set(prompt.waitId, prompt);
  return [...byId.values()];
}

/** A Bot's tool call that needs the person's yes or no before it runs. */
export function BotApprovalCard({
  name,
  prompt,
  onAnswer,
  allowElsewhere,
}: {
  name: string;
  prompt: BotApprovalPrompt;
  onAnswer(decision: "allow" | "deny"): void;
  /** Set when this device may only deny: where the person can allow it instead. */
  allowElsewhere?: string;
}) {
  return (
    <BotNoticeCard
      label={`${name} needs approval`}
      elevated
      icon={<ShieldQuestion />}
      iconTone="warning"
      title={`${name} wants to use ${toolLabel(prompt.toolName)}.`}
      actions={
        <>
          <Button variant="transparent" size="small" onClick={() => onAnswer("deny")}>
            Deny
          </Button>
          {allowElsewhere ? null : (
            <Button variant="accent" size="small" onClick={() => onAnswer("allow")}>
              Allow
            </Button>
          )}
        </>
      }
    >
      {allowElsewhere ? <p>{`Allow it on ${allowElsewhere}.`}</p> : null}
      {prompt.summary ? (
        <p className="mt-1.5 max-h-24 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-well px-3 py-2 text-primary">
          {prompt.summary}
        </p>
      ) : null}
    </BotNoticeCard>
  );
}

/** The Bot's pending A–E question as the shared quick-reply composer's prompt. */
export function questionPrompt(question: BotPendingQuestion): AskUserQuestionPromptV1 {
  return {
    version: 1,
    promptId: question.waitId,
    streamId: "s-bot",
    toolCallId: question.toolCallId,
    questions: question.questions,
  };
}

function attachmentText(attachments: readonly Attachment[]): string {
  return attachments
    .filter((attachment) => attachment.kind === "text" && attachment.text)
    .map((attachment) => `\n\n${attachment.name}:\n${attachment.text}`)
    .join("");
}

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

/** The Bot has a model, but it can't be used right now (sign-in, a missing provider). */
export function BotModelErrorCard({
  name,
  message,
  onChooseModel,
  onOpenProviders,
}: {
  name: string;
  message: string;
  onChooseModel(): void;
  onOpenProviders(): void;
}) {
  return (
    <BotNoticeCard
      role="alert"
      label={`${name} can’t reach its AI model`}
      icon={<CircleAlert />}
      iconTone="red"
      title={`${name} can’t reach its AI model`}
      actions={
        <>
          <Button variant="transparent" size="small" onClick={onOpenProviders}>
            Open Providers
          </Button>
          <Button variant="filled" size="small" onClick={onChooseModel}>
            Choose a model
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-wrap">{message}</p>
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

/** "Memory updated": a quiet, centred caption that opens the panel's Memory tab. */
function BotMemoryUpdatedCaption({ onOpen }: { onOpen(): void }) {
  return (
    <div className="flex justify-center py-1">
      <button
        type="button"
        aria-label="Memory updated. Open Memory"
        className="inline-flex items-center gap-1.5 rounded-button px-2 py-1 text-small text-tertiary outline-none transition-colors duration-(--motion-duration) ease-standard hover:bg-list-hover hover:text-secondary focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
        onClick={onOpen}
      >
        <MemoryCardIcon aria-hidden="true" className="size-3.5" />
        Memory updated
      </button>
    </div>
  );
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
function BotQueuedBubble({
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
/**
 * A message the person just sent, shown at once while main accepts it. It
 * looks like the entry it becomes (same row, same Copy and Reply), so the
 * hand-over is invisible. It never says "Sending…": the "Getting ready" line
 * below the transcript carries a slow start.
 * A message sent while the Bot works shows as Queued straight away. It leaves
 * when the projected entry (or the queued message) with the same words
 * arrives, or when the send fails.
 */
function BotPendingSendBubble({
  send,
  morphFrom,
  onMorphEnd,
  onReply,
}: {
  send: BotPendingSend;
  /** Where the words sat in the composer: the bubble grows out of them. */
  morphFrom?: BotSendMorphOrigin;
  onMorphEnd(): void;
  onReply(text: string): void;
}) {
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  useSendMorph(rowRef, morphFrom, onMorphEnd);
  return (
    <div ref={rowRef}>
      {send.queued ? (
        <BotQueuedBubble text={send.text} removing={false} />
      ) : (
        <div className="flex flex-col gap-1" data-bot-pending-send aria-busy={!send.accepted}>
          <BotMessageActions text={send.text} from="You" align="end" onReply={onReply}>
            <SafeMessageBubble role="user" content={send.text} showCopy={false} />
          </BotMessageActions>
        </div>
      )}
    </div>
  );
}

/** The top-left of the text in the composer when Send was pressed, in viewport pixels. */
interface BotSendMorphOrigin {
  left: number;
  top: number;
}

/** Where the composer's words start, or null when nothing should move (Reduce Motion, no layout). */
function botSendMorphOrigin(box: HTMLTextAreaElement | null): BotSendMorphOrigin | null {
  if (!box || typeof box.animate !== "function" || prefersReducedMotion()) return null;
  const rect = box.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const style = getComputedStyle(box);
  return {
    left: rect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0) - box.scrollLeft,
    top: rect.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0) - box.scrollTop,
  };
}

/** How long the words take to travel from the composer into their bubble. */
const SEND_MORPH_MS = 90;

/**
 * The sent words leave the composer and become their bubble: a copy of the
 * bubble starts as bare text where the words sat in the composer, then arcs
 * to the bubble's place as its fill comes in. The copy floats above the chat
 * (the transcript clips anything over the composer) while the real bubble
 * holds its space unseen, and it is swapped for the real one when it lands.
 */
function useSendMorph(
  rowRef: React.RefObject<HTMLDivElement | null>,
  morphFrom: BotSendMorphOrigin | undefined,
  onMorphEnd: () => void,
) {
  const [origin] = React.useState(morphFrom);
  const ended = React.useRef(onMorphEnd);
  ended.current = onMorphEnd;
  React.useLayoutEffect(() => {
    if (!origin) return;
    const bubble = rowRef.current?.querySelector<HTMLElement>(".bg-control");
    if (!bubble) {
      ended.current();
      return;
    }
    bubble.style.visibility = "hidden";
    let ghost: HTMLElement | null = null;
    let sideways: Animation | null = null;
    let animation: Animation | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ghost?.remove();
      bubble.style.visibility = "";
      ended.current();
    };
    // After layout and the transcript's scroll to its end, so the bubble's place is final.
    const frame = requestAnimationFrame(() => {
      const target = bubble.getBoundingClientRect();
      const style = getComputedStyle(bubble);
      const copy = bubble.cloneNode(true) as HTMLElement;
      copy.setAttribute("aria-hidden", "true");
      copy.style.cssText = "";
      Object.assign(copy.style, {
        position: "fixed",
        left: `${target.left}px`,
        top: `${target.top}px`,
        width: `${target.width}px`,
        height: `${target.height}px`,
        margin: "0",
        boxSizing: "border-box",
        pointerEvents: "none",
        zIndex: "60",
        font: style.font,
        color: style.color,
        letterSpacing: style.letterSpacing,
      });
      document.body.appendChild(copy);
      ghost = copy;
      const dx = origin.left - (target.left + (parseFloat(style.paddingLeft) || 0));
      const dy = origin.top - (target.top + (parseFloat(style.paddingTop) || 0));
      // Both axes ease in and out, the sideways one ahead of the rise, so the
      // words arc into place (across first, then up) instead of sliding straight.
      sideways = copy.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], {
        duration: SEND_MORPH_MS,
        easing: "cubic-bezier(0.35, 0, 0.15, 1)",
      });
      animation = copy.animate(
        [
          { transform: `translateY(${dy}px)`, backgroundColor: "transparent" },
          { transform: "translateY(0)", backgroundColor: style.backgroundColor },
        ],
        { duration: SEND_MORPH_MS, easing: "cubic-bezier(0.6, 0, 0.35, 1)" },
      );
      animation.onfinish = finish;
      animation.oncancel = finish;
    });
    return () => {
      cancelAnimationFrame(frame);
      sideways?.cancel();
      animation?.cancel();
      finish();
    };
  }, [origin, rowRef]);
}

/** A send shown before main answers; `seen` names what was already on screen when it was made. */
interface BotPendingSend {
  requestId: string;
  text: string;
  /** Entry ids and queued submission ids present when the echo was made; a new one with the same text settles it. */
  seen: ReadonlySet<string>;
  /** When it was sent, for the "Getting ready" line. */
  at: number;
  /** A follow-up sent while the Bot worked: it shows as Queued, and starts no turn of its own. */
  queued: boolean;
  /** Main took it; only its entry is still on the way. */
  accepted: boolean;
}

/** The ids of everything a snapshot shows that a pending send could settle into. */
function botVisibleSendIds(snapshot: BotLiveSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const entry of snapshot.entries) if (entry.type === "user") ids.add(entry.id);
  for (const message of snapshot.queued ?? []) ids.add(`queued:${message.submissionId}`);
  return ids;
}

/**
 * Pairs each pending send with what the snapshot now shows for it: a user
 * entry, or a queued message, with the same text that was not there when the
 * echo was made. Keyed by request id; the value is the arrival's id.
 */
function matchBotPendingSends(pending: readonly BotPendingSend[], snapshot: BotLiveSnapshot): Map<string, string> {
  const matches = new Map<string, string>();
  if (pending.length === 0) return matches;
  const arrivals = [
    ...snapshot.entries.flatMap((entry) => (entry.type === "user" ? [{ id: entry.id, text: entry.text }] : [])),
    ...(snapshot.queued ?? []).map((message) => ({ id: `queued:${message.submissionId}`, text: message.text })),
  ];
  const taken = new Set<string>();
  for (const send of pending) {
    const match = arrivals.find((arrival) => !taken.has(arrival.id) && !send.seen.has(arrival.id) && arrival.text === send.text);
    if (!match) continue;
    taken.add(match.id);
    matches.set(send.requestId, match.id);
  }
  return matches;
}

/** Whether the chat draws nothing after this arrival, so the echo below the transcript stands in its place. */
function botArrivalDrawnLast(snapshot: BotLiveSnapshot, arrivalId: string): boolean {
  const queued = snapshot.queued ?? [];
  const lastQueued = queued[queued.length - 1];
  if (lastQueued) return arrivalId === `queued:${lastQueued.submissionId}`;
  return snapshot.entries[snapshot.entries.length - 1]?.id === arrivalId && !snapshot.partial?.trim();
}

/**
 * Drops every pending send that the snapshot now shows, except those in
 * `holding` (still moving into place), whose arrival stays hidden meanwhile.
 */
export function settleBotPendingSends(
  pending: readonly BotPendingSend[],
  snapshot: BotLiveSnapshot,
  holding: ReadonlySet<string> = new Set(),
): BotPendingSend[] {
  if (pending.length === 0) return pending as BotPendingSend[];
  const matches = matchBotPendingSends(pending, snapshot);
  return pending.filter((send) => holding.has(send.requestId) || !matches.has(send.requestId));
}

/** How long an acknowledged send stays as an echo when its entry never shows (a hidden input, a routine). */
const PENDING_SEND_SETTLE_MS = 4000;

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
  onOpenFile,
  onReply,
  onRetry,
  onOpenMemory,
  onRunRoutine,
  onRespondToProposal,
  onNewRoutineLink,
  onRespondToSkill,
  onRespondToLesson,
  onUndoLearning,
  onActOnIssue,
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
  onOpenFile?(path: string): void;
  onReply(text: string): void;
  onRetry(failedId: string, text: string): void;
  onOpenMemory?(): void;
  /** Run now on a routine skipped while paused; rejects when it didn't start. Absent where routines can't run. */
  onRunRoutine?(routineId: string): Promise<void>;
  onRespondToProposal?(
    proposalId: string,
    decision: BotRoutineProposalDecision,
    reason?: BotRoutineProposalDeclineReason,
  ): Promise<BotRoutineProposalRespondResult | null>;
  /** A new link for a link routine a card added; the old one stops working. */
  onNewRoutineLink?(routineId: string): Promise<string | null>;
  /** One action on a "Needs you" issue card. */
  onActOnIssue?(issueId: string, action: BotIssueAction): Promise<void>;
  /** Keep or decline a lesson from a routine's runs. */
  onRespondToLesson?(lessonId: string, decision: "keep" | "dismiss"): Promise<"active" | "dismissed" | null>;
  /** Undo a correction lesson or the newest memory tidy. */
  onUndoLearning?(target: { kind: "lesson"; lessonId: string } | { kind: "change"; changeId: string }): Promise<void>;
  /** Add or decline a proposed (or found) skill. */
  onRespondToSkill?(proposalId: string, decision: "add" | "dismiss"): Promise<"added" | "dismissed" | null>;
  /** Connect cards' button text, e.g. where the connection is finished. */
  connectLabel?: string;
  /** A connection request is being sent. */
  connecting?: boolean;
}) {
  const rows = botTranscriptRows(entries, partial, { running, level, queued });
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
          case "assistant":
            return (
              <BotMessageActions key={row.id} text={row.text} from={name} align="start" onReply={onReply}>
                <SafeMessageBubble role="assistant" content={row.text} showCopy={false} streaming={row.streaming} />
              </BotMessageActions>
            );
          case "recap":
            return <BotActivityRecap key={row.id} steps={row.steps} durationMs={row.durationMs} live={row.live} level={level} />;
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
            return onRespondToProposal ? (
              <RoutineProposalCard
                key={row.id}
                proposal={row.proposal}
                status={row.status}
                {...(row.routineId ? { routineId: row.routineId } : {})}
                {...(row.supersededBy ? { supersededBy: row.supersededBy } : {})}
                onRespond={(decision, reason) => onRespondToProposal(row.proposal.proposalId, decision, reason)}
                {...(onNewRoutineLink ? { onNewLink: onNewRoutineLink } : {})}
              />
            ) : null;
          case "lesson_proposal":
            return onRespondToLesson ? (
              <LessonProposalCard
                key={row.id}
                lesson={row.lesson}
                status={row.status}
                onRespond={(decision) => onRespondToLesson(row.lesson.lessonId, decision)}
              />
            ) : null;
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
          case "skill_proposal":
            return onRespondToSkill ? (
              <SkillProposalCard
                key={row.id}
                proposal={row.proposal}
                status={row.status}
                onRespond={(decision) => onRespondToSkill(row.proposal.proposalId, decision)}
              />
            ) : null;
          case "issue":
            return onActOnIssue ? (
              <BotIssueCard
                key={row.id}
                issue={row.issue}
                status={row.status}
                onAct={(action) => onActOnIssue(row.issue.id, action)}
              />
            ) : null;
        }
      })}
    </>
  );
}

/** Bubble-shaped placeholders while a chat opens. */
function BotChatSkeleton() {
  return (
    <div role="status" aria-label="Loading chat" className="aiden-dock-inset chat-content-column flex flex-col gap-4 py-6">
      <div className="ml-auto h-9 w-48 rounded-card bg-well motion-safe:animate-pulse" />
      <div className="h-16 w-72 max-w-full rounded-card bg-well motion-safe:animate-pulse" />
      <div className="ml-auto h-9 w-36 rounded-card bg-well motion-safe:animate-pulse" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function BotChatPane({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const bot = useBot(botId);
  const live = useBotLive(botId);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const panel = useBotPanelActions();
  // Only the pin is read here, so another Bot's view or pin never redraws the transcript.
  const pinned = useIsBotPinned(botId);
  const { markViewed } = botSidebarPreferenceActions;
  const menuAction = useBotMenuActions(() => setDeleteOpen(true));
  const [retrying, setRetrying] = React.useState(false);
  const [removing, setRemoving] = React.useState<ReadonlySet<string>>(new Set());
  // The interrupted card leaves the moment Resume or Dismiss is clicked and
  // comes back only if that request fails; `interruptedRequestIds` keeps one
  // request id per interrupted turn so a second click after a failure replays,
  // never doubles. A Bot the person paused shows BotPausedCard instead.
  const [hiddenInterruptedSubmission, setHiddenInterruptedSubmission] = React.useState<string | null>(null);
  const interruptedRequestIds = React.useRef(new Map<string, string>());
  // Sends show at once as pending echoes, each under one request id. A send
  // that failed keeps its id, so the same words sent again are deduplicated by
  // main instead of delivered twice; Retry reuses one id per failed turn.
  const [pendingSends, setPendingSends] = React.useState<readonly BotPendingSend[]>([]);
  // Sends whose words are still moving from the composer into their bubble:
  // each keeps its echo until it lands, and the entry that answers it waits unseen.
  const sendMorphs = React.useRef(new Map<string, BotSendMorphOrigin>());
  const [morphing, setMorphing] = React.useState<ReadonlySet<string>>(() => new Set());
  const unsettledSend = React.useRef<{ text: string; images: string; requestId: string } | null>(null);
  const retryRequestIds = React.useRef(new Map<string, string>());
  // Failed turns whose Retry was sent: main keeps the failed entry in the view, so the card
  // stays hidden here once its retry left; a retry that fails to leave shows it again.
  const [hiddenFailedTurns, setHiddenFailedTurns] = React.useState<ReadonlySet<string>>(() => new Set());
  const [statusLayout, setStatusLayout] = React.useState("");
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const snapshot = live.snapshot;
  const replyAt = snapshot ? botLastReplyAt(snapshot.entries) : null;
  const botFound = Boolean(bot.data);
  // The chat has seen every finished reply it shows: opening it, and each reply
  // that finishes while it is open, move the seen-reply watermark (main's time
  // for that reply) so its unread dot clears. A reply still streaming when the
  // person leaves is not in `entries` yet, so it is unread once it finishes.
  // Leaving records only when the chat was last open. A Bot that is gone (not
  // found, or just deleted) is never marked: its preferences were forgotten with it.
  React.useEffect(() => {
    if (botFound) markViewed(botId, replyAt);
  }, [botFound, botId, replyAt, markViewed]);
  React.useEffect(
    () => () => {
      if (qc.getQueryData(queryKeys.bot(botId))) markViewed(botId, null);
    },
    [botId, markViewed, qc],
  );
  React.useEffect(() => {
    if (!snapshot) return;
    setPendingSends((current) => {
      const next = settleBotPendingSends(current, snapshot, morphing);
      return next.length === current.length ? current : next;
    });
  }, [snapshot, morphing]);
  const state: BotSessionState | undefined = snapshot?.state;
  const running = state?.kind === "running";
  React.useEffect(() => {
    // The card hides for one interrupted turn; any other state (running, idle,
    // paused by the person, or a later interruption) clears that.
    if (hiddenInterruptedSubmission && (state?.kind !== "interrupted" || state.submissionId !== hiddenInterruptedSubmission)) {
      setHiddenInterruptedSubmission(null);
    }
  }, [hiddenInterruptedSubmission, state]);

  const connectionSetup = useConnectionSetup(() => live.reload());
  const approvals = useBotApprovals(botId);
  const [answering, setAnswering] = React.useState(false);
  const handoffActions = useBotHandoffActions(botId, live.snapshot?.handoff?.waitId);

  const back = () => void navigate({ to: "/bots" });
  const current = bot.data ?? null;
  const openAdvanced = () => void navigate({ to: "/bots/$botId", params: { botId }, search: { page: "advanced" } });
  // Memory, Files and Routines live in the side panel beside the chat (spec §8).
  const openMemory = () => panel.show("memory");

  const shell = (body: React.ReactNode, footer?: React.ReactNode) => (
    <ScrollArea
      scrollRestorationId={`bot-chat:${botId}`}
      className="h-full min-h-0"
      alignFooterToScrollContent
      title={
        current ? (
          <BotChatNamePill
            bot={current}
            working={running}
            onOpenProfile={() => void navigate({ to: "/bots/$botId", params: { botId: current.id } })}
          />
        ) : bot.isLoading ? (
          <span className="block h-4 w-28 rounded-full bg-control motion-safe:animate-pulse" aria-hidden="true" />
        ) : (
          "Bot"
        )
      }
      actions={
        current ? (
          <>
            <BotPanelToggle />
            <BotChatActions
              bot={current}
              pinned={pinned}
              paused={state?.kind === "paused"}
              onAction={(action, returnFocus) => menuAction(current, action, returnFocus)}
            />
          </>
        ) : null
      }
      autoScrollToBottom
      autoScrollResetKey={botId}
      autoScrollDeps={[
        snapshot?.entries.length,
        snapshot?.partial,
        state?.kind,
        approvals.prompts.length,
        snapshot?.question?.waitId,
        snapshot?.handoff?.waitId,
        snapshot?.activity?.phase,
        snapshot?.queued?.length ?? 0,
        pendingSends.length,
        statusLayout,
      ]}
      showScrollToBottomButton
      streaming={running}
      footer={footer}
    >
      {body}
      {current ? (
        <BotDeleteDialog bot={current} open={deleteOpen} onOpenChange={setDeleteOpen} />
      ) : null}
      {connectionSetup.dialog}
    </ScrollArea>
  );

  if (bot.isLoading) return shell(<BotChatSkeleton />);
  if (!current) {
    return shell(
      <div className="flex min-h-full items-center justify-center">
        <EmptyState
          title="Bot not found"
          description="This Bot may have been deleted."
          action={
            <Button variant="filled" onClick={back}>
              All Bots
            </Button>
          }
        />
      </div>,
    );
  }
  if (snapshot === null) {
    return shell(
      live.failed ? (
        <div className="flex min-h-full items-center justify-center">
          <EmptyState
            role="alert"
            title="This chat didn’t open"
            description={`Aiden couldn’t load ${current.name}’s chat.`}
            action={
              <Button variant="accent" size="medium" onClick={live.reload}>
                Try again
              </Button>
            }
          />
        </div>
      ) : (
        <BotChatSkeleton />
      ),
    );
  }
  const openProviders = () => void navigate({ to: "/settings", search: { section: "providers" } });

  if (state?.kind === "needs_model") {
    return shell(<BotNeedsModel bot={current} onSetUp={openProviders} />);
  }

  const question = snapshot.question;
  const handoff = snapshot.handoff ?? null;
  const signInWaits = handoff?.kind === "sign_in";
  // A sign-in or a password-or-code card is answered on the card alone: whatever is typed here would reach the Bot.
  const noteRefused = signInWaits || (handoff !== null && !botHandoffTakesNote(handoff));
  const chatActivity = resolveBotChatActivity(current.chatActivity);
  // While the reply's visible words stream, the words are the signal (§5.2). The
  // partial text can outlast narration into a tool call, so a running step keeps the line.
  const activityPhase = snapshot.activity?.phase;
  const replyStreaming =
    running &&
    (snapshot.partial?.trim().length ?? 0) > 0 &&
    (activityPhase === "writing" || activityPhase === "thinking") &&
    !snapshot.activity?.step;
  // Settled here as well as in the effect above, which prunes the state only
  // after paint: an echo leaves in the same frame its entry shows, and what
  // answers a send still moving into place stays unseen until it lands.
  // Something drawn after the arrival (a reply, say) ends the motion early:
  // the echo sits below the whole transcript, so holding on would put the
  // message under its own reply until it landed.
  const sendArrivals = matchBotPendingSends(pendingSends, snapshot);
  const heldArrivals = new Set(
    [...sendArrivals]
      .filter(([requestId, arrivalId]) => morphing.has(requestId) && botArrivalDrawnLast(snapshot, arrivalId))
      .map(([, arrivalId]) => arrivalId),
  );
  const shownSends = pendingSends.filter((send) => {
    const arrivalId = sendArrivals.get(send.requestId);
    return arrivalId === undefined || heldArrivals.has(arrivalId);
  });
  // A message just sent says "Getting ready" at once, before main's state
  // catches up (as on the phones); a failed send drops its echo and the line.
  const startingTurn = !running && !question && !handoff ? shownSends.find((send) => !send.queued) : undefined;
  const statusActivity =
    snapshot.activity && !replyStreaming
      ? snapshot.activity
      : startingTurn
        ? { phase: "preparing" as const, startedAt: startingTurn.at }
        : null;

  /** Shows the echo now; drops it once its entry shows, or shortly after main accepted a send that shows nothing. */
  const echoSend = (requestId: string, text: string, queued = running) => {
    const seen = snapshot ? botVisibleSendIds(snapshot) : new Set<string>();
    const echo: BotPendingSend = { requestId, text, seen, at: Date.now(), queued, accepted: false };
    setPendingSends((current) => [...current.filter((send) => send.requestId !== requestId), echo]);
  };
  const dropEcho = (requestId: string) =>
    setPendingSends((current) => current.filter((send) => send.requestId !== requestId));
  const endMorph = (requestId: string) => {
    sendMorphs.current.delete(requestId);
    setMorphing((current) => {
      if (!current.has(requestId)) return current;
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
  };
  const settleEchoLater = (requestId: string) => {
    setPendingSends((current) =>
      current.map((send) => (send.requestId === requestId ? { ...send, accepted: true } : send)),
    );
    setTimeout(() => dropEcho(requestId), PENDING_SEND_SETTLE_MS);
  };

  const send = async (
    text: string,
    attachments: Attachment[],
    whenBusy?: "steer" | "followUp",
  ): Promise<void> => {
    const images = attachments
      .filter((attachment) => attachment.kind === "image" && attachment.data)
      .map((attachment) => ({ type: "image" as const, mimeType: attachment.mimeType, data: attachment.data! }));
    if (attachments.some((attachment) => attachment.kind !== "image" && attachment.kind !== "text")) {
      toast.error("Bots take photos and text files for now.");
      return;
    }
    const body = `${text}${attachmentText(attachments)}`;
    const imageIdentity = images.map((image) => `${image.mimeType}:${image.data.length}:${image.data.slice(0, 64)}`).join("|");
    // The same words and photos sent again after a failure replay under the first request id.
    const unsettled = unsettledSend.current;
    const requestId =
      unsettled && unsettled.text === body && unsettled.images === imageIdentity ? unsettled.requestId : crypto.randomUUID();
    unsettledSend.current = null;
    // Read before the composer redraws empty: the words still sit where they were typed.
    const origin = text.trim() ? botSendMorphOrigin(composerRef.current) : null;
    if (origin) {
      sendMorphs.current.set(requestId, origin);
      setMorphing((current) => new Set(current).add(requestId));
    }
    // A steer joins the running reply, so it reads as sent; only a follow-up waits as Queued.
    echoSend(requestId, body, running && whenBusy !== "steer");
    try {
      await botsApi.send({
        botId: current.id,
        text: body,
        requestId,
        ...(whenBusy ? { whenBusy } : {}),
        ...(images.length > 0 ? { attachments: images } : {}),
      });
      settleEchoLater(requestId);
    } catch (error) {
      endMorph(requestId);
      dropEcho(requestId);
      unsettledSend.current = { text: body, images: imageIdentity, requestId };
      // The composer gives the words back and shows this as the one error toast.
      throw new Error(userFacingErrorMessage(error, `Aiden couldn’t send to ${current.name}.`));
    }
  };

  /** One request id per interrupted turn and action, so a retry after a failure replays instead of doubling. */
  const interruptedRequestId = (action: "resume" | "dismiss", submissionId: string) => {
    const key = `${action}:${submissionId}`;
    const existing = interruptedRequestIds.current.get(key);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    interruptedRequestIds.current.set(key, minted);
    return minted;
  };

  const answerInterrupted = async (action: "resume" | "dismiss") => {
    if (state?.kind !== "interrupted" || hiddenInterruptedSubmission) return;
    const { submissionId } = state;
    // The card leaves now; main's state event confirms it, and a failure brings it back.
    setHiddenInterruptedSubmission(submissionId);
    try {
      const after =
        action === "resume"
          ? await botsApi.resume(current.id, interruptedRequestId(action, submissionId))
          : await botsApi.dismiss(current.id, interruptedRequestId(action, submissionId));
      // Main answered, so the id is spent: main remembers its answer (even a refusal) per id,
      // and the next click after, say, fixing access must be a new request. Only a thrown
      // IPC error keeps the id for a replay.
      interruptedRequestIds.current.delete(`${action}:${submissionId}`);
      // Main's answer is the state now: a turn still interrupted (for example, blocked) shows its card again.
      if (after.kind === "interrupted") setHiddenInterruptedSubmission(null);
    } catch (error) {
      setHiddenInterruptedSubmission((hidden) => (hidden === submissionId ? null : hidden));
      toast.error(
        userFacingErrorMessage(
          error,
          action === "resume" ? `Aiden couldn’t resume ${current.name}.` : `Aiden couldn’t dismiss that for ${current.name}.`,
        ),
      );
    }
  };
  const resume = () => answerInterrupted("resume");
  const dismiss = () => answerInterrupted("dismiss");

  const answerQuestion = async (question: BotPendingQuestion, response: AskUserQuestionResponseV1) => {
    setAnswering(true);
    try {
      const { answered } = await botsApi.answerQuestion(current.id, question.waitId, response);
      if (!answered) toast.error("That question was already answered or closed.");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t send that answer."));
    } finally {
      setAnswering(false);
    }
  };

  /**
   * What the person types while a hand-off card waits answers it as Done, with
   * their words as the note, whichever way the composer sends. A throw keeps
   * the draft in the composer, which shows the error's message.
   */
  const answerHandoffWithNote = async (pending: BotPendingHandoff, text: string, attachments: Attachment[]) => {
    // Never a note for a sign-in or a password-or-code card: whatever is typed here reaches the Bot.
    if (pending.kind === "sign_in") throw new Error(handoffSignInComposerText(current.name, pending));
    if (!botHandoffTakesNote(pending)) throw new Error(handoffNoNoteComposerText(current.name));
    if (attachments.length > 0) {
      throw new Error(
        attachments.some((attachment) => attachment.kind === "image")
          ? "Send photos after you answer the card."
          : "Send files after you answer the card.",
      );
    }
    const note = text.trim();
    if ([...note].length > BOT_HANDOFF_NOTE_MAX_CHARS) {
      throw new Error(`Keep the note under ${BOT_HANDOFF_NOTE_MAX_CHARS.toLocaleString()} characters.`);
    }
    const problem = await handoffActions.send(pending, "done", note || undefined);
    if (problem) throw new Error(problem);
  };

  /**
   * Retry: the same message as a NEW submission. Its request id is minted once
   * per failed turn, so clicking Retry again after a failure replays, never doubles.
   */
  const retry = async (failedId: string, text: string) => {
    if (retrying) return;
    let requestId = retryRequestIds.current.get(failedId);
    if (!requestId) {
      requestId = crypto.randomUUID();
      retryRequestIds.current.set(failedId, requestId);
    }
    setRetrying(true);
    setHiddenFailedTurns((hidden) => new Set(hidden).add(failedId));
    echoSend(requestId, text);
    try {
      await botsApi.send({ botId: current.id, text, requestId });
      settleEchoLater(requestId);
    } catch (error) {
      dropEcho(requestId);
      setHiddenFailedTurns((hidden) => {
        const next = new Set(hidden);
        next.delete(failedId);
        return next;
      });
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t send to ${current.name}.`));
    } finally {
      setRetrying(false);
    }
  };

  /** Reply: quote the message at the start of the composer and focus it. */
  const reply = (text: string) => {
    const composer = composerRef.current;
    if (!composer) {
      toast.error("Answer the question first, then reply.");
      return;
    }
    composer.focus();
    composer.setSelectionRange(0, 0);
    insertTextIntoTextarea(composer, botReplyQuote(text));
  };

  const stop = () => {
    void botsApi.stop(current.id).catch((error) => {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t stop ${current.name}.`));
    });
  };

  const removeQueued = async (submissionId: string, button: HTMLButtonElement) => {
    // The row leaves the page, so keyboard focus moves on first: the next Remove, else the composer.
    const removes = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-bot-queued-remove]"));
    const next = removes[removes.indexOf(button) + 1];
    (next ?? composerRef.current)?.focus();
    setRemoving((ids) => new Set(ids).add(submissionId));
    try {
      const result = await botsApi.withdraw(current.id, submissionId);
      if (result === "started") toast.info("That message already started, so it stays.");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t remove that message."));
    } finally {
      setRemoving((ids) => {
        const rest = new Set(ids);
        rest.delete(submissionId);
        return rest;
      });
    }
  };

  const respondToSkill = async (proposalId: string, decision: "add" | "dismiss") => {
    try {
      return (await botsApi.skillProposals.respond({ botId: current.id, proposalId, decision })).status;
    } catch (error) {
      toast.error(userFacingErrorMessage(error, decision === "add" ? "Aiden couldn’t add that skill." : "Aiden couldn’t save that choice."));
      throw error;
    }
  };
  const newRoutineLink = async (routineId: string) => {
    try {
      return (await botsApi.eventRoutines.rotateLink({ botId: current.id, id: routineId })).link;
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t make a new link."));
      throw error;
    }
  };
  const respondToProposal = async (
    proposalId: string,
    decision: BotRoutineProposalDecision,
    reason?: BotRoutineProposalDeclineReason,
  ) => {
    try {
      const result = await botsApi.routineProposals.respond({
        botId: current.id, proposalId, decision, ...(reason ? { reason } : {}),
      });
      if (result.status === "accepted") void qc.invalidateQueries({ queryKey: botRoutinesKey(current.id) });
      return result;
    } catch (error) {
      toast.error(
        userFacingErrorMessage(
          error,
          decision === "accept" ? "Aiden couldn’t add that routine." : "Aiden couldn’t save that choice.",
        ),
      );
      throw error;
    }
  };

  /** Run now: a routine that came due while the Bot was paused runs once, now. */
  const runRoutine = async (routineId: string) => {
    try {
      await botsApi.routines.runNow(current.id, routineId);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t run that routine."));
      throw error;
    }
  };

  /**
   * One action on a "Needs you" issue: the service records the answer, and
   * the live transcript settles the card. Open chat is this surface already.
   */
  const actOnIssue = async (issueId: string, action: BotIssueAction) => {
    if (action.kind === "open_chat") {
      void navigate({ to: "/bots/$botId/chat", params: { botId } });
      return;
    }
    try {
      await botsApi.issues.act({ botId: current.id, issueId, action });
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t do that."));
      throw error;
    }
  };

  const dismissConnection = async (pluginId: string) => {
    try {
      await botsApi.dismissConnection(current.id, pluginId);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save that choice."));
    }
  };

  const footer = (
    <div className="flex flex-col">
      {approvals.prompts.length > 0 || handoff ? (
        <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-2">
          {handoff ? (
            <HandoffCard
              key={handoff.waitId}
              botId={current.id}
              name={current.name}
              avatar={current.avatar}
              handoff={handoff}
              busy={handoffActions.busy}
              onOpen={() => void handoffActions.open(handoff)}
              onAnswer={(outcome) => void handoffActions.answer(handoff, outcome)}
            />
          ) : null}
          {approvals.prompts.map((prompt) => (
            <BotApprovalCard
              key={prompt.waitId}
              name={current.name}
              prompt={prompt}
              onAnswer={(decision) => {
                approvals.remove(prompt.waitId);
                void botsApi.approve(prompt.waitId, decision).catch((error) => {
                  approvals.restore(prompt);
                  toast.error(userFacingErrorMessage(error, "Aiden couldn’t send that answer."));
                });
              }}
            />
          ))}
        </div>
      ) : null}
      {/* A waiting A–E question takes the composer's place, as in workspace chats. */}
      {question ? (
        <>
          <AskUserQuestionComposer
            key={question.waitId}
            prompt={questionPrompt(question)}
            submitting={answering}
            onRespond={(response) => answerQuestion(question, response)}
          />
          {/* The card replaces the composer, so Stop lives here while it waits. */}
          <div className="aiden-dock-inset chat-content-column flex justify-end pb-4 pt-2">
            <Button variant="filled" size="small" onClick={stop}>
              <Square aria-hidden="true" />
              Stop
            </Button>
          </div>
        </>
      ) : (
        <Composer
          key={`bot:${current.id}`}
          // A sign-in or a password-or-code card is answered on the card: a password typed here would reach the Bot.
          ready={!noteRefused && (!state || (state.kind !== "unavailable" && state.kind !== "paused"))}
          readinessMessage={
            state?.kind === "unavailable"
              ? BOT_UNAVAILABLE_LABEL
              : state?.kind === "paused"
                ? botPausedText(current.name)
                : signInWaits
                  ? handoffSignInComposerText(current.name, handoff ?? undefined)
                  : noteRefused
                    ? handoffNoNoteComposerText(current.name)
                    : undefined
          }
          hasMessages={snapshot.entries.length > 0}
          chatId={`bot:${current.id}`}
          placeholder={handoff && !noteRefused ? "Add a note and send to mark it done" : `Ask ${current.name}`}
          onSend={(text, attachments) =>
            handoff ? answerHandoffWithNote(handoff, text, attachments) : send(text, attachments)
          }
          onQueue={(text, attachments) =>
            handoff ? answerHandoffWithNote(handoff, text, attachments) : send(text, attachments, "followUp")
          }
          onSteer={(text, attachments) =>
            handoff ? answerHandoffWithNote(handoff, text, attachments) : send(text, attachments, "steer")
          }
          onStop={stop}
          // While a hand-off waits, sending answers the card: a plain Send, never Queue or Steer.
          isGenerating={running && !handoff}
          canStopGeneration={running}
          inputRef={composerRef}
          surfaces={BOT_CHAT_COMPOSER_SURFACES}
        />
      )}
      {/* The composer's send answers the card, so Stop lives here while it waits. */}
      {handoff && !question && running ? (
        <div className="aiden-dock-inset chat-content-column flex justify-end pb-4 pt-2">
          <Button variant="filled" size="small" onClick={stop}>
            <Square aria-hidden="true" />
            Stop
          </Button>
        </div>
      ) : null}
    </div>
  );

  return shell(
    <div className="aiden-dock-inset chat-content-column flex flex-col gap-3 py-6">
      {live.failed && live.stale ? (
        <Callout color="red" role="alert" className="flex-row items-center justify-between gap-3">
          <Text variant="small" color="red">
            This is the last view of {current.name}’s chat; Aiden couldn’t read the latest.
          </Text>
          <Button size="small" variant="filled" onClick={live.reload}>
            Try again
          </Button>
        </Callout>
      ) : null}
      <MessageAttachmentPreviewProvider>
        <TranscriptEntries
          name={current.name}
          entries={
            hiddenFailedTurns.size || heldArrivals.size
              ? snapshot.entries.filter((entry) => !hiddenFailedTurns.has(entry.id) && !heldArrivals.has(entry.id))
              : snapshot.entries
          }
          partial={snapshot.partial}
          running={running}
          level={chatActivity.level}
          queued={
            heldArrivals.size
              ? (snapshot.queued ?? []).filter((message) => !heldArrivals.has(`queued:${message.submissionId}`))
              : (snapshot.queued ?? [])
          }
          removing={removing}
          onRemoveQueued={(id, button) => void removeQueued(id, button)}
          retrying={retrying}
          onConnect={(pluginId) => void connectionSetup.open(pluginId)}
          onDismissConnection={(pluginId) => void dismissConnection(pluginId)}
          onOpenFile={(path) => panel.show("files", { path, botId })}
          onReply={reply}
          onRetry={(failedId, text) => void retry(failedId, text)}
          onOpenMemory={openMemory}
          onRunRoutine={runRoutine}
          onRespondToProposal={respondToProposal}
          onNewRoutineLink={newRoutineLink}
          onRespondToSkill={respondToSkill}
          onRespondToLesson={async (lessonId, decision) => {
            try {
              return (await botsApi.learning.respondLesson({ botId: current.id, lessonId, decision })).status;
            } catch (error) {
              toast.error(userFacingErrorMessage(error, "Aiden couldn’t save that choice."));
              throw error;
            }
          }}
          onUndoLearning={async (target) => {
            let result: { ok: true } | { ok: false; code: string };
            try {
              result = await botsApi.learning.undoInChat({ botId: current.id, target });
            } catch (error) {
              toast.error(userFacingErrorMessage(error, "Aiden couldn’t undo that."));
              throw error;
            }
            if (!result.ok) {
              toast.error(result.code === "conflict" ? "This changed since. Edit it on the Memory page." : "Aiden couldn’t undo that.");
              throw new Error(result.code);
            }
          }}
          onActOnIssue={actOnIssue}
        />
        {shownSends.map((send) => {
          const morphFrom = sendMorphs.current.get(send.requestId);
          return (
            <BotPendingSendBubble
              key={send.requestId}
              send={send}
              {...(morphFrom ? { morphFrom } : {})}
              onMorphEnd={() => endMorph(send.requestId)}
              onReply={reply}
            />
          );
        })}
      </MessageAttachmentPreviewProvider>
      <BotStatusAnnouncer text={statusActivity ? botStatusSpeech(statusActivity, chatActivity.wording) : ""} />
      {statusActivity ? (
        <BotStatusLine
          activity={statusActivity}
          wording={chatActivity.wording}
          onStop={stop}
          onLayoutChange={setStatusLayout}
        />
      ) : null}
      {state?.kind === "paused" ? <BotPausedCard bot={current} /> : null}
      {/* A new message dismisses the interrupted turn, so the card leaves with the send and comes back if it fails. */}
      {state?.kind === "interrupted" && hiddenInterruptedSubmission !== state.submissionId && !startingTurn ? (
        <BotInterruptedCard
          name={current.name}
          {...(state.blocked ? { blocked: state.blocked } : {})}
          busy={false}
          onResume={() => void resume()}
          onDismiss={() => void dismiss()}
          onReviewAccess={openAdvanced}
        />
      ) : null}
      {state?.kind === "model_error" ? (
        <BotModelErrorCard
          name={current.name}
          message={state.message}
          onChooseModel={openAdvanced}
          onOpenProviders={openProviders}
        />
      ) : null}
    </div>,
    footer,
  );
}
