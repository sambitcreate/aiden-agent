// A bubbled Bot's mini chat: opens beside its head with the transcript, the
// status line, approval and question cards and a compact composer. Anything
// that needs the full app (connecting an app, a hand-off, a plan, settings)
// hands over with Open in Aiden. Opening it marks the Bot's replies seen, the
// same way the Bot chat does, so the head's count and the sidebar dot clear.

import * as React from "react";
import { ArrowUp, Maximize2, Minus, Square, X } from "lucide-react";
import { AskUserQuestionComposer } from "../components/ask-user-question-composer";
import { BotAvatar } from "../components/bot-avatar";
import { MessageAttachmentPreviewProvider } from "../components/message-attachments";
import { Button, Callout, Text, toast } from "../components/ui";
import { applyBotBubbleChange, botBubblesApi } from "../lib/bot-bubbles-api";
import { botsApi } from "../lib/ipc";
import { userFacingErrorMessage } from "../lib/ipc-error";
import { useLayer } from "../lib/layer-stack";
import { useBot } from "../lib/queries";
import { useAppearancePreference } from "../lib/use-appearance-preference";
import { useBotLive } from "../lib/use-bot-live";
import { botLastReplyAt, type BotPendingQuestion } from "../shared/bot-live";
import type { AskUserQuestionResponseV1 } from "../shared/ask-user-question";
import { botChatActivityOnDevice, showsBotToolActivity } from "../shared/bots";
import type { BotApprovalPrompt } from "../../main/services/bot-runtime/bot-approvals";
import { BotApprovalCard, groupBotApprovalPrompts, questionPrompt, useBotApprovals } from "../main/bots/bot-approvals";
import { botReplyQuote } from "../main/bots/bot-message-actions";
import { botPausedText } from "../main/bots/bot-paused-card";
import { BOT_UNAVAILABLE_LABEL } from "../main/bots/bot-session-state";
import { BOT_WAITING_LINE, BOT_WORKING_LINE, useBotLiveSummary } from "../main/bots/bot-sidebar-rows";
import { BotStatusLine } from "../main/bots/bot-status-line";
import { BOT_INTERRUPTED_TEXT, TranscriptEntries } from "../main/bots/bot-transcript-entries";
import { botSidebarPreferenceActions } from "../main/bots/use-bot-sidebar-preferences";
import type { MiniChatPlacement } from "./head-layout";

/** Selector for everything the bubble layer treats as its own (not click-through, not "outside"). */
export const BOT_BUBBLE_HIT_SELECTOR = [
  "[data-bubble-hit]",
  '[data-slot="popover-content"]',
  '[role="menu"]',
  "[data-sonner-toaster]",
  // An image's full view (and any other dialog) opened from the chat.
  // check-aiden-rules: allow no-dialog-dom-sniff hit-testing what is under the pointer (closest()), not asking whether a dialog is open
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-overlay"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(", ");

/** The mini chat's exit is over by now even if no animation end was heard. */
export const MINI_CHAT_EXIT_FALLBACK_MS = 400;

function rectOf(element: HTMLElement | null) {
  const rect = element?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0
    ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    : undefined;
}

function report(change: Promise<unknown>, fallback: string) {
  void change.catch((error: unknown) => toast.error(userFacingErrorMessage(error, fallback)));
}

export function BotBubbleMiniChat({
  botId,
  placement,
  hidden = false,
  closing = false,
  onClosed,
  offerAuto = false,
}: {
  botId: string;
  placement: MiniChatPlacement;
  /** Kept mounted but out of sight (its head is being dragged), so the draft survives. */
  hidden?: boolean;
  /**
   * Tucked away and on its way out: still drawn while its exit plays, but it
   * takes no clicks, keys or focus and marks nothing seen. `onClosed` says the
   * exit is over and the chat can go.
   */
  closing?: boolean;
  onClosed?(): void;
  /** Whether repeated approvals may offer switching to Auto (only where settings can change). */
  offerAuto?: boolean;
}) {
  const bot = useBot(botId);
  const live = useBotLive(botId);
  const summary = useBotLiveSummary(botId);
  const toolActivitySetting = useAppearancePreference("showToolActivity");
  const chatRef = React.useRef<HTMLElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const pinnedToEnd = React.useRef(true);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [answering, setAnswering] = React.useState(false);
  const [removing, setRemoving] = React.useState<ReadonlySet<string>>(() => new Set());
  const [retrying, setRetrying] = React.useState(false);
  const unsettledSend = React.useRef<{ text: string; requestId: string } | null>(null);
  const retryRequestIds = React.useRef(new Map<string, string>());
  const approvals = useBotApprovals(botId);
  const approvalGroups = groupBotApprovalPrompts(approvals.prompts);

  const current = bot.data ?? null;
  const name = current?.name ?? "Bot";
  const snapshot = live.snapshot;
  const state = snapshot?.state;
  const running = state?.kind === "running";
  const question = snapshot?.question ?? null;

  // Seen while open, like the Bot chat: each finished reply moves the watermark.
  const replyAt = snapshot ? botLastReplyAt(snapshot.entries) : null;
  const botFound = Boolean(current);
  const { markViewed } = botSidebarPreferenceActions;
  React.useEffect(() => {
    if (botFound && !closing) markViewed(botId, replyAt);
  }, [botFound, closing, botId, replyAt, markViewed]);

  const tuck = React.useCallback(() => report(applyBotBubbleChange(botBubblesApi.open(null)), "Aiden couldn’t tuck that chat away."), []);
  const openInAiden = React.useCallback(
    () => report(applyBotBubbleChange(botBubblesApi.bringBack(botId, rectOf(chatRef.current))), `Aiden couldn’t open ${name}.`),
    [botId, name],
  );
  const closeBubble = () => report(applyBotBubbleChange(botBubblesApi.close(botId)), "Aiden couldn’t close that bubble.");
  // Opening puts the cursor in the message box; closing while the chat held focus gives it back to the head.
  React.useEffect(() => {
    if (botFound && !closing) composerRef.current?.focus({ preventScroll: true });
  }, [botFound, closing]);
  // The head takes focus the moment the chat starts to leave (or goes at once), not when its exit ends.
  React.useLayoutEffect(() => {
    const chat = chatRef.current;
    const giveFocusToHead = () => {
      if (!chat?.contains(document.activeElement)) return;
      document.querySelector<HTMLElement>(`[data-bubble-head="${botId}"]`)?.focus({ preventScroll: true });
    };
    if (closing) giveFocusToHead();
    return closing ? undefined : giveFocusToHead;
  }, [botId, closing]);
  // The exit is a CSS animation; a timer ends it where none runs (the chat is not displayed, or a test DOM).
  const closed = React.useRef(onClosed);
  closed.current = onClosed;
  React.useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => closed.current?.(), MINI_CHAT_EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  useLayer(!closing, "sheet", {
    name: "bot-bubble-chat",
    onEscape: (event) => {
      event.preventDefault();
      tuck();
    },
  });

  // Keep the newest message in view unless the person scrolled up to read.
  const entryCount = snapshot?.entries.length ?? 0;
  React.useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && pinnedToEnd.current) scroller.scrollTop = scroller.scrollHeight;
  }, [entryCount, snapshot?.partial, approvals.prompts.length, question?.waitId, snapshot?.activity?.phase]);

  const sendText = async (text: string, requestId: string) => {
    await botsApi.send({ botId, text, requestId, ...(running ? { whenBusy: "followUp" as const } : {}) });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !current) return;
    // The same words sent again after a failure replay under the first request id.
    const unsettled = unsettledSend.current;
    const requestId = unsettled && unsettled.text === text ? unsettled.requestId : crypto.randomUUID();
    unsettledSend.current = null;
    setSending(true);
    setSendError(null);
    setDraft("");
    pinnedToEnd.current = true;
    try {
      await sendText(text, requestId);
    } catch (error) {
      unsettledSend.current = { text, requestId };
      setDraft((now) => (now === "" ? text : now));
      setSendError(userFacingErrorMessage(error, `Aiden couldn’t send to ${name}.`));
    } finally {
      setSending(false);
    }
  };

  const retry = async (failedId: string, text: string) => {
    if (retrying) return;
    let requestId = retryRequestIds.current.get(failedId);
    if (!requestId) {
      requestId = crypto.randomUUID();
      retryRequestIds.current.set(failedId, requestId);
    }
    setRetrying(true);
    try {
      await sendText(text, requestId);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t send to ${name}.`));
    } finally {
      setRetrying(false);
    }
  };

  const removeQueued = async (submissionId: string) => {
    setRemoving((ids) => new Set(ids).add(submissionId));
    try {
      const result = await botsApi.withdraw(botId, submissionId);
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

  const reply = (text: string) => {
    const box = composerRef.current;
    setDraft((now) => `${botReplyQuote(text)}${now}`);
    box?.focus();
  };

  const stop = () => report(botsApi.stop(botId), `Aiden couldn’t stop ${name}.`);

  /** One answer for a group of identical waiting calls; only the waits it decided leave. */
  const answerApprovalGroup = async (group: readonly BotApprovalPrompt[], decision: "allow" | "deny", scope?: "always") => {
    const results = await Promise.allSettled(
      group.map((prompt, index) => botsApi.approve(prompt.waitId, decision, index === 0 ? scope : undefined)),
    );
    const decided = (index: number) => {
      const result = results[index];
      return result?.status === "fulfilled" && result.value.decided;
    };
    if (!group.some((_prompt, index) => decided(index))) {
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      throw new Error("That approval was already answered or closed.");
    }
    group.forEach((prompt, index) => {
      if (decided(index)) approvals.remove(prompt.waitId);
    });
  };

  const answerQuestion = async (pending: BotPendingQuestion, response: AskUserQuestionResponseV1) => {
    setAnswering(true);
    try {
      const { answered } = await botsApi.answerQuestion(botId, pending.waitId, response);
      if (!answered) toast.error("That question was already answered or closed.");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t send that answer."));
    } finally {
      setAnswering(false);
    }
  };

  const chatActivity = botChatActivityOnDevice(
    showsBotToolActivity(toolActivitySetting, current ? [current] : []),
    current?.chatActivity,
  );
  const needsYou = summary.data?.needsYou === true || question !== null || approvalGroups.length > 0;
  // Waits the mini chat can't answer: the person finishes them in Aiden.
  const elsewhere = snapshot
    ? Boolean(
        snapshot.handoff ||
          snapshot.accessRequest ||
          snapshot.plan?.status === "pending" ||
          snapshot.entries.some(
            (entry) =>
              (entry.type === "issue" && entry.status === "open") ||
              (entry.type === "settings_change" && entry.change.mode === "held" && entry.status === "pending"),
          ),
      )
    : false;
  const stateNotice =
    state?.kind === "paused"
      ? botPausedText(name)
      : state?.kind === "unavailable"
        ? BOT_UNAVAILABLE_LABEL
        : state?.kind === "needs_model"
          ? `${name} needs an AI model.`
          : state?.kind === "model_error"
            ? `${name} can’t reach its AI model.`
            : state?.kind === "interrupted"
              ? BOT_INTERRUPTED_TEXT
              : null;
  const composerBlocked =
    state?.kind === "paused" || state?.kind === "unavailable" || state?.kind === "needs_model" || Boolean(snapshot?.handoff);
  const statusText = needsYou || elsewhere ? BOT_WAITING_LINE : running ? BOT_WORKING_LINE : null;
  const firstGroup = approvalGroups[0];

  return (
    <section
      ref={chatRef}
      data-bubble-hit={closing ? undefined : ""}
      data-bubble-chat={botId}
      data-closing={closing ? "" : undefined}
      data-side={placement.caretSide}
      hidden={hidden}
      inert={closing}
      aria-hidden={closing ? true : undefined}
      aria-label={`${name} chat`}
      className="bot-bubble-chat"
      onAnimationEnd={(event) => {
        // Its own animation only: a card or a message inside animates too.
        if (closing && event.target === event.currentTarget) onClosed?.();
      }}
      style={{ left: placement.x, top: placement.y, width: placement.width, height: placement.height }}
    >
      <span aria-hidden="true" className="bot-bubble-caret" data-side={placement.caretSide} style={{ top: placement.caretY }} />
      <div className="bot-bubble-chat-body">
        <header className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
          {current ? (
            <BotAvatar avatar={current.avatar} botId={current.id} name={name} size="small" photoLoading="immediate" working={running} />
          ) : (
            <span aria-hidden="true" className="size-7 shrink-0 rounded-card bg-control" />
          )}
          <div className="min-w-0 flex-1">
            <Text as="h2" variant="strong" truncate>
              {name}
            </Text>
            {statusText ? (
              <Text
                as="p"
                variant="small"
                truncate
                className={needsYou || elsewhere ? "text-status-warning" : "text-status-accent"}
              >
                {statusText}
              </Text>
            ) : null}
          </div>
          <Button iconOnly variant="bar" size="small" aria-label="Open in Aiden" title="Open in Aiden" onClick={openInAiden}>
            <Maximize2 aria-hidden="true" />
          </Button>
          <Button iconOnly variant="bar" size="small" aria-label="Shrink" title="Shrink" onClick={tuck}>
            <Minus aria-hidden="true" />
          </Button>
          <Button iconOnly variant="bar" size="small" aria-label="Close bubble" title="Close bubble" onClick={closeBubble}>
            <X aria-hidden="true" />
          </Button>
        </header>
        <div
          ref={scrollRef}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2"
          onScroll={(event) => {
            const scroller = event.currentTarget;
            pinnedToEnd.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
          }}
        >
          {snapshot === null ? (
            live.failed ? (
              <Callout color="red" role="alert" className="flex-row items-center justify-between gap-2">
                <Text variant="small" color="status-red">
                  Aiden couldn’t load {name}’s chat.
                </Text>
                <Button size="small" variant="filled" onClick={live.reload}>
                  Try again
                </Button>
              </Callout>
            ) : (
              <div role="status" aria-label="Loading chat" className="flex flex-col gap-3">
                <div className="ml-auto h-8 w-32 rounded-card bg-well motion-safe:animate-pulse" />
                <div className="h-12 w-48 max-w-full rounded-card bg-well motion-safe:animate-pulse" />
              </div>
            )
          ) : (
            <MessageAttachmentPreviewProvider>
              <TranscriptEntries
                name={name}
                entries={snapshot.entries}
                partial={snapshot.partial}
                running={running}
                level={chatActivity.level}
                queued={snapshot.queued ?? []}
                removing={removing}
                retrying={retrying}
                onRemoveQueued={(submissionId) => void removeQueued(submissionId)}
                // Connecting an app needs the full app's setup flow.
                onConnect={openInAiden}
                onReply={reply}
                onRetry={(failedId, text) => void retry(failedId, text)}
              />
            </MessageAttachmentPreviewProvider>
          )}
          {snapshot?.activity ? (
            <BotStatusLine activity={snapshot.activity} wording={chatActivity.wording} />
          ) : null}
          {stateNotice || elsewhere ? (
            <Callout color="warning" className="flex-row items-center justify-between gap-2">
              <Text variant="small" className="min-w-0 text-status-warning">
                {stateNotice ?? `${name} needs you in Aiden.`}
              </Text>
              <Button size="small" variant="filled" onClick={openInAiden}>
                Open in Aiden
              </Button>
            </Callout>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2 px-3 pb-3 pt-1">
          {firstGroup ? (
            <BotApprovalCard
              key={`${firstGroup[0]!.botId}:${firstGroup[0]!.waitId}`}
              name={name}
              prompt={firstGroup[0]!}
              pendingCount={approvalGroups.length}
              offerAuto={offerAuto}
              onAnswer={(decision, scope) => answerApprovalGroup(firstGroup, decision, scope)}
            />
          ) : null}
          {question ? (
            <AskUserQuestionComposer
              key={question.waitId}
              prompt={questionPrompt(question)}
              submitting={answering}
              onRespond={(response) => answerQuestion(question, response)}
            />
          ) : (
            <form
              className="flex items-end gap-1.5 rounded-pill bg-input py-1 pl-3.5 pr-1 transition-colors duration-(--motion-duration) ease-standard focus-within:bg-control"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={composerRef}
                rows={1}
                aria-label={`Message ${name}`}
                placeholder={composerBlocked ? (stateNotice ?? `Answer ${name} in Aiden first.`) : `Ask ${name}`}
                disabled={composerBlocked || !current}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (sendError) setSendError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                className="bot-bubble-textarea field-sizing-content max-h-28 min-h-7 flex-1 py-1 text-regular text-primary placeholder:text-secondary"
              />
              {running && !draft.trim() ? (
                <Button type="button" iconOnly variant="filled" size="small" aria-label={`Stop ${name}`} onClick={stop}>
                  <Square aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  iconOnly
                  variant="accent"
                  size="small"
                  aria-label="Send"
                  disabled={!draft.trim() || sending || composerBlocked}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
              )}
            </form>
          )}
          {sendError ? (
            <Text as="p" variant="small" color="status-red" role="alert">
              {sendError}
            </Text>
          ) : null}
        </div>
      </div>
    </section>
  );
}
