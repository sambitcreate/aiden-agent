// A Bot's one conversation, rendered from the durable projection (`useBotLive`).
// Sends go through `bots:send` with a fresh request UUID per message, so a retried
// send never doubles. Stop, Resume and Dismiss map to their runtime actions.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileText, Square } from "lucide-react";
import { AskUserQuestionComposer } from "../../components/ask-user-question-composer";
import { Composer } from "../../components/composer";
import { ConnectCard } from "../../components/bots/connect-card";
import { toolLabel } from "../../components/chat-approval-card";
import { SafeMessageBubble } from "../../components/message-bubble";
import { MessageAttachmentPreviewProvider, MessageAttachments } from "../../components/message-attachments";
import { insertTextIntoTextarea } from "../../lib/composer-type-focus";
import { Button, EmptyState, Text, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { Attachment } from "../../lib/types";
import { useBot } from "../../lib/queries";
import { useBotLive } from "../../lib/use-bot-live";
import { BOT_FAILED_TURN_TEXT, type BotPendingQuestion, type BotTranscriptEntry } from "../../shared/bot-live";
import type { AskUserQuestionPromptV1, AskUserQuestionResponseV1 } from "../../shared/ask-user-question";
import type { BotApprovalPrompt } from "../../../main/services/bot-runtime/bot-approvals";
import { BotChatActions, BotChatTitle } from "./bot-chat-header";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bot-chat-mode";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotNeedsModel } from "./bot-needs-model";
import { BotFilesDialog } from "./bot-files-dialog";
import { BotMessageActions, botReplyQuote } from "./bot-message-actions";
import { botTranscriptRows } from "./bot-transcript-rows";
import { BOT_UNAVAILABLE_LABEL, type BotSessionState } from "./bot-session-state";
import { BotUpdates } from "./bot-updates";
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
    <div role="group" aria-label={`${name} was interrupted`} className="flex max-w-md flex-col gap-3 rounded-2xl bg-control/50 p-4">
      <Text as="p" color="primary">
        {BOT_INTERRUPTED_TEXT}
      </Text>
      {accessChanged ? (
        <Text as="p" variant="small" color="secondary">
          {BOT_ACCESS_CHANGED_TEXT}{" "}
          <Button variant="transparent" size="small" onClick={onReviewAccess}>
            Open Advanced
          </Button>
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {accessChanged ? null : (
          <Button variant="accent" size="medium" disabled={busy} onClick={onResume}>
            Resume
          </Button>
        )}
        <Button variant="transparent" size="medium" disabled={busy} onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
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
}: {
  name: string;
  prompt: BotApprovalPrompt;
  onAnswer(decision: "allow" | "deny"): void;
}) {
  return (
    <div role="group" aria-label={`${name} needs approval`} className="flex max-w-md flex-col gap-3 rounded-2xl bg-control/50 p-4">
      <Text as="p" color="primary">
        {`${name} wants to use ${toolLabel(prompt.toolName)}.`}
      </Text>
      {prompt.summary ? (
        <Text as="p" variant="small" color="secondary" className="whitespace-pre-wrap break-words">
          {prompt.summary}
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="accent" size="medium" onClick={() => onAnswer("allow")}>
          Allow
        </Button>
        <Button variant="transparent" size="medium" onClick={() => onAnswer("deny")}>
          Deny
        </Button>
      </div>
    </div>
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
    <div role="group" aria-label={`${name} couldn’t finish a reply`} className="flex max-w-md flex-col gap-3 rounded-2xl bg-control/50 p-4">
      <Text as="p" color="primary">
        {BOT_FAILED_TURN_TEXT}
      </Text>
      {errorMessage ? (
        <Text as="p" variant="small" color="secondary" className="whitespace-pre-wrap break-words">
          {errorMessage}
        </Text>
      ) : null}
      {retryable ? (
        <div className="flex items-center gap-2">
          <Button variant="accent" size="medium" disabled={busy} onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A file the Bot wrote: a chip that opens Files at that file. */
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

/** Chat transcript rows: bubbles, one Updates line per reply, chips, cards. */
function TranscriptEntries({
  name,
  entries,
  partial,
  running,
  retrying,
  onConnect,
  onDismissConnection,
  onOpenFile,
  onReply,
  onRetry,
}: {
  name: string;
  entries: readonly BotTranscriptEntry[];
  partial: string | null;
  running: boolean;
  retrying: boolean;
  onConnect(pluginId: string): void;
  onDismissConnection(pluginId: string): void;
  onOpenFile(path: string): void;
  onReply(text: string): void;
  onRetry(text: string): void;
}) {
  const rows = botTranscriptRows(entries, partial, running);
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
                <SafeMessageBubble role="assistant" content={row.text} showCopy={false} />
              </BotMessageActions>
            );
          case "updates":
            return <BotUpdates key={row.id} progressText={row.progressText} timeline={null} active={row.active} />;
          case "file":
            return <BotFileChip key={row.id} path={row.path} operation={row.operation} onOpen={() => onOpenFile(row.path)} />;
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
              <Text key={row.id} as="p" variant="small" color="secondary" role="note">
                {row.notice === "session_reset" ? "This conversation was reset." : BOT_INTERRUPTED_TEXT}
              </Text>
            );
          case "connect":
            return <ConnectCard key={row.id} card={row.card} onConnect={onConnect} onDismiss={onDismissConnection} />;
          case "failed":
            return (
              <BotFailedTurnCard
                key={row.id}
                name={name}
                retryable={row.retryText !== null}
                busy={retrying}
                {...(row.errorMessage ? { errorMessage: row.errorMessage } : {})}
                onRetry={() => row.retryText !== null && onRetry(row.retryText)}
              />
            );
        }
      })}
    </>
  );
}

export function BotChatPane({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const bot = useBot(botId);
  const live = useBotLive(botId);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [files, setFiles] = React.useState<{ open: boolean; path: string | null }>({ open: false, path: null });
  const [retrying, setRetrying] = React.useState(false);
  const [pausedBusy, setPausedBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const snapshot = live.snapshot;
  const state: BotSessionState | undefined = snapshot?.state;
  const running = state?.kind === "running";

  const connectionSetup = useConnectionSetup(() => live.reload());
  const approvals = useBotApprovals(botId);
  const [answering, setAnswering] = React.useState(false);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [snapshot?.entries.length, snapshot?.partial]);

  if (bot.isLoading) {
    return <Text color="secondary">Loading…</Text>;
  }
  if (!bot.data) {
    return <EmptyState title="Bot not found" description="This Bot may have been deleted." />;
  }
  if (snapshot === null) {
    return live.failed ? (
      <EmptyState
        role="alert"
        title="This chat didn’t open"
        description={`Aiden couldn’t load ${bot.data.name}’s chat.`}
        action={
          <Button variant="accent" size="medium" onClick={live.reload}>
            Try again
          </Button>
        }
      />
    ) : (
      <Text color="secondary">Loading…</Text>
    );
  }
  const current = bot.data;
  const back = () => void navigate({ to: "/bots" });
  const openProfile = () => void navigate({ to: "/bots/$botId", params: { botId: current.id } });

  if (state?.kind === "needs_model") {
    return (
      <BotNeedsModel
        bot={current}
        onBack={back}
        onOpenProfile={openProfile}
        onSetUp={() => void navigate({ to: "/settings", search: { section: "providers" } })}
      />
    );
  }

  const question = snapshot.question;

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
    try {
      await botsApi.send({
        botId: current.id,
        text: body,
        requestId: crypto.randomUUID(),
        ...(whenBusy ? { whenBusy } : {}),
        ...(images.length > 0 ? { attachments: images } : {}),
      });
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t send to ${current.name}.`));
      throw error;
    }
  };

  const resume = async () => {
    setPausedBusy(true);
    try {
      await botsApi.resume(current.id, crypto.randomUUID());
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t resume ${current.name}.`));
    } finally {
      setPausedBusy(false);
    }
  };

  const dismiss = async () => {
    setPausedBusy(true);
    try {
      await botsApi.dismiss(current.id, crypto.randomUUID());
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t dismiss that for ${current.name}.`));
    } finally {
      setPausedBusy(false);
    }
  };

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

  /** Retry: the same message as a NEW submission, with a new request id. */
  const retry = async (text: string) => {
    setRetrying(true);
    try {
      await botsApi.send({ botId: current.id, text, requestId: crypto.randomUUID() });
    } catch (error) {
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

  const dismissConnection = async (pluginId: string) => {
    try {
      await botsApi.dismissConnection(current.id, pluginId);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save that choice."));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 pb-2">
        <BotChatTitle bot={current} onBack={back} onOpenProfile={openProfile} />
        <BotChatActions
          bot={current}
          onOpenProfile={openProfile}
          onOpenFiles={() => setFiles({ open: true, path: null })}
          onDelete={() => setDeleteOpen(true)}
        />
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <MessageAttachmentPreviewProvider>
            <TranscriptEntries
              name={current.name}
              entries={snapshot.entries}
              partial={snapshot.partial}
              running={running}
              retrying={retrying}
              onConnect={(pluginId) => void connectionSetup.open(pluginId)}
              onDismissConnection={(pluginId) => void dismissConnection(pluginId)}
              onOpenFile={(path) => setFiles({ open: true, path })}
              onReply={reply}
              onRetry={(text) => void retry(text)}
            />
          </MessageAttachmentPreviewProvider>
          {state?.kind === "interrupted" ? (
            <BotInterruptedCard
              name={current.name}
              {...(state.blocked ? { blocked: state.blocked } : {})}
              busy={pausedBusy}
              onResume={() => void resume()}
              onDismiss={() => void dismiss()}
              onReviewAccess={openProfile}
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
          {state?.kind === "model_error" ? (
            <Text as="p" variant="small" color="secondary" role="alert">
              {state.message}
            </Text>
          ) : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-2 pb-4">
        {/* A waiting A–E question takes the composer's place, as in workspace chats. */}
        {question ? (
          <div className="flex flex-col gap-2">
            <AskUserQuestionComposer
              key={question.waitId}
              prompt={questionPrompt(question)}
              submitting={answering}
              onRespond={(response) => answerQuestion(question, response)}
            />
            {/* The card replaces the composer, so Stop lives here while it waits. */}
            <div className="flex justify-end">
              <Button variant="filled" size="medium" className="gap-2" onClick={stop}>
                <Square aria-hidden="true" />
                Stop
              </Button>
            </div>
          </div>
        ) : (
          <Composer
            key={`bot:${current.id}`}
            ready={!state || state.kind !== "unavailable"}
            readinessMessage={state?.kind === "unavailable" ? BOT_UNAVAILABLE_LABEL : undefined}
            hasMessages={snapshot.entries.length > 0}
            chatId={`bot:${current.id}`}
            placeholder={`Ask ${current.name}`}
            onSend={(text, attachments) => send(text, attachments)}
            onQueue={(text, attachments) => send(text, attachments, "followUp")}
            onSteer={(text, attachments) => send(text, attachments, "steer")}
            onStop={stop}
            isGenerating={running}
            canStopGeneration={running}
            inputRef={composerRef}
            surfaces={BOT_CHAT_COMPOSER_SURFACES}
          />
        )}
      </div>
      <BotDeleteDialog bot={current} open={deleteOpen} onOpenChange={setDeleteOpen} />
      <BotFilesDialog
        botId={current.id}
        botName={current.name}
        open={files.open}
        initialPath={files.path}
        onOpenChange={(open) => setFiles((value) => ({ ...value, open }))}
      />
      {connectionSetup.dialog}
    </div>
  );
}
