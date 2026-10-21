// `/host/$hostId/bots/$botId/chat`: a Bot that lives on a paired host, in the
// same one durable conversation the host's own app, its phones and Telegram
// show. The host runs every turn; this Mac reads the session, follows its live
// stream and sends through the host's Bot session routes.

import * as React from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Ellipsis, Pause, Play, Square } from "lucide-react";
import { AskUserQuestionComposer } from "../components/ask-user-question-composer";
import { HandoffCard } from "../components/bots/handoff-card";
import { Composer } from "../components/composer";
import { MessageAttachmentPreviewProvider } from "../components/message-attachments";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ScrollArea,
  Text,
  toast,
} from "../components/ui";
import { insertTextIntoTextarea } from "../lib/composer-type-focus";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { hostServesBotHandoffs, hostSharesBotSessions } from "../lib/hosts/remote-bot-session";
import { useRemoteBotSession } from "../lib/hosts/use-remote-bot-session";
import { browserApi, peerHostsApi } from "../lib/ipc";
import type { Attachment } from "../lib/types";
import type { AskUserQuestionResponseV1 } from "../shared/ask-user-question";
import { DEFAULT_BOT_AVATAR, isBotAvatar, resolveBotChatActivity, type BotAvatar } from "../shared/bots";
import { BOT_HANDOFF_NOTE_MAX_CHARS, type BotHandoffOutcome } from "../shared/bot-handoffs";
import type { BotPendingQuestion } from "../shared/bot-live";
import { mintPeerIdempotencyKey, type PeerHostFeedSnapshot, type PeerHostView, type PeerOperationOutcome } from "../shared/peer-host";
import type { PeerOperation } from "../shared/peer-operation";
import type { AidenRemoteBotHandoff } from "../../main/services/aiden-remote-protocol";
import { BotApprovalCard, BotInterruptedCard, TranscriptEntries, questionPrompt } from "./bots/bot-chat-pane";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bots/bot-chat-mode";
import { botReplyQuote } from "./bots/bot-message-actions";
import { BotPausedNotice, botPausedText } from "./bots/bot-paused-card";
import { BotStatusLine } from "./bots/bot-status-line";

/** Text files ride along in the message, as in a local Bot chat. */
function attachmentText(attachments: readonly Attachment[]): string {
  return attachments
    .filter((attachment) => attachment.kind === "text" && attachment.text)
    .map((attachment) => `\n\n${attachment.name}:\n${attachment.text}`)
    .join("");
}

function botName(feed: PeerHostFeedSnapshot | null | undefined, botId: string): string | null {
  const row = feed?.bots.find((bot) => bot.id === botId);
  const name = row && typeof row.name === "string" ? row.name.trim() : "";
  return name || null;
}

/** The Bot's character as the host's list draws it, for the hand-off card's tile. */
function botAvatar(feed: PeerHostFeedSnapshot | null | undefined, botId: string): BotAvatar {
  const avatar = feed?.bots.find((bot) => bot.id === botId)?.avatar;
  const semantic = avatar && typeof avatar === "object" ? (avatar as { semantic?: unknown }).semantic : undefined;
  return isBotAvatar(semantic) ? semantic : DEFAULT_BOT_AVATAR;
}

/** A hand-off answer the host may have recorded: sent again, it goes under the same key. */
interface UnsettledHandoffAnswer {
  waitId: string;
  outcome: BotHandoffOutcome;
  note: string | undefined;
  key: string;
}

/** A send the host may have accepted: replayed exactly, under its key, if sent again. */
interface UnsettledBotSend {
  text: string;
  /** The photos' own bytes, so a different photo is never mistaken for a staged one. */
  photos: readonly (readonly [string, string, string])[];
  key: string;
  body: Record<string, unknown>;
}

function photoIdentity(images: readonly Attachment[]): (readonly [string, string, string])[] {
  return images.map((image) => [image.name, image.mimeType, image.data ?? ""] as const);
}

function sameSend(pending: UnsettledBotSend, text: string, photos: readonly (readonly [string, string, string])[]): boolean {
  return (
    pending.text === text &&
    pending.photos.length === photos.length &&
    pending.photos.every((photo, index) => photo.every((part, at) => part === photos[index]?.[at]))
  );
}

export function RemoteBotChatView({ hostId, botId }: { hostId: string; botId: string }) {
  const navigate = useNavigate();
  const list = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const feed = useQuery<PeerHostFeedSnapshot | null>({ queryKey: hostQueryKeys.feed(hostId), queryFn: skipToken });
  const host = list.data?.find((view) => view.id === hostId);
  const hostName = host?.name ?? "the other Mac";
  const name = botName(feed.data, botId) ?? "Bot";
  const avatar = botAvatar(feed.data, botId);
  // A host too old to share the conversation is told so below, without asking it.
  const shared = !host || hostSharesBotSessions(host);
  const live = useRemoteBotSession(hostId, botId, shared);
  const [busy, setBusy] = React.useState<"paused" | "answer" | "handoff" | "pause" | "retry" | "connect" | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [answered, setAnswered] = React.useState<ReadonlySet<string>>(new Set());
  const [statusLayout, setStatusLayout] = React.useState("");
  // A send whose acknowledgement was lost keeps its key and staged photos, so
  // sending the same thing again is deduplicated by the host, not repeated.
  const unsettledSend = React.useRef<UnsettledBotSend | null>(null);
  const unsettledHandoff = React.useRef<UnsettledHandoffAnswer | null>(null);
  // The hand-off card this Mac settled, hidden only while the host's view still
  // holds that same card. Resume asks a hand-off again under the same wait id:
  // the host's frame (or a fresh snapshot) for it is a new card, and it shows.
  const [settledHandoff, setSettledHandoff] = React.useState<AidenRemoteBotHandoff | null>(null);
  const shownHandoff = React.useRef<AidenRemoteBotHandoff | null>(null);
  shownHandoff.current = live.view?.handoff ?? null;

  const view = live.view;
  const snapshot = view?.snapshot ?? null;
  const state = snapshot?.state;
  const running = state?.kind === "running";
  const features = new Set(host?.features ?? []);
  const steerAndQueue = features.has("bot-activity-v1");
  const photos = features.has("bot-attachments-v1");
  const connections = features.has("bot-connection-requests-v1");
  // Revision 37: hand-off cards, the person's pause, and Pause and Resume from here.
  const handoffs = host ? hostServesBotHandoffs(host) : false;
  const isPaused = view?.paused === true;

  /** One host operation; failures become a toast with the host's own words. */
  const call = async (operation: PeerOperation, failure: string): Promise<PeerOperationOutcome & { ok: true }> => {
    const outcome = await peerHostsApi.call(hostId, operation);
    if (outcome.ok) return outcome;
    toast.error(outcome.error.code === "outcome_unknown" ? `${hostName} may not have received that. Check the chat before trying again.` : outcome.error.message || failure);
    throw Object.assign(new Error(outcome.error.message || failure), { code: outcome.error.code });
  };

  /** Pause the Bot on its own Mac, or lift the pause. The host's stream then carries the new state. */
  const setPaused = async (pause: boolean) => {
    setBusy("pause");
    try {
      await call(
        { operation: pause ? "botPause" : "botUnpause", resourceId: botId, idempotencyKey: mintPeerIdempotencyKey(), body: {} },
        pause ? `Aiden couldn’t pause ${name}.` : `Aiden couldn’t resume ${name}.`,
      );
      // While the stream reconnects, read the session so the change shows now.
      if (live.stream !== "streaming") live.reload();
    } catch {
      // The toast said why.
    } finally {
      setBusy(null);
    }
  };

  const shell = (body: React.ReactNode, footer?: React.ReactNode) => (
    <ScrollArea
      scrollRestorationId={`remote-bot-chat:${hostId}:${botId}`}
      className="h-full min-h-0"
      alignFooterToScrollContent
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{name}</span>
          <Text as="span" variant="small" color="tertiary" className="truncate">
            on {hostName}
          </Text>
        </span>
      }
      actions={
        handoffs && snapshot ? (
          <RemoteBotMenu name={name} paused={isPaused} disabled={busy === "pause"} onPause={(pause) => void setPaused(pause)} />
        ) : null
      }
      autoScrollToBottom
      autoScrollResetKey={`${hostId}/${botId}`}
      autoScrollDeps={[
        snapshot?.entries.length,
        snapshot?.partial,
        state?.kind,
        view?.approval?.waitId,
        view?.handoff?.waitId,
        isPaused,
        snapshot?.question?.waitId,
        snapshot?.activity?.phase,
        snapshot?.queued.length ?? 0,
        statusLayout,
      ]}
      showScrollToBottomButton
      streaming={running}
      footer={footer}
    >
      {body}
    </ScrollArea>
  );

  const centered = (content: React.ReactNode) => <div className="flex min-h-full items-center justify-center">{content}</div>;

  if (!shared) {
    return shell(
      centered(
        <EmptyState
          title="This Bot's chat isn't shared"
          description={`Update Aiden on ${hostName}, and check that it lets this Mac use its Bots.`}
          action={
            <Button variant="filled" onClick={() => void navigate({ to: "/bots" })}>
              All Bots
            </Button>
          }
        />,
      ),
    );
  }
  if (live.gone) {
    return shell(
      centered(
        <EmptyState
          title="Bot not found"
          description={`This Bot may have been deleted on ${hostName}, or this Mac may no longer use it.`}
          action={
            <Button variant="filled" onClick={() => void navigate({ to: "/bots" })}>
              All Bots
            </Button>
          }
        />,
      ),
    );
  }
  if (snapshot === null || view === null) {
    return shell(
      live.failed ? (
        centered(
          <EmptyState
            role="alert"
            title="This chat didn’t open"
            description={live.failed}
            action={
              <Button variant="accent" size="medium" onClick={live.reload}>
                Try again
              </Button>
            }
          />,
        )
      ) : (
        <div role="status" aria-label="Loading chat" className="aiden-dock-inset chat-content-column flex flex-col gap-4 py-6">
          <div className="ml-auto h-9 w-48 rounded-card bg-well motion-safe:animate-pulse" />
          <div className="h-16 w-72 max-w-full rounded-card bg-well motion-safe:animate-pulse" />
          <span className="sr-only">Loading…</span>
        </div>
      ),
    );
  }
  if (state?.kind === "needs_model") {
    return shell(
      centered(
        <EmptyState title={`${name} needs an AI model`} description={`Choose a model for ${name} on ${hostName}.`} />,
      ),
    );
  }

  const chatActivity = resolveBotChatActivity(undefined);
  const activityPhase = snapshot.activity?.phase;
  const replyStreaming =
    running && (snapshot.partial?.trim().length ?? 0) > 0 && (activityPhase === "writing" || activityPhase === "thinking");
  const statusActivity = snapshot.activity && !replyStreaming ? snapshot.activity : null;
  const question = snapshot.question && !answered.has(snapshot.question.waitId) ? snapshot.question : null;
  const approval = view.approval && !answered.has(view.approval.waitId) ? view.approval : null;
  const handoff = view.handoff && view.handoff !== settledHandoff ? view.handoff : null;
  // A sign-in happens in the Bot's own browser on its Mac: typing here can't finish it.
  const signInElsewhere = handoff?.kind === "sign_in";

  const send = async (text: string, attachments: Attachment[], whenBusy?: "steer" | "followUp"): Promise<void> => {
    const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.data);
    // Throwing keeps the draft in the composer.
    if (attachments.some((attachment) => attachment.kind !== "image" && attachment.kind !== "text")) {
      toast.error("Bots take photos and text files for now.");
      throw new Error("unsupported attachment");
    }
    if (images.length > 0 && !photos) {
      toast.error(`Update Aiden on ${hostName} to send photos to ${name}.`);
      throw new Error("photos unsupported");
    }
    const fullText = `${text}${attachmentText(attachments)}`;
    const identity = photoIdentity(images);
    // The same draft sent again replays the unsettled request as it was, even
    // if the Bot has started running since and the composer now queues it.
    const retry = unsettledSend.current && sameSend(unsettledSend.current, fullText, identity) ? unsettledSend.current : null;
    unsettledSend.current = null;
    let key: string;
    let body: Record<string, unknown>;
    if (retry) {
      key = retry.key;
      body = retry.body;
    } else {
      const attachmentIds: string[] = [];
      for (const image of images) {
        const uploaded = await call(
          {
            operation: "uploadBotAttachment",
            resourceId: botId,
            body: { name: image.name, mimeType: image.mimeType, kind: "image", data: image.data },
          },
          "Aiden couldn’t send that photo.",
        );
        const id = (uploaded.value as { id?: unknown } | null)?.id;
        if (typeof id === "string") attachmentIds.push(id);
      }
      key = mintPeerIdempotencyKey();
      body = {
        text: fullText,
        ...(whenBusy && steerAndQueue ? { whenBusy: whenBusy === "steer" ? "steer" : "queue" } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      };
    }
    try {
      await call({ operation: "botSend", resourceId: botId, idempotencyKey: key, body }, `Aiden couldn’t send to ${name}.`);
    } catch (error) {
      if ((error as { code?: unknown }).code === "outcome_unknown") {
        unsettledSend.current = { text: fullText, photos: identity, key, body };
      }
      throw error;
    }
  };

  const keyed = (operation: "botResume" | "botDismiss" | "botStop") =>
    call({ operation, resourceId: botId, idempotencyKey: mintPeerIdempotencyKey(), body: {} }, `Aiden couldn’t reach ${name}.`);

  const paused = async (operation: "botResume" | "botDismiss") => {
    setBusy("paused");
    await keyed(operation).catch(() => undefined);
    setBusy(null);
  };

  const stop = () => void keyed("botStop").catch(() => undefined);

  const answerQuestion = async (pending: BotPendingQuestion, response: AskUserQuestionResponseV1) => {
    setBusy("answer");
    try {
      await call(
        {
          operation: "botAnswerQuestion",
          resourceId: botId,
          itemId: pending.waitId,
          idempotencyKey: mintPeerIdempotencyKey(),
          body: response,
        },
        "Aiden couldn’t send that answer.",
      );
      setAnswered((ids) => new Set(ids).add(pending.waitId));
    } catch {
      // The toast said why; the question stays so it can be answered again.
    } finally {
      setBusy(null);
    }
  };

  /** Hide a settled hand-off card, unless the host's view has already moved past it. */
  const hideCard = (waitId: string) => {
    const shown = shownHandoff.current;
    if (shown?.waitId === waitId) setSettledHandoff(shown);
  };

  /**
   * Done or Skip for the hand-off card, through the host's own route. Returns
   * null once the host recorded it (or the card was already settled there),
   * else what to tell the person; the card then stays to be answered again.
   */
  const sendHandoffAnswer = async (
    pending: AidenRemoteBotHandoff,
    outcome: BotHandoffOutcome,
    note?: string,
  ): Promise<string | null> => {
    const retry = unsettledHandoff.current;
    // The same answer after a lost acknowledgement goes again under its key, so the host records it once.
    const key =
      retry && retry.waitId === pending.waitId && retry.outcome === outcome && retry.note === note
        ? retry.key
        : mintPeerIdempotencyKey();
    unsettledHandoff.current = null;
    setBusy("handoff");
    try {
      const outcomeOf = await peerHostsApi.call(hostId, {
        operation: "botAnswerHandoff",
        resourceId: botId,
        itemId: pending.waitId,
        idempotencyKey: key,
        body: note === undefined ? { outcome } : { outcome, note },
      });
      if (outcomeOf.ok) {
        hideCard(pending.waitId);
        return null;
      }
      if (outcomeOf.error.remoteCode === "handoff_expired") {
        // Answered on the host or another device, or withdrawn: it stays gone.
        hideCard(pending.waitId);
        toast.info("That card was already answered or closed.");
        return null;
      }
      if (outcomeOf.error.code === "outcome_unknown") {
        unsettledHandoff.current = { waitId: pending.waitId, outcome, note, key };
        return `${hostName} may not have received that. Check the chat before trying again.`;
      }
      return outcomeOf.error.message || "Aiden couldn’t send that answer.";
    } finally {
      setBusy(null);
    }
  };

  const answerHandoff = async (pending: AidenRemoteBotHandoff, outcome: BotHandoffOutcome) => {
    const problem = await sendHandoffAnswer(pending, outcome);
    if (problem) toast.error(problem);
  };

  /**
   * What the person types while a hand-off card waits answers it as Done, with
   * their words as the note. A throw keeps the draft in the composer, which
   * shows the error's message.
   */
  const answerHandoffWithNote = async (pending: AidenRemoteBotHandoff, text: string, attachments: Attachment[]) => {
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
    const problem = await sendHandoffAnswer(pending, "done", note || undefined);
    if (problem) throw new Error(problem);
  };

  /** Open: the page the Bot named, in this Mac's browser. */
  const openHandoff = async (pending: AidenRemoteBotHandoff) => {
    if (!pending.open) return;
    try {
      await browserApi.openExternal(pending.open.url);
    } catch {
      toast.error("Aiden couldn’t open that page.");
    }
  };

  /** Finish on <Mac>: bring the sign-in forward in the Bot's own browser there. */
  const finishHandoff = async (pending: AidenRemoteBotHandoff) => {
    setBusy("handoff");
    try {
      const outcome = await peerHostsApi.call(hostId, {
        operation: "botHandoffOpenOnMac",
        resourceId: botId,
        itemId: pending.waitId,
        idempotencyKey: mintPeerIdempotencyKey(),
        body: {},
      });
      if (outcome.ok) {
        const opened = (outcome.value as { opened?: unknown } | null)?.opened === true;
        if (opened) toast.success(`Finish signing in on ${hostName}.`);
        else toast.info(`Open Aiden on ${hostName} to finish signing in.`);
      } else if (outcome.error.remoteCode === "handoff_expired") {
        hideCard(pending.waitId);
        toast.info("That card was already answered or closed.");
      } else {
        toast.error(
          outcome.error.code === "outcome_unknown"
            ? `${hostName} may not have received that. Check it before trying again.`
            : outcome.error.message || `Aiden couldn’t reach ${hostName}.`,
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const retry = async (text: string) => {
    setBusy("retry");
    await send(text, []).catch(() => undefined);
    setBusy(null);
  };

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

  const connect = async (pluginId: string) => {
    if (!connections) {
      toast.info(`Connect it on ${hostName}.`);
      return;
    }
    setBusy("connect");
    try {
      const sent = await call(
        { operation: "botConnectionRequest", resourceId: botId, idempotencyKey: mintPeerIdempotencyKey(), body: { pluginId } },
        "Aiden couldn’t ask for that connection.",
      );
      const label = (sent.value as { name?: unknown } | null)?.name;
      toast.success(`Finish connecting ${typeof label === "string" ? label : "it"} on ${hostName}.`);
    } catch {
      // The toast said why.
    } finally {
      setBusy(null);
    }
  };

  const footer = (
    <div className="flex flex-col">
      {approval || handoff ? (
        <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-2">
          {handoff ? (
            <HandoffCard
              key={handoff.waitId}
              name={name}
              avatar={avatar}
              handoff={handoff}
              busy={busy === "handoff"}
              finishOn={hostName}
              onOpen={() => void openHandoff(handoff)}
              onFinish={() => void finishHandoff(handoff)}
              onAnswer={(outcome) => void answerHandoff(handoff, outcome)}
            />
          ) : null}
          {approval ? (
            <BotApprovalCard
              key={approval.waitId}
              name={name}
              prompt={{ botId, waitId: approval.waitId, toolCallId: approval.toolCallId, toolName: approval.toolName, summary: approval.summary }}
              {...(approval.canAllow ? {} : { allowElsewhere: hostName })}
              onAnswer={(decision) => {
                setAnswered((ids) => new Set(ids).add(approval.waitId));
                void call(
                  { operation: "respondApproval", resourceId: approval.waitId, idempotencyKey: mintPeerIdempotencyKey(), body: { decision } },
                  "Aiden couldn’t send that answer.",
                ).catch(() =>
                  setAnswered((ids) => {
                    const rest = new Set(ids);
                    rest.delete(approval.waitId);
                    return rest;
                  }),
                );
              }}
            />
          ) : null}
        </div>
      ) : null}
      {question ? (
        <>
          <AskUserQuestionComposer
            key={question.waitId}
            prompt={questionPrompt(question)}
            submitting={busy === "answer"}
            onRespond={(response) => answerQuestion(question, response)}
          />
          <div className="aiden-dock-inset chat-content-column flex justify-end pb-4 pt-2">
            <Button variant="filled" size="small" onClick={stop}>
              <Square aria-hidden="true" />
              Stop
            </Button>
          </div>
        </>
      ) : (
        <Composer
          key={`remote-bot:${hostId}:${botId}`}
          ready={state?.kind !== "unavailable" && !isPaused && !signInElsewhere}
          readinessMessage={
            isPaused
              ? botPausedText(name)
              : signInElsewhere
                ? `Finish signing in on ${hostName}, or skip it.`
                : state?.kind === "unavailable"
                  ? `${name} can’t take messages on ${hostName} right now.`
                  : undefined
          }
          hasMessages={snapshot.entries.length > 0}
          chatId={`remote-bot:${hostId}:${botId}`}
          placeholder={handoff ? "Add a note and send to mark it done" : `Ask ${name}`}
          onSend={(text, attachments) => (handoff ? answerHandoffWithNote(handoff, text, attachments) : send(text, attachments))}
          {...(steerAndQueue && !handoff
            ? {
                onQueue: (text: string, attachments: Attachment[]) => send(text, attachments, "followUp"),
                onSteer: (text: string, attachments: Attachment[]) => send(text, attachments, "steer"),
              }
            : {})}
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
      {live.stream === "waiting" ? (
        <Text as="p" variant="small" color="tertiary" role="status" className="text-center">
          Reconnecting to {hostName}…
        </Text>
      ) : null}
      <MessageAttachmentPreviewProvider>
        <TranscriptEntries
          name={name}
          entries={snapshot.entries}
          partial={snapshot.partial}
          running={running}
          level={chatActivity.level}
          queued={snapshot.queued}
          removing={new Set()}
          retrying={busy === "retry"}
          onConnect={(pluginId) => void connect(pluginId)}
          connectLabel={`Finish on ${hostName}`}
          connecting={busy === "connect"}
          onReply={reply}
          onRetry={(text) => void retry(text)}
        />
      </MessageAttachmentPreviewProvider>
      {statusActivity ? (
        <BotStatusLine activity={statusActivity} wording={chatActivity.wording} onStop={stop} onLayoutChange={setStatusLayout} />
      ) : null}
      {isPaused ? <BotPausedNotice name={name} busy={busy === "pause"} onResume={() => void setPaused(false)} /> : null}
      {state?.kind === "interrupted" ? (
        <BotInterruptedCard
          name={name}
          {...(state.blocked ? { blocked: state.blocked } : {})}
          busy={busy === "paused"}
          onResume={() => void paused("botResume")}
          onDismiss={() => void paused("botDismiss")}
          onReviewAccess={() => toast.info(`Review ${name}'s access on ${hostName}.`)}
        />
      ) : null}
    </div>,
    footer,
  );
}

/**
 * The header's ••• menu for a Bot on another Mac: Pause Bot, or Resume Bot
 * while the person's pause holds. Its other actions live on that Mac.
 */
function RemoteBotMenu({
  name,
  paused,
  disabled,
  onPause,
}: {
  name: string;
  paused: boolean;
  disabled: boolean;
  onPause(pause: boolean): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button iconOnly variant="transparent" size="small" aria-label={`More for ${name}`} disabled={disabled}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onPause(!paused)}>
          {paused ? <Play className="size-4 shrink-0" /> : <Pause className="size-4 shrink-0" />}
          {paused ? "Resume Bot" : "Pause Bot"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
