// `/host/$hostId/bots/$botId/chat`: a Bot that lives on a paired host, in the
// same one durable conversation the host's own app, its phones and Telegram
// show. The host runs every turn; this Mac reads the session, follows its live
// stream and sends through the host's Bot session routes.

import * as React from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Square } from "lucide-react";
import { AskUserQuestionComposer } from "../components/ask-user-question-composer";
import { Composer } from "../components/composer";
import { MessageAttachmentPreviewProvider } from "../components/message-attachments";
import { Button, EmptyState, ScrollArea, Text, toast } from "../components/ui";
import { insertTextIntoTextarea } from "../lib/composer-type-focus";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { hostSharesBotSessions } from "../lib/hosts/remote-bot-session";
import { useRemoteBotSession } from "../lib/hosts/use-remote-bot-session";
import { peerHostsApi } from "../lib/ipc";
import type { Attachment } from "../lib/types";
import type { AskUserQuestionResponseV1 } from "../shared/ask-user-question";
import { resolveBotChatActivity } from "../shared/bots";
import type { BotPendingQuestion } from "../shared/bot-live";
import { mintPeerIdempotencyKey, type PeerHostFeedSnapshot, type PeerHostView, type PeerOperationOutcome } from "../shared/peer-host";
import type { PeerOperation } from "../shared/peer-operation";
import { BotApprovalCard, BotInterruptedCard, TranscriptEntries, questionPrompt } from "./bots/bot-chat-pane";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bots/bot-chat-mode";
import { botReplyQuote } from "./bots/bot-message-actions";
import { BotStatusLine } from "./bots/bot-status-line";
import { BOT_UNAVAILABLE_LABEL } from "./bots/bot-session-state";

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
  // A host too old to share the conversation is told so below, without asking it.
  const shared = !host || hostSharesBotSessions(host);
  const live = useRemoteBotSession(hostId, botId, shared);
  const [busy, setBusy] = React.useState<"paused" | "answer" | "retry" | "connect" | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [answered, setAnswered] = React.useState<ReadonlySet<string>>(new Set());
  const [statusLayout, setStatusLayout] = React.useState("");
  // A send whose acknowledgement was lost keeps its key and staged photos, so
  // sending the same thing again is deduplicated by the host, not repeated.
  const unsettledSend = React.useRef<UnsettledBotSend | null>(null);

  const view = live.view;
  const snapshot = view?.snapshot ?? null;
  const state = snapshot?.state;
  const running = state?.kind === "running";
  const features = new Set(host?.features ?? []);
  // Queued messages only show here when the host sends this Mac its activity frames.
  const steerAndQueue = features.has("bot-activity-v1") && (host?.capabilities ?? []).includes("bot:activity");
  const photos = features.has("bot-attachments-v1");
  const connections = features.has("bot-connection-requests-v1");

  /** One host operation; failures become a toast with the host's own words. */
  const call = async (operation: PeerOperation, failure: string): Promise<PeerOperationOutcome & { ok: true }> => {
    const outcome = await peerHostsApi.call(hostId, operation);
    if (outcome.ok) return outcome;
    toast.error(outcome.error.code === "outcome_unknown" ? `${hostName} may not have received that. Check the chat before trying again.` : outcome.error.message || failure);
    throw Object.assign(new Error(outcome.error.message || failure), { code: outcome.error.code });
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
      autoScrollToBottom
      autoScrollResetKey={`${hostId}/${botId}`}
      autoScrollDeps={[
        snapshot?.entries.length,
        snapshot?.partial,
        state?.kind,
        view?.approval?.waitId,
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

  if (list.data && !host) {
    return shell(
      centered(
        <EmptyState
          title="This device isn't paired anymore"
          description="Pair it again in Settings to use its Bots here."
          action={
            <Button variant="filled" onClick={() => void navigate({ to: "/bots" })}>
              All Bots
            </Button>
          }
        />,
      ),
    );
  }
  if (!shared) {
    return shell(
      centered(
        <EmptyState
          title="This Bot's chat isn't shared"
          description={
            features.has("bot-durable-session-v1")
              ? `This device can see ${hostName}'s Bots but can't chat with them. Pair it again from ${hostName} to update its access.`
              : `Update Aiden on ${hostName} to chat with its Bots here.`
          }
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
      {approval ? (
        <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-2">
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
          ready={state?.kind !== "unavailable"}
          readinessMessage={state?.kind === "unavailable" ? BOT_UNAVAILABLE_LABEL : undefined}
          hasMessages={snapshot.entries.length > 0}
          chatId={`remote-bot:${hostId}:${botId}`}
          placeholder={`Ask ${name}`}
          onSend={(text, attachments) => send(text, attachments)}
          {...(steerAndQueue
            ? {
                onQueue: (text: string, attachments: Attachment[]) => send(text, attachments, "followUp"),
                onSteer: (text: string, attachments: Attachment[]) => send(text, attachments, "steer"),
              }
            : {})}
          onStop={stop}
          isGenerating={running}
          canStopGeneration={running}
          inputRef={composerRef}
          surfaces={BOT_CHAT_COMPOSER_SURFACES}
        />
      )}
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
