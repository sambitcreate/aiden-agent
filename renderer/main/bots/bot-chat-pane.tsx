import { BOT_UNKNOWN_COST_CONFIRMATION } from "../../shared/bot-execution-resume";
import { BotPeerExchangeDialog } from "./bot-peers";
import { BOT_RESUME_JOURNAL_EVENT, pendingBotResumes, recordBotResume, settleBotResume, type BotResumeAttempt } from "./bot-resume-journal";
import { AccessRequestCard } from "../../components/bots/access-request-card";
import { useBotAccessRequestActions } from "./use-bot-access-request-actions";
// A Bot's one conversation, rendered from the durable projection (`useBotLive`).
// Sends go through `bots:send` with a fresh request UUID per message, so a retried
// send never doubles. Stop, Resume and Dismiss map to their runtime actions.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleSlash, FileText, Hourglass, LogIn, Pause, RotateCcw, Square } from "lucide-react";
import { AskUserQuestionComposer } from "../../components/ask-user-question-composer";
import { Composer } from "../../components/composer";
import { ConnectCard } from "../../components/bots/connect-card";
import { RoutinesSkippedCard } from "../../components/bots/routines-skipped-card";
import { RoutineProposalCard } from "../../components/bots/routine-proposal-card";
import { SkillProposalCard } from "../../components/bots/skill-proposal-card";
import { LearnedLine, LessonProposalCard } from "../../components/bots/lesson-cards";
import { HeldSettingsCard, SettingsChangeReceipt } from "../../components/bots/settings-change-cards";
import type { BotSettingsChangeStatus } from "../../shared/bot-settings-changes";
import { BotInstructionsDialog } from "./bot-instructions-editor";
import { BotIssueCard } from "../../components/bots/bot-issue-card";
import { HandoffCard, handoffNoNoteComposerText, handoffSignInComposerText } from "../../components/bots/handoff-card";
import { NeedsYouAnnouncer, NeedsYouFocusScope, NeedsYouHeader, needsYouSlotState, type NeedsYouItem } from "../../components/bots/needs-you-slot";
import { PlanCard } from "../../components/bots/plan-card";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import { ApprovalStatusLine, ChatApprovalCard } from "../../components/chat-approval-card";
import { useApprovalStatusLine } from "../../lib/use-approval-status-line";
import { SafeMessageBubble } from "../../components/message-bubble";
import { MessageAttachmentPreviewProvider, MessageAttachments } from "../../components/message-attachments";
import { insertTextIntoTextarea } from "../../lib/composer-type-focus";
import { AlertDialog, Button, Callout, EmptyState, ScrollArea, Text, toast } from "../../components/ui";
import { BotNoticeCard } from "../../components/bots/bot-notice-card";
import { botListLocation } from "../../lib/bot-routes";
import { settingsLocation } from "../../lib/settings-section";
import { botAlwaysAllowLabel } from "../../shared/tool-approval-scope";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { Attachment } from "../../lib/types";
import { botChatActivityOnDevice, showsBotToolActivity, type BotChatActivityLevel } from "../../shared/bots";
import { queryKeys, useBot, useBots } from "../../lib/queries";
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
import { useAppearancePreference } from "../../lib/use-appearance-preference";
import { BotStatusAnnouncer, BotStatusLine, botStatusSpeech } from "./bot-status-line";
import { BotMessageActions, botReplyQuote } from "./bot-message-actions";
import { useBotMenuActions } from "./bot-menu";
import { useBotPanelActions } from "./bot-panel-context";
import { useBotHandoffActions } from "./use-bot-handoff-actions";
import { botSidebarPreferenceActions, useIsBotPinned } from "./use-bot-sidebar-preferences";
import { botTranscriptRows } from "./bot-transcript-rows";
import { BOT_UNAVAILABLE_LABEL, type BotSessionState } from "./bot-session-state";
import { botRoutinesKey } from "./bot-routines";
import { WakeUpChip } from "../../components/bots/wake-up-chip";
import { ReceiptLine } from "../../components/bots/receipt-line";
import { pickBotStatus } from "./bot-status-slot";
import { FoldedSuggestion } from "../../components/bots/suggestion-card";
import { useConnectionSetup } from "./use-connection-setup";
import { useChatFind } from "../../components/chat-find-bar";
import { retryUsageLimitNow, useUsageLimitNow, useUsageLimitWait } from "../../lib/use-usage-limit-wait";
import { formatUsageLimitTime, type UsageLimitWaitView } from "../../shared/usage-limits";
import { useSpendingStatus } from "../../lib/use-spending-status";
import { SpendingLimitNotice } from "../../components/spending/spending-limit-notice";
import { spendingNotice } from "../../shared/spending";
import { switchToAutoSuggestion, useSwitchToAutoOffer } from "../../lib/switch-to-auto";

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
function useBotApprovals(botId: string | undefined, onWithdrawn?: (waitId: string) => void) {
  const [prompts, setPrompts] = React.useState<BotApprovalPrompt[]>([]);
  const withdrawn = React.useRef(onWithdrawn);
  withdrawn.current = onWithdrawn;
  const shown = React.useRef(prompts);
  shown.current = prompts;
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
        // Still shown here, so nobody answered it on this device: it went away (answered elsewhere, expired, the run ended).
        if (shown.current.some((prompt) => prompt.waitId === settled.waitId)) withdrawn.current?.(settled.waitId);
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

/** Which shared card a pending approval belongs to: the same for every identical call, the wait itself otherwise. */
export function botApprovalGroupKey(prompt: BotApprovalPrompt): string {
  return prompt.argumentsHash && prompt.runHash
    ? JSON.stringify([prompt.botId, prompt.runHash, prompt.argumentsHash, prompt.toolName, prompt.summary, prompt.always?.key ?? null])
    : JSON.stringify(["wait", prompt.botId, prompt.waitId]);
}

/**
 * Identical pending approvals in one reply (same tool, card and exact
 * arguments) share one card. A wait without its arguments and run hashes is
 * never grouped: equal text is not the same action.
 */
export function groupBotApprovalPrompts(prompts: readonly BotApprovalPrompt[]): BotApprovalPrompt[][] {
  const groups = new Map<string, BotApprovalPrompt[]>();
  for (const prompt of prompts) {
    const key = botApprovalGroupKey(prompt);
    const group = groups.get(key);
    if (group) group.push(prompt);
    else groups.set(key, [prompt]);
  }
  return [...groups.values()];
}

/** A Bot's tool call that needs the person's yes or no before it runs: the shared approval card. */
export function BotApprovalCard({
  name,
  prompt,
  onAnswer,
  allowElsewhere,
  keyboardShortcuts = false,
  pendingCount = 1,
}: {
  name: string;
  prompt: BotApprovalPrompt;
  onAnswer(decision: "allow" | "deny", scope?: "always"): Promise<void> | void;
  /** Set when this device may only deny: where the person can allow it instead. */
  allowElsewhere?: string;
  /** ⌘↩ allows and ⌘⌫ denies while the message box is empty; only the first card takes them. */
  keyboardShortcuts?: boolean;
  /** Cards waiting in this chat, this one first. */
  pendingCount?: number;
}) {
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);
  const [answerError, setAnswerError] = React.useState<string | null>(null);
  // Allowed again and again in Ask: Auto is offered beside Always, but only
  // where main said Auto would hand this call to the judge instead of a card.
  // Not on a device that may only deny.
  const autoOffer = useSwitchToAutoOffer(prompt.always !== undefined && prompt.autoWouldJudge === true && allowElsewhere === undefined);
  const respond = async (decision: "allow" | "deny", scope?: "always") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setAnswerError(null);
    try {
      await onAnswer(decision, scope);
    } catch (error) {
      setAnswerError(userFacingErrorMessage(error, "Aiden couldn’t send that answer."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <ChatApprovalCard
      pending={{
        approvalId: prompt.waitId,
        toolCallId: prompt.toolCallId,
        toolName: prompt.toolName,
        summary: prompt.summary,
        ...(prompt.always ? { scopes: ["once", "always"] } : {}),
      }}
      deciding={busy}
      onDecide={(decision, options) => void respond(decision, options?.scope === "always" ? "always" : undefined)}
      requester={name}
      alwaysOption={{ label: botAlwaysAllowLabel(name), hint: `${name} won’t ask again for this. Undo in Settings → Approvals.` }}
      notes={prompt.always ? [`You’ve allowed this ${prompt.always.count} times in the last 2 weeks.`] : []}
      {...(autoOffer ? { suggestion: switchToAutoSuggestion(autoOffer) } : {})}
      {...(allowElsewhere ? { allowElsewhere } : {})}
      error={answerError}
      keyboardShortcuts={keyboardShortcuts}
      pendingCount={pendingCount}
    />
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

/** A reply waiting for a provider usage limit: when it tries again, and Retry now. */
export function BotUsageLimitCard({
  name,
  wait,
  now,
  onRetryNow,
}: {
  name: string;
  wait: UsageLimitWaitView;
  now: number;
  onRetryNow(): void;
}) {
  const provider = wait.providerLabel.trim() || "the provider";
  const trying = wait.trying || wait.nextTryAt <= now;
  return (
    <BotNoticeCard
      label={`${name} is waiting for a usage limit`}
      icon={<Hourglass />}
      title={trying ? `Trying ${provider} again…` : `Waiting for ${provider}’s usage limit`}
      actions={
        trying ? undefined : (
          <Button variant="transparent" size="small" onClick={onRetryNow}>
            Retry now
          </Button>
        )
      }
    >
      {trying ? null : (
        <p>{`Next try ${formatUsageLimitTime(wait.nextTryAt, now)}. ${name} keeps the same model and carries on when the limit clears.`}</p>
      )}
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
  onAddConnection,
  onOpenFile,
  onReply,
  onRetry,
  onOpenMemory,
  onViewExchange,
  onRunRoutine,
  onRespondToProposal,
  onNewRoutineLink,
  onRespondToSkill,
  onRespondToLesson,
  onUndoLearning,
  onActOnIssue,
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
  /** One action on a "Needs you" issue card. */
  onActOnIssue?(issueId: string, action: BotIssueAction): Promise<void>;
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
                onUndo={onUndoSettings ? () => onUndoSettings(row.change.changeId) : () => Promise.reject(new Error("Undo isn’t available here."))}
              />
            );
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
  // Show tool activity is per device (§4.5); until it is set, the Bots' old levels decide.
  const toolActivitySetting = useAppearancePreference("showToolActivity");
  const otherBots = useBots(false, toolActivitySetting === undefined);
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
  const [resumeSending, setResumeSending] = React.useState(false);
  const [resumeJournalVersion, refreshResumeJournal] = React.useReducer((value: number) => value + 1, 0);
  const savedResumes = React.useMemo(() => {
    try { return { rows: pendingBotResumes(botId), error: null as string | null }; }
    catch (error) { return { rows: [] as BotResumeAttempt[], error: userFacingErrorMessage(error, "Saved Resume requests need review.") }; }
  }, [botId, resumeJournalVersion]);
  React.useEffect(() => {
    window.addEventListener("storage", refreshResumeJournal);
    window.addEventListener(BOT_RESUME_JOURNAL_EVENT, refreshResumeJournal);
    return () => { window.removeEventListener("storage", refreshResumeJournal); window.removeEventListener(BOT_RESUME_JOURNAL_EVENT, refreshResumeJournal); };
  }, []);
  const [costConsent, setCostConsent] = React.useState<{ botId: string; submissionId: string; expectedSubmissionId: string; expectedCostReceiptId: string } | null>(null);
  // Sends show at once as pending echoes, each under one request id. A send
  // that failed keeps its id, so the same words sent again are deduplicated by
  // main instead of delivered twice; Retry reuses one id per failed turn.
  const [pendingSends, setPendingSends] = React.useState<readonly BotPendingSend[]>([]);
  const [peerExchange, setPeerExchange] = React.useState<{ botId: string; exchangeId: string } | null>(null);
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
  const latestSnapshot = React.useRef(snapshot);
  React.useLayoutEffect(() => { latestSnapshot.current = snapshot; }, [snapshot]);
  const interruptedControlLifetime = React.useRef<{ botId: string; active: boolean } | null>(null);
  React.useLayoutEffect(() => {
    let focused = true;
    const visit = () => {
      if (interruptedControlLifetime.current) interruptedControlLifetime.current.active = false;
      interruptedControlLifetime.current = { botId, active: focused && !document.hidden };
      setCostConsent(null); setHiddenInterruptedSubmission(null); setResumeSending(false);
    };
    const blur = () => { focused = false; visit(); }, focus = () => { focused = true; visit(); };
    visit();
    window.addEventListener("blur", blur); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visit);
    return () => {
      if (interruptedControlLifetime.current) interruptedControlLifetime.current.active = false;
      window.removeEventListener("blur", blur); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visit);
    };
  }, [botId]);
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
  const usageLimitWait = useUsageLimitWait("bot", botId);
  const spending = useSpendingStatus("bot", botId);
  const usageLimitNow = useUsageLimitNow(usageLimitWait);
  React.useEffect(() => {
    // The card hides for one interrupted turn; any other state (running, idle,
    // paused by the person, or a later interruption) clears that.
    if (hiddenInterruptedSubmission && (state?.kind !== "interrupted" || state.submissionId !== hiddenInterruptedSubmission)) {
      setHiddenInterruptedSubmission(null);
    }
  }, [hiddenInterruptedSubmission, state]);

  const connectionSetup = useConnectionSetup(() => live.reload());
  const [addingConnection, setAddingConnection] = React.useState(false);
  const approvalStatus = useApprovalStatusLine(botId);
  const showApprovalStatus = approvalStatus.show;
  // Cards this device is answering: their settlement is this answer, not a stale card.
  const answeringApprovals = React.useRef(new Set<string>());
  const approvals = useBotApprovals(botId, (waitId) => {
    if (!answeringApprovals.current.has(waitId)) showApprovalStatus({ decision: "stale" });
  });
  const approvalGroups = groupBotApprovalPrompts(approvals.prompts);
  const [answering, setAnswering] = React.useState(false);
  const findBar = useChatFind(botId);
  // The Needs-you item the person moved to with Previous or Next, by key.
  const [needsYouChoice, setNeedsYouChoice] = React.useState<string | null>(null);
  // Edit on a held "Update instructions?" card: the editor, seeded with the proposed text.
  const [instructionsEdit, setInstructionsEdit] = React.useState<{ changeId: string; seed: string } | null>(null);
  const accessRequestActions = useBotAccessRequestActions(botId, live.snapshot?.accessRequest?.waitId);
  const handoffActions = useBotHandoffActions(botId, live.snapshot?.handoff?.waitId);

  // The Bot's routines, read only when its chat shows a wake-up chip.
  const hasWakeUps = snapshot?.entries.some((entry) => entry.type === "wake_up") ?? false;
  const routines = useQuery({
    queryKey: botRoutinesKey(botId),
    queryFn: () => botsApi.routines.list(botId),
    enabled: hasWakeUps,
  });
  const wakeUpPending = (wakeUpId: string): boolean | undefined => {
    if (!routines.data) return undefined;
    return routines.data.some((routine) => routine.id === wakeUpId && routine.wakeUp !== undefined && routine.enabled);
  };
  /** Cancel on a wake-up chip: gone from the routines at once, back if main refuses. */
  const cancelWakeUp = async (wakeUpId: string) => {
    const key = botRoutinesKey(botId);
    const before = qc.getQueryData<typeof routines.data>(key);
    qc.setQueryData<typeof routines.data>(key, (rows) => rows?.filter((routine) => routine.id !== wakeUpId));
    try {
      await botsApi.routines.delete({ botId, id: wakeUpId });
    } catch (error) {
      qc.setQueryData(key, before);
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t cancel that wake-up."));
      throw error;
    } finally {
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const back = () => void navigate(botListLocation());
  const current = bot.data ?? null;
  // A Bot over its spending limit sends nothing until the person allows more.
  const spendingReached = spending.status?.state === "reached" ? spendingNotice(spending.status, current?.name)?.title : undefined;
  // A Bot's settings live in the side panel's Advanced tab (plan §4.4).
  const openAdvanced = () => panel.show("advanced", { botId, section: "model" });
  // Memory, Files and Routines live in the side panel beside the chat (spec §8).
  const openMemory = () => panel.show("memory");

  const shell = (body: React.ReactNode, footer?: React.ReactNode) => (
    <ScrollArea
      focusRegion="chat"
      overlay={findBar}
      scrollRestorationId={`bot-chat:${botId}`}
      className="h-full min-h-0"
      alignFooterToScrollContent
      title={
        current ? (
          <BotChatNamePill
            bot={current}
            working={running}
            onOpenProfile={() => panel.show("advanced", { botId: current.id })}
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
              onAction={(action) => menuAction(current, action)}
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
        needsYouChoice,
        snapshot?.question?.waitId,
        snapshot?.handoff?.waitId,
        snapshot?.accessRequest?.waitId,
        snapshot?.plan?.planId,
        snapshot?.plan?.revision,
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
  const plan = snapshot.plan ?? null;
  const pendingPlan = plan?.status === "pending";
  const accessRequest = snapshot.accessRequest ?? null;
  const handoff = snapshot.handoff ?? null;
  const signInWaits = handoff?.kind === "sign_in";
  // A sign-in or a password-or-code card is answered on the card alone: whatever is typed here would reach the Bot.
  const noteRefused = signInWaits || (handoff !== null && !botHandoffTakesNote(handoff));
  // Tool activity follows this device's Show tool activity switch, not the Bot (§4.5).
  const chatActivity = botChatActivityOnDevice(
    showsBotToolActivity(toolActivitySetting, [current, ...(otherBots.data ?? [])]),
    current.chatActivity,
  );
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
  const startingTurn = !running && !question && !handoff && !pendingPlan ? shownSends.find((send) => !send.queued) : undefined;
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

  const performResume = async (input: Omit<BotResumeAttempt, "version" | "createdAt" | "attempts">, retry: boolean) => {
    const lifetime = interruptedControlLifetime.current;
    if (!lifetime?.active || lifetime.botId !== current.id || resumeSending) return;
    const before = latestSnapshot.current;
    setResumeSending(true);
    try {
      const attempt = recordBotResume(input, retry);
      setHiddenInterruptedSubmission(attempt.submissionId);
      const after = await botsApi.resume(attempt.botId, attempt.requestId, attempt.acknowledgement);
      if (!after || !["idle", "running", "interrupted", "needs_model", "model_error", "unavailable", "paused"].includes(after.kind) || (after.kind === "running" || after.kind === "interrupted") && !after.submissionId) throw new Error("The host did not confirm the Resume request.");
      settleBotResume(attempt);
      if (lifetime.active && (after.kind === "interrupted" || latestSnapshot.current !== before && latestSnapshot.current?.state.kind === "interrupted")) setHiddenInterruptedSubmission(null);
    } catch (error) {
      if (lifetime.active) {
        setHiddenInterruptedSubmission(null);
        toast.error(userFacingErrorMessage(error, "The Resume outcome is unconfirmed. Retry the saved request."));
      }
    } finally {
      if (lifetime.active) setResumeSending(false);
      refreshResumeJournal();
    }
  };

  const answerInterrupted = async (action: "resume" | "dismiss", acknowledgeUnknownCost = false, expectedSubmissionId?: string, expectedCostReceiptId?: string) => {
    if (state?.kind !== "interrupted" || hiddenInterruptedSubmission || resumeSending) return;
    const lifetime = interruptedControlLifetime.current;
    if (!lifetime?.active || lifetime.botId !== current.id) return;
    const { submissionId } = state;
    const before = snapshot;
    try {
      if (action === "resume") {
        const pending = pendingBotResumes(current.id);
        if (pending.length) { await performResume(pending[0]!, true); return; }
        if (!acknowledgeUnknownCost) {
          setHiddenInterruptedSubmission(submissionId);
          const status = await botsApi.routineModels.resumeStatus(current.id);
          if (!lifetime.active) return;
          const latest = latestSnapshot.current;
          if (latest?.botId !== current.id || latest.state.kind !== "interrupted" || latest.state.submissionId !== submissionId || status.interruptedSubmissionId !== undefined && status.interruptedSubmissionId !== submissionId) throw new Error("This Bot’s interrupted work changed. Review its current state before resuming.");
          if (status.requiresUnknownCostAcknowledgement) {
            if (!status.interruptedSubmissionId || !status.costReceiptId) throw new Error("The interrupted work needs a fresh confirmation.");
            setHiddenInterruptedSubmission(null); setCostConsent({ botId: current.id, submissionId, expectedSubmissionId: status.interruptedSubmissionId, expectedCostReceiptId: status.costReceiptId }); return;
          }
        }
        if (acknowledgeUnknownCost && (!expectedSubmissionId || !expectedCostReceiptId)) throw new Error("The interrupted work needs a fresh confirmation.");
        await performResume({ botId: current.id, submissionId, requestId: crypto.randomUUID(), acknowledgement: acknowledgeUnknownCost ? { acknowledgeUnknownCost: true, expectedSubmissionId, expectedCostReceiptId } : {} }, false);
        return;
      }
      setHiddenInterruptedSubmission(submissionId);
      const after = await botsApi.dismiss(current.id, interruptedRequestId(action, submissionId));
      interruptedRequestIds.current.delete(`${action}:${submissionId}`);
      if (after.kind === "interrupted" || latestSnapshot.current !== before && latestSnapshot.current?.state.kind === "interrupted") setHiddenInterruptedSubmission(null);
    } catch (error) {
      if (lifetime.active) {
        setHiddenInterruptedSubmission((hidden) => hidden === submissionId ? null : hidden);
        toast.error(userFacingErrorMessage(error, action === "resume" ? `Aiden couldn’t resume ${current.name}.` : `Aiden couldn’t dismiss that for ${current.name}.`));
      }
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
    if (pending.kind === "sign_in") throw new Error(handoffSignInComposerText(current.name));
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
  const respondToSettings = async (changeId: string, decision: "undo" | "apply" | "edited" | "dismiss"): Promise<BotSettingsChangeStatus> => {
    let result: Awaited<ReturnType<typeof botsApi.settingsChanges.respond>>;
    try {
      result = await botsApi.settingsChanges.respond({ botId: current.id, changeId, decision });
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save that choice."));
      throw error;
    }
    if (!result.ok) {
      toast.error(result.message);
      throw new Error(result.message);
    }
    if (result.message) toast(result.message);
    void qc.invalidateQueries({ queryKey: queryKeys.bots });
    return result.status;
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

  /** Connect on an app connected in Aiden that this Bot leaves out: only this tap adds the app to the Bot's access. */
  const addConnection = async (pluginId: string) => {
    setAddingConnection(true);
    try {
      await botsApi.grantConnection(current.id, pluginId);
      void qc.invalidateQueries({ queryKey: queryKeys.botAccess(current.id) });
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t add that app to this Bot."));
    } finally {
      setAddingConnection(false);
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

  /** One answer for a group of identical waiting calls; only the waits it decided leave. */
  const answerApprovalGroup = async (group: readonly BotApprovalPrompt[], decision: "allow" | "deny", scope?: "always") => {
    for (const prompt of group) answeringApprovals.current.add(prompt.waitId);
    const results = await Promise.allSettled(
      group.map((prompt, index) => botsApi.approve(prompt.waitId, decision, index === 0 ? scope : undefined)),
    ).finally(() => {
      for (const prompt of group) answeringApprovals.current.delete(prompt.waitId);
    });
    const decided = (index: number) => {
      const result = results[index];
      return result?.status === "fulfilled" && result.value.decided;
    };
    if (!group.some((_prompt, index) => decided(index))) {
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      throw new Error("That approval was already answered or closed.");
    }
    // Only the waits this answer reached leave; any other stays to be answered.
    group.forEach((prompt, index) => {
      if (decided(index)) approvals.remove(prompt.waitId);
    });
    // Always rides on the first wait only, so it counts only when that one was decided.
    const always = scope === "always" && decided(0) ? scope : undefined;
    approvalStatus.show(decision === "deny" ? { decision: "deny" } : { decision: "allow", ...(always ? { scope: always } : {}) });
    if (always) {
      toast.success("Always allow requested.", {
        action: { label: "Manage", onClick: () => void navigate(settingsLocation("approvals")) },
      });
    }
  };

  // Everything waiting on the person, one at a time in the Needs-you slot:
  // take control, then the ask cards, then the question (§4.7).
  type SlotItem = NeedsYouItem & { render?(): React.ReactNode };
  const slotItems: SlotItem[] = [];
  if (handoff) {
    slotItems.push({
      key: `handoff:${handoff.waitId}`,
      kind: "take_control",
      render: () => (
        <HandoffCard
          key={handoff.waitId}
          botId={current.id}
          name={current.name}
          avatar={current.avatar}
          handoff={handoff}
          busy={handoffActions.busy}
          taken={handoffActions.taken}
          onTake={handoffActions.take}
          onOpen={() => void handoffActions.open(handoff)}
          onAnswer={(outcome) => void handoffActions.answer(handoff, outcome)}
        />
      ),
    });
  }
  // Identical waiting calls share one card, and it answers all of them.
  for (const group of approvalGroups) {
    const first = group[0]!;
    slotItems.push({
      // The group's own identity, so answering one of its waits elsewhere keeps the card on show.
      key: `approval:${botApprovalGroupKey(first)}`,
      kind: "approval",
      render: () => (
        <BotApprovalCard
          key={`${first.botId}:${first.waitId}`}
          name={current.name}
          prompt={first}
          keyboardShortcuts
          onAnswer={(decision, scope) => answerApprovalGroup(group, decision, scope)}
        />
      ),
    });
  }
  if (accessRequest) {
    slotItems.push({
      key: `access:${accessRequest.waitId}`,
      kind: "access",
      render: () => (
        <AccessRequestCard key={accessRequest.waitId} request={accessRequest} botName={current.name} avatar={current.avatar}
          busy={accessRequestActions.busy} onAnswer={(choice) => void accessRequestActions.answer(accessRequest, choice)} />
      ),
    });
  }
  if (plan && pendingPlan) {
    slotItems.push({
      key: `plan:${plan.planId}:${plan.revision}`,
      kind: "plan",
      render: () => (
        <PlanCard
          plan={plan}
          botName={current.name}
          avatar={current.avatar}
          onRespond={async (decision) => {
            const { result } = await botsApi.respondPlan({ botId: current.id, planId: plan.planId, decision });
            if (result === "not_waiting") throw new Error("That plan was already answered or closed.");
          }}
        />
      ),
    });
  }
  // A change the Bot asked for in a run the person didn't start (§4.6).
  for (const entry of snapshot.entries) {
    if (entry.type !== "settings_change" || entry.change.mode !== "held" || entry.status !== "pending") continue;
    const change = entry.change;
    slotItems.push({
      key: `change:${change.changeId}`,
      kind: "change",
      render: () => (
        <HeldSettingsCard
          change={change}
          botName={current.name}
          onRespond={async (decision) => {
            await respondToSettings(change.changeId, decision);
          }}
          onEdit={(instructions) => setInstructionsEdit({ changeId: change.changeId, seed: instructions })}
        />
      ),
    });
  }
  if (question) {
    slotItems.push({ key: `question:${question.waitId}`, kind: "question" });
  }
  const slot = needsYouSlotState(slotItems, needsYouChoice, setNeedsYouChoice);
  const askingQuestion = question !== null && slot.current?.kind === "question";
  // A question waits, but another item is on show: the composer points at it.
  const questionElsewhere = question !== null && !askingQuestion;

  const status = pickBotStatus({
    model_error: state?.kind === "model_error",
    spending_reached: spending.status?.state === "reached",
    paused: state?.kind === "paused",
    saved_resume: savedResumes.rows.length > 0,
    interrupted: state?.kind === "interrupted" && hiddenInterruptedSubmission !== state.submissionId && !startingTurn,
    usage_limit: running && usageLimitWait !== null && usageLimitWait !== undefined,
    spending_nearing: spending.status?.state === "nearing",
    plan: plan !== null && plan !== undefined && !pendingPlan,
  });

  const footer = (
    <NeedsYouFocusScope currentKey={slot.current?.key} className="flex flex-col">
      <NeedsYouAnnouncer slot={slot} />
      {slot.count > 0 || approvalStatus.status ? (
        <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-2" data-needs-you-slot>
          <NeedsYouHeader slot={slot} />
          {slot.current?.render ? (
            <div key={slot.current.key} className="contents" data-needs-you-card>
              {slot.current.render()}
            </div>
          ) : !slot.current && approvalStatus.status ? (
            <ApprovalStatusLine status={approvalStatus.status} />
          ) : null}
        </div>
      ) : null}
      {/* The question takes the composer's place, as in workspace chats, while the slot shows it. */}
      {question && askingQuestion ? (
        <>
          <div className="contents" data-needs-you-card>
            <AskUserQuestionComposer
              key={question.waitId}
              prompt={questionPrompt(question)}
              submitting={answering}
              onRespond={(response) => answerQuestion(question, response)}
            />
          </div>
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
          ready={!pendingPlan && !noteRefused && !questionElsewhere && !spendingReached && (!state || (state.kind !== "unavailable" && state.kind !== "paused"))}
          readinessMessage={
            pendingPlan
              ? slot.current?.kind === "plan"
                ? "Answer the plan above, then send a message."
                : "Answer the plan under Needs you, then send a message."
              : questionElsewhere
                ? `Answer ${current.name}’s question first. It’s ${slot.count} of ${slot.count} above.`
              : state?.kind === "unavailable"
              ? BOT_UNAVAILABLE_LABEL
              : state?.kind === "paused"
                ? botPausedText(current.name)
                : signInWaits
                  ? handoffSignInComposerText(current.name)
                  : noteRefused
                    ? handoffNoNoteComposerText(current.name)
                    : spendingReached
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
      {handoff && !askingQuestion && running ? (
        <div className="aiden-dock-inset chat-content-column flex justify-end pb-4 pt-2">
          <Button variant="filled" size="small" onClick={stop}>
            <Square aria-hidden="true" />
            Stop
          </Button>
        </div>
      ) : null}
    </NeedsYouFocusScope>
  );

  // A Bot's transcript is data, never instructions: Aiden Live sees only how many rows it has.
  return shell(
    <div className="aiden-dock-inset chat-content-column flex flex-col gap-3 py-6" data-live-content="chat">
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
          onAddConnection={(pluginId) => void addConnection(pluginId)}
          connecting={addingConnection}
          onOpenFile={(path) => panel.show("files", { path, botId })}
          onReply={reply}
          onRetry={(failedId, text) => void retry(failedId, text)}
          onOpenMemory={openMemory}
          onViewExchange={(exchangeId) => setPeerExchange({ botId: current.id, exchangeId })}
          onRunRoutine={runRoutine}
          wakeUpPending={wakeUpPending}
          onCancelWakeUp={cancelWakeUp}
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
          onUndoSettings={(changeId) => respondToSettings(changeId, "undo")}
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
        <BotStatusLine activity={statusActivity} wording={chatActivity.wording} onLayoutChange={setStatusLayout} />
      ) : null}
      {/* The one status slot (§4.7): only the most important status card shows. */}
      {status === "usage_limit" && usageLimitWait ? (
        <BotUsageLimitCard
          name={current.name}
          wait={usageLimitWait}
          now={usageLimitNow}
          onRetryNow={() => void retryUsageLimitNow("bot", botId)}
        />
      ) : null}
      {(status === "spending_reached" || status === "spending_nearing") && spending.status ? (
        <SpendingLimitNotice
          status={spending.status}
          name={current.name}
          allowing={spending.allowing}
          onAllowMore={() => void spending.allowMore()}
        />
      ) : null}
      {status === "paused" ? <BotPausedCard bot={current} /> : null}
      {savedResumes.error && <Text as="p" variant="small" role="alert" className="px-4 py-3">{savedResumes.error}</Text>}
      {/* A saved Resume belongs to the interrupted turn, so it shows with that card too. */}
      {(status === "saved_resume" || (status === "interrupted" && savedResumes.rows.length > 0)) && <div className="space-y-2 px-4 py-3">
        <Text as="p" variant="small" color="secondary" role="status">A saved Resume request is awaiting confirmation. Retry keeps its original request and cost acknowledgement.</Text>
        {savedResumes.rows.map((attempt) => <Button key={attempt.requestId} size="small" disabled={resumeSending} onClick={() => void performResume(attempt, true)}>Retry saved Resume</Button>)}
      </div>}
      {status === "plan" && plan ? (
        <PlanCard
          plan={plan}
          botName={current.name}
          avatar={current.avatar}
          onRespond={async (decision) => {
            const { result } = await botsApi.respondPlan({ botId: current.id, planId: plan.planId, decision });
            if (result === "not_waiting") throw new Error("That plan was already answered or closed.");
          }}
        />
      ) : null}
      <AlertDialog open={costConsent !== null} onOpenChange={(open) => { if (!open) setCostConsent(null); }} title={`Resume ${current.name} with an unconfirmed charge?`} description={BOT_UNKNOWN_COST_CONFIRMATION} confirmLabel="Resume" onConfirm={() => {
        const consent = costConsent; setCostConsent(null);
        if (consent?.botId === current.id && state?.kind === "interrupted" && consent.submissionId === state.submissionId) void answerInterrupted("resume", true, consent.expectedSubmissionId, consent.expectedCostReceiptId);
      }} />
      {instructionsEdit ? (
        <BotInstructionsDialog
          key={instructionsEdit.changeId}
          bot={current}
          open
          seed={instructionsEdit.seed}
          onOpenChange={(open) => {
            if (!open) setInstructionsEdit(null);
          }}
          onSaved={async () => {
            await respondToSettings(instructionsEdit.changeId, "edited").catch(() => undefined);
          }}
        />
      ) : null}
      {peerExchange?.botId === current.id && <BotPeerExchangeDialog key={`${peerExchange.botId}:${peerExchange.exchangeId}`} botId={current.id} exchangeId={peerExchange.exchangeId} onClose={() => setPeerExchange(null)} />}
      {/* A new message dismisses the interrupted turn, so the card leaves with the send and comes back if it fails. */}
      {status === "interrupted" && state?.kind === "interrupted" ? (
        <BotInterruptedCard
          name={current.name}
          {...(state.blocked ? { blocked: state.blocked } : {})}
          busy={false}
          onResume={() => void resume()}
          onDismiss={() => void dismiss()}
          onReviewAccess={openAdvanced}
        />
      ) : null}
      {status === "model_error" && state?.kind === "model_error" ? (
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
