// A Bot's one conversation, rendered from the durable projection (`useBotLive`).
// Sends go through `bots:send` with a fresh request UUID per message, so a retried
// send never doubles. Stop, Resume and Dismiss map to their runtime actions.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, FileText, Pause, RotateCcw, ShieldQuestion, Square } from "lucide-react";
import { AskUserQuestionComposer } from "../../components/ask-user-question-composer";
import { Composer } from "../../components/composer";
import { ConnectCard } from "../../components/bots/connect-card";
import { RoutineProposalCard } from "../../components/bots/routine-proposal-card";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import { toolLabel } from "../../components/chat-approval-card";
import { SafeMessageBubble } from "../../components/message-bubble";
import { MessageAttachmentPreviewProvider, MessageAttachments } from "../../components/message-attachments";
import { insertTextIntoTextarea } from "../../lib/composer-type-focus";
import { Button, EmptyState, ScrollArea, Text, toast } from "../../components/ui";
import { BotNoticeCard } from "../../components/bots/bot-notice-card";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { Attachment } from "../../lib/types";
import { useBot } from "../../lib/queries";
import { useBotLive } from "../../lib/use-bot-live";
import { BOT_FAILED_TURN_TEXT, type BotPendingQuestion, type BotTranscriptEntry } from "../../shared/bot-live";
import type { AskUserQuestionPromptV1, AskUserQuestionResponseV1 } from "../../shared/ask-user-question";
import type { BotApprovalPrompt } from "../../../main/services/bot-runtime/bot-approvals";
import type { BotRoutineProposalDecision, BotRoutineProposalStatus } from "../../shared/bot-routine-proposals";
import { BotChatActions, BotChatBackButton, BotChatNamePill } from "./bot-chat-header";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bot-chat-mode";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotNeedsModel } from "./bot-needs-model";
import { BotFilesDialog } from "./bot-files-dialog";
import { BotMessageActions, botReplyQuote } from "./bot-message-actions";
import { botTranscriptRows } from "./bot-transcript-rows";
import { BOT_UNAVAILABLE_LABEL, type BotSessionState } from "./bot-session-state";
import { botRoutinesKey } from "./bot-routines";
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
}: {
  name: string;
  prompt: BotApprovalPrompt;
  onAnswer(decision: "allow" | "deny"): void;
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
          <Button variant="accent" size="small" onClick={() => onAnswer("allow")}>
            Allow
          </Button>
        </>
      }
    >
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

/** "Memory updated": a quiet, centred caption that opens Profile → Memory. */
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
  onOpenMemory,
  onRespondToProposal,
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
  onOpenMemory(): void;
  onRespondToProposal(
    proposalId: string,
    decision: BotRoutineProposalDecision,
  ): Promise<Exclude<BotRoutineProposalStatus, "pending"> | null>;
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
              <Text key={row.id} as="p" variant="small" color="tertiary" role="note" className="py-1 text-center">
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
          case "memory_update":
            return <BotMemoryUpdatedCaption key={row.id} onOpen={onOpenMemory} />;
          case "routine_proposal":
            return (
              <RoutineProposalCard
                key={row.id}
                proposal={row.proposal}
                status={row.status}
                onRespond={(decision) => onRespondToProposal(row.proposal.proposalId, decision)}
              />
            );
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
  const [files, setFiles] = React.useState<{ open: boolean; path: string | null }>({ open: false, path: null });
  const [retrying, setRetrying] = React.useState(false);
  const [pausedBusy, setPausedBusy] = React.useState(false);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const snapshot = live.snapshot;
  const state: BotSessionState | undefined = snapshot?.state;
  const running = state?.kind === "running";

  const connectionSetup = useConnectionSetup(() => live.reload());
  const approvals = useBotApprovals(botId);
  const [answering, setAnswering] = React.useState(false);

  const back = () => void navigate({ to: "/bots" });
  const current = bot.data ?? null;

  const shell = (body: React.ReactNode, footer?: React.ReactNode) => (
    <ScrollArea
      scrollRestorationId={`bot-chat:${botId}`}
      className="h-full min-h-0"
      alignFooterToScrollContent
      leading={<BotChatBackButton onBack={back} />}
      title={
        current ? (
          <BotChatNamePill
            bot={current}
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
          <BotChatActions
            bot={current}
            onOpenProfile={() => void navigate({ to: "/bots/$botId", params: { botId: current.id } })}
            onOpenFiles={() => setFiles({ open: true, path: null })}
            onDelete={() => setDeleteOpen(true)}
          />
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
      ]}
      showScrollToBottomButton
      footer={footer}
    >
      {body}
      {current ? (
        <>
          <BotDeleteDialog bot={current} open={deleteOpen} onOpenChange={setDeleteOpen} />
          <BotFilesDialog
            botId={current.id}
            botName={current.name}
            open={files.open}
            initialPath={files.path}
            onOpenChange={(open) => setFiles((value) => ({ ...value, open }))}
          />
        </>
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
  const openAdvanced = () =>
    void navigate({ to: "/bots/$botId", params: { botId: current.id }, search: { page: "advanced" } });
  const openProviders = () => void navigate({ to: "/settings", search: { section: "providers" } });

  if (state?.kind === "needs_model") {
    return shell(<BotNeedsModel bot={current} onSetUp={openProviders} />);
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

  const respondToProposal = async (proposalId: string, decision: BotRoutineProposalDecision) => {
    try {
      const result = await botsApi.routineProposals.respond({ botId: current.id, proposalId, decision });
      if (result.status === "accepted") void qc.invalidateQueries({ queryKey: botRoutinesKey(current.id) });
      return result.status;
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

  const openMemory = () =>
    void navigate({ to: "/bots/$botId", params: { botId: current.id }, search: { page: "memory" } });

  const dismissConnection = async (pluginId: string) => {
    try {
      await botsApi.dismissConnection(current.id, pluginId);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save that choice."));
    }
  };

  const footer = (
    <div className="flex flex-col">
      {approvals.prompts.length > 0 ? (
        <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-2">
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
  );

  return shell(
    <div className="aiden-dock-inset chat-content-column flex flex-col gap-3 py-6">
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
          onOpenMemory={openMemory}
          onRespondToProposal={respondToProposal}
        />
      </MessageAttachmentPreviewProvider>
      {state?.kind === "interrupted" ? (
        <BotInterruptedCard
          name={current.name}
          {...(state.blocked ? { blocked: state.blocked } : {})}
          busy={pausedBusy}
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
