import * as React from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Info, Loader2, MessageCircleQuestion, MoreHorizontal, ShieldQuestion, TriangleAlert } from "lucide-react";
import { AskUserQuestionComposer } from "../components/ask-user-question-composer";
import { ChatApprovalCard, toolLabel, type ChatApprovalDecisionOptions } from "../components/chat-approval-card";
import { Composer, type ComposerSkillCatalog } from "../components/composer";
import { MessageList } from "../components/message-list";
import { RemoteHostMarker, RemoteHostStatusRow } from "../components/sidebar-remote";
import {
  AlertDialog,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  ScrollArea,
  Text,
  toast,
} from "../components/ui";
import { peerHostsApi, type ApprovalPrompt } from "../lib/ipc";
import type { ChatSessionControl, ChatSessionSnapshot } from "../lib/hosts/chat-session-control";
import { composerSurfacesFor } from "../lib/hosts/composer-surfaces";
import { hostResultValue, isOutcomeUnknown } from "../lib/hosts/host-chat-adapter";
import { remoteAttachmentUploads } from "../lib/hosts/remote-attachments";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { RemoteHostAdapter } from "../lib/hosts/remote-host-adapter";
import type { RemoteTranscript } from "../lib/hosts/remote-chat-mapper";
import { RemoteChatSession, type RemoteChatSnapshot } from "../lib/hosts/remote-chat-session";
import { remoteRunTranscript } from "../lib/hosts/remote-stream-translator";
import { useChatSession, type ChatSession } from "../lib/hosts/use-chat-session";
import { sidebarHosts, type SidebarHost } from "../lib/sidebar-remote-groups";
import type { Attachment } from "../lib/types";
import type { AskUserQuestionPromptV1, AskUserQuestionResponseV1 } from "../shared/ask-user-question";
import type { ChatRunInputMode, ChatRunInputRejectionReason } from "../shared/chat-run-input";
import { hostResourceKey, type PeerHostFeedSnapshot, type PeerHostStatus, type PeerHostView } from "../shared/peer-host";
import type { SkillInvocationV1 } from "../shared/slash-commands";

/**
 * `/host/$hostId/chat/$chatId`: a chat that lives on a paired host, read,
 * followed live and driven from this Mac. Every read and every control goes
 * through the host's adapter and the chat's session control, which bind each
 * operation to the host and chat it started on. Unsupported actions are
 * hidden or disabled with a reason and never fall back to this Mac; nothing
 * here touches this Mac's files, terminal, browser or screen, and an offline
 * host refuses every mutation instead of queueing it.
 */

const NO_SUBAGENTS: [] = [];
const noop = () => {};
const subscribeNothing = () => noop;
const nothing = () => null;

const INPUT_REJECTION: Record<ChatRunInputRejectionReason, string> = {
  run_not_active: "That run already finished. Send this as a new message.",
  cancelled: "That run was stopped before your message arrived.",
  capacity: "Too many messages are already waiting on that run.",
  invalid: "That message can't be added to the run.",
};

function availabilityLabel(host: SidebarHost): string {
  switch (host.availability) {
    case "online":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "blocked":
      return "Needs re-pairing";
    default:
      return "Offline";
  }
}

export interface RemoteComposerActions {
  send(text: string, attachments?: Attachment[], skill?: SkillInvocationV1): Promise<void>;
  submitInput(mode: ChatRunInputMode): (text: string, attachments?: Attachment[], skill?: SkillInvocationV1) => Promise<void>;
}

/**
 * The remote composer's submit callbacks. Resolving consumes the composer's
 * draft and rejecting restores it, so text is restored only when the host
 * certainly did not save it: an unknown outcome is held by the reconciliation
 * banner, and guidance the host saved after its run ended is consumed.
 */
export function remoteComposerActions(
  control: ChatSessionControl | null,
  runId: string | null,
  hostLabel: string,
): RemoteComposerActions {
  return {
    async send(text, attachments = [], skill) {
      if (!control) throw new Error(`Connecting to ${hostLabel}…`);
      // Files are read on this Mac and uploaded to the chat's host before the turn starts.
      const uploads = remoteAttachmentUploads(attachments);
      try {
        await control.send(text, { ...(uploads.length > 0 ? { attachments: uploads } : {}), ...(skill ? { skill } : {}) });
      } catch (error) {
        // The banner keeps the text and retries it with the same key; the composer clears.
        if (isOutcomeUnknown(error)) return;
        throw error;
      }
    },
    submitInput: (mode) => async (text, attachments = [], skill) => {
      if (!control) throw new Error(`Connecting to ${hostLabel}…`);
      // A running turn on the host takes text only; nothing is dropped silently.
      if (attachments.length > 0 || skill) throw new Error("Send attachments and skills as a new message after this run.");
      if (!runId) throw new Error("Wait for the run to start on that Mac.");
      try {
        const result = await control.submitInput(runId, mode, text);
        if (result.admitted) return;
        if (result.committed) {
          // The host saved it to the chat; restoring it would invite a duplicate send.
          toast.info("The run ended first, so your message was saved to the conversation.");
          return;
        }
        throw new Error(INPUT_REJECTION[result.reason ?? "invalid"]);
      } catch (error) {
        if (isOutcomeUnknown(error)) return;
        throw error;
      }
    },
  };
}

/** Toasts a control failure, unless the reconciliation banner already explains it. */
function reportControlError(control: ChatSessionControl, error: unknown, fallback: string): void {
  if (isOutcomeUnknown(error) && control.getSnapshot().unresolved) return;
  toast.error(error instanceof Error ? error.message : fallback);
}

function ReadOnlyApprovalCard({ prompt, hostLabel }: { prompt: ApprovalPrompt; hostLabel: string }) {
  const titleId = `remote-approval-title-${prompt.approvalId}`;
  return (
    <section
      aria-labelledby={titleId}
      data-remote-approval={prompt.approvalId}
      className="rounded-card bg-popover p-3 shadow-popover"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-status-warning-surface text-status-warning">
          <ShieldQuestion className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small-strong" as="p" id={titleId}>
            {`${toolLabel(prompt.toolName)} needs approval`}
          </Text>
          <Text variant="small" color="secondary" as="p" className="mt-0.5 break-words">
            {prompt.summary}
          </Text>
          <Text variant="small" color="tertiary" as="p" className="mt-1.5">
            {`Approve or deny it on ${hostLabel}.`}
          </Text>
        </div>
      </div>
    </section>
  );
}

function ReadOnlyQuestionCard({ prompt, reason }: { prompt: AskUserQuestionPromptV1; reason: string }) {
  const titleId = `remote-question-title-${prompt.promptId}`;
  return (
    <section
      aria-labelledby={titleId}
      data-remote-question={prompt.promptId}
      className="rounded-card bg-popover p-3 shadow-popover"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-status-warning-surface text-status-warning">
          <MessageCircleQuestion className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <Text variant="small-strong" as="p" id={titleId}>
            Aiden is asking a question
          </Text>
          {prompt.questions.map((question, index) => (
            <Text key={index} variant="small" color="secondary" as="p" className="mt-0.5 break-words">
              {question.question}
            </Text>
          ))}
          <Text variant="small" color="tertiary" as="p" className="mt-1.5">
            {reason}
          </Text>
        </div>
      </div>
    </section>
  );
}

/** A soft notice row above the composer: an icon, one message and its actions. */
function ControlNotice({
  tone,
  children,
  actions,
  ...rest
}: {
  tone: "info" | "warning";
  children: React.ReactNode;
  actions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      {...rest}
      className={
        tone === "warning"
          ? "flex items-start gap-2.5 rounded-card bg-status-warning-surface p-3"
          : "flex items-start gap-2.5 rounded-card bg-popover p-3 shadow-popover"
      }
    >
      <Icon
        className={tone === "warning" ? "mt-0.5 size-4 shrink-0 text-status-warning" : "mt-0.5 size-4 shrink-0 text-secondary"}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export interface RemoteChatPaneProps {
  title: string;
  host: SidebarHost;
  /** `null` until the session for this chat exists. */
  snapshot: RemoteChatSnapshot | null;
  /** Control for this chat on its host; `null` until the host's adapter exists. */
  chat: ChatSession | null;
  onLoadOlder(): void;
  onReconnect(hostId: string): Promise<void>;
  onManage(): void;
  /** The host deleted this chat; leave its view. */
  onRemoved(): void;
  /** The skills this chat's host offers after `$`; absent when it grants none. */
  hostSkills?: ComposerSkillCatalog;
}

/** The remote chat's presentation; all state arrives in `snapshot` and `chat`. */
export function RemoteChatPane({
  title,
  host,
  snapshot,
  chat,
  onLoadOlder,
  onReconnect,
  onManage,
  onRemoved,
  hostSkills,
}: RemoteChatPaneProps) {
  const messages = snapshot?.transcript.messages ?? [];
  const run = snapshot?.run;
  const row = snapshot ? remoteRunTranscript(snapshot.run, messages) : null;
  const stale = host.availability !== "online";
  const unavailable = host.availability === "offline" || host.availability === "blocked";
  const loading = !snapshot || (!snapshot.loaded && snapshot.error === null);
  const live = Boolean(run && !run.ended);
  const approvals = live && run ? run.approvals : [];
  const questions = live && run ? run.questions : [];
  const runId = live ? (run?.runId ?? null) : null;

  const control = chat?.control ?? null;
  const state: ChatSessionSnapshot | null = chat?.snapshot ?? null;
  const capabilities = control?.adapter.capabilities();
  // Until the session control exists every action waits for the host.
  const refusal = (capability: Parameters<ChatSessionControl["refusal"]>[0]): string | null =>
    control ? control.refusal(capability) : `Connecting to ${host.label}…`;
  const sendRefusal = refusal("send");
  const cancelRefusal = refusal("cancel");
  const steerRefusal = refusal("steer");
  const questionRefusal = refusal("answerQuestion");
  const renameRefusal = refusal("rename");
  const removeRefusal = refusal("remove");
  const unresolved = state?.unresolved ?? null;
  const elsewhere = state?.elsewhere ?? null;
  const revision = snapshot?.transcript.revision ?? undefined;

  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [removeBusy, setRemoveBusy] = React.useState(false);

  const decide = (prompt: ApprovalPrompt, decision: "allow" | "deny", options?: ChatApprovalDecisionOptions) => {
    if (!control || !runId) return;
    void control
      .respondApproval({
        runId,
        approvalId: prompt.approvalId,
        decision,
        ...(options?.scope ? { scope: options.scope } : {}),
        ...(options?.formFillExcludedOrders?.length ? { formFillExcludedOrders: options.formFillExcludedOrders } : {}),
      })
      .catch((error: unknown) => reportControlError(control, error, "Aiden could not send that decision."));
  };

  const answer = async (prompt: AskUserQuestionPromptV1, response: AskUserQuestionResponseV1) => {
    if (!control || !runId) return;
    try {
      await control.answerQuestion({ runId, promptId: prompt.promptId, response });
    } catch (error) {
      reportControlError(control, error, "Aiden could not send that answer.");
    }
  };

  const { send, submitInput } = remoteComposerActions(control, runId, host.label);

  const stop = () => {
    if (!control || !runId) return;
    void control.cancel(runId).catch((error: unknown) => reportControlError(control, error, "Aiden could not stop that run."));
  };

  const retry = () => {
    if (!control) return;
    void control.retryUnresolved().catch((error: unknown) => {
      if (!isOutcomeUnknown(error)) toast.error(error instanceof Error ? error.message : "The retry failed.");
    });
  };

  const commitRename = async () => {
    const next = renameValue.trim();
    if (!control || !next) return;
    setRenameBusy(true);
    try {
      await control.rename(next, revision);
      setRenaming(false);
    } catch (error) {
      reportControlError(control, error, "Aiden could not rename that chat.");
    } finally {
      setRenameBusy(false);
    }
  };

  const commitRemove = async () => {
    if (!control) return;
    setRemoveBusy(true);
    try {
      await control.remove(revision);
      setRemoving(false);
      onRemoved();
    } catch (error) {
      reportControlError(control, error, "Aiden could not delete that chat.");
    } finally {
      setRemoveBusy(false);
    }
  };

  const canSend = Boolean(capabilities?.has("send"));
  const questionAnswerable = Boolean(capabilities?.has("answerQuestion"));
  const openQuestion = questionAnswerable && questionRefusal === null && runId ? questions[0] : undefined;
  const isGenerating = live && run?.status === "running";
  const showChatMenu = Boolean(capabilities?.has("rename") || capabilities?.has("remove"));
  const composerKey = snapshot ? hostResourceKey({ hostId: snapshot.hostId, resourceId: snapshot.chatId }) : null;

  return (
    <>
      <ScrollArea
        className="h-full min-h-0"
        alignFooterToScrollContent
        title={
          <span className="flex min-w-0 items-center gap-2">
            <RemoteHostMarker hostLabel={host.label} stale={stale} />
            <span className="min-w-0">
              <span className="block truncate">{title}</span>
              <span
                className="block truncate text-small font-normal text-secondary"
                data-remote-host-availability={host.availability}
              >
                {`${host.label} · ${availabilityLabel(host)}`}
              </span>
            </span>
          </span>
        }
        actions={
          showChatMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button iconOnly variant="toolbar" size="large" aria-label="Chat actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {capabilities?.has("rename") ? (
                  <DropdownMenuItem
                    disabled={renameRefusal !== null}
                    onSelect={() => {
                      setRenameValue(title);
                      setRenaming(true);
                    }}
                  >
                    Rename…
                  </DropdownMenuItem>
                ) : null}
                {capabilities?.has("remove") ? (
                  <DropdownMenuItem disabled={removeRefusal !== null} onSelect={() => setRemoving(true)}>
                    Delete…
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
        autoScrollToBottom
        autoScrollResetKey={snapshot ? `${snapshot.hostId}/${snapshot.chatId}` : null}
        autoScrollDeps={[
          messages.length,
          row?.streamingText,
          row?.streamingReasoning,
          row?.timeline,
          row?.agentActivity?.phase,
          approvals.length,
          questions.length,
        ]}
        showScrollToBottomButton
        footer={
          <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-3">
            {approvals.map((prompt) =>
              capabilities?.has("respondApproval") ? (
                <ChatApprovalCard
                  key={prompt.approvalId}
                  pending={prompt}
                  deciding={state?.decidingApprovalId === prompt.approvalId}
                  onDecide={(decision, options) => decide(prompt, decision, options)}
                  disabledReason={
                    refusal("respondApproval") ?? (runId ? undefined : "Waiting for the run on that Mac.")
                  }
                />
              ) : (
                <ReadOnlyApprovalCard key={prompt.approvalId} prompt={prompt} hostLabel={host.label} />
              ),
            )}
            {questions
              .filter((prompt) => prompt !== openQuestion)
              .map((prompt) => (
                <ReadOnlyQuestionCard
                  key={prompt.promptId}
                  prompt={prompt}
                  reason={questionAnswerable ? (questionRefusal ?? "Answer the question above first.") : `Answer it on ${host.label}.`}
                />
              ))}
            {elsewhere ? (
              <ControlNotice
                tone="info"
                role="status"
                data-remote-elsewhere={elsewhere.kind}
                actions={
                  <Button variant="muted" size="small" onClick={() => control?.dismissElsewhere()}>
                    Dismiss
                  </Button>
                }
              >
                <Text variant="small-strong" as="p">
                  Already answered elsewhere
                </Text>
                <Text variant="small" color="secondary" as="p" className="mt-0.5">
                  {elsewhere.kind === "approval"
                    ? elsewhere.decision
                      ? `Another device ${elsewhere.decision === "allow" ? "allowed" : "denied"} it first. Your decision was not applied.`
                      : "Another device answered it first. Your decision was not applied."
                    : "Another device answered this question first. Your answer was not applied."}
                </Text>
              </ControlNotice>
            ) : null}
            {unresolved ? (
              <ControlNotice
                tone="warning"
                role="alert"
                data-remote-unresolved={unresolved.kind}
                actions={
                  <>
                    <Button
                      variant="muted"
                      size="small"
                      disabled={unresolved.retrying}
                      onClick={() => control?.dismissUnresolved()}
                    >
                      Dismiss
                    </Button>
                    <Button
                      variant="accent"
                      size="small"
                      disabled={unresolved.retrying || refusal(unresolved.kind === "submitInput" ? "steer" : unresolved.kind) !== null}
                      onClick={retry}
                    >
                      {unresolved.retrying ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                      Retry
                    </Button>
                  </>
                }
              >
                <Text variant="small-strong" as="p">
                  {unresolved.message}
                </Text>
                {unresolved.text ? (
                  <Text variant="small" color="secondary" as="p" className="mt-0.5 line-clamp-3 break-words">
                    {unresolved.text}
                  </Text>
                ) : null}
                <Text variant="small" color="tertiary" as="p" className="mt-1">
                  Retry checks with that Mac and never applies it twice.
                </Text>
              </ControlNotice>
            ) : null}
            {unavailable ? (
              <>
                <RemoteHostStatusRow host={host} onReconnect={onReconnect} onManage={onManage} />
                <Text variant="small" color="secondary" as="p" className="px-1" data-remote-chat-stale="true">
                  {`Showing the last-known transcript. It updates when ${host.label} is back.`}
                </Text>
              </>
            ) : null}
            {openQuestion && control ? (
              <AskUserQuestionComposer
                key={openQuestion.promptId}
                prompt={openQuestion}
                submitting={state?.answeringQuestionId === openQuestion.promptId}
                onRespond={(response) => answer(openQuestion, response)}
              />
            ) : canSend && composerKey ? (
              <Composer
                // Keyed by host and chat, so drafts never cross hosts.
                key={composerKey}
                chatId={composerKey}
                surfaces={composerSurfacesFor(capabilities ?? new Set())}
                ready={sendRefusal === null && !unresolved}
                readinessMessage={
                  sendRefusal ?? (unresolved ? "Retry or dismiss the message above before sending another." : undefined)
                }
                hasMessages={messages.length > 0}
                onSend={send}
                hostSkills={capabilities?.has("skills") ? hostSkills : undefined}
                onQueue={steerRefusal === null ? submitInput("queue") : undefined}
                onSteer={steerRefusal === null ? submitInput("steer") : undefined}
                onStop={stop}
                isGenerating={isGenerating || Boolean(state?.sending)}
                canStopGeneration={isGenerating && Boolean(runId) && cancelRefusal === null && !state?.stopping}
                stoppingGeneration={Boolean(state?.stopping)}
              />
            ) : control ? (
              <Text variant="small" color="secondary" as="p" className="px-1 text-center" data-remote-send-unsupported="true">
                {`This chat runs on ${host.label}. ${sendRefusal ?? ""}`.trim()}
              </Text>
            ) : null}
          </div>
        }
      >
        {loading ? (
          <div className="flex min-h-full items-center justify-center" aria-label="Loading conversation">
            <Text variant="small" color="secondary">
              Loading…
            </Text>
          </div>
        ) : !snapshot.loaded ? (
          <div className="flex min-h-full items-center justify-center">
            <EmptyState title="This chat could not be opened" description={snapshot.error ?? undefined} />
          </div>
        ) : messages.length === 0 && row?.streamingText === null && !row.agentActivity ? (
          <div className="flex min-h-full items-center justify-center">
            <EmptyState title="No messages yet" />
          </div>
        ) : (
          <>
            {snapshot.transcript.hasOlder ? (
              <div className="chat-content-column flex justify-center pt-3">
                <Button
                  variant="muted"
                  size="small"
                  disabled={snapshot.loadingOlder || stale}
                  onClick={onLoadOlder}
                  data-remote-load-older="true"
                >
                  {snapshot.loadingOlder ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                  Load older messages
                </Button>
              </div>
            ) : null}
            <MessageList
              chatId={snapshot.chatId}
              messages={messages}
              streamingText={row!.streamingText}
              streamingReasoning={row!.streamingReasoning}
              streamComplete={row!.streamComplete}
              persistedHandoffMessageId={row!.persistedHandoffMessageId}
              timeline={row!.timeline}
              liveSubagents={NO_SUBAGENTS}
              subagentsEnabled={false}
              onOpenSubagent={noop}
              agentActivity={row!.agentActivity}
              error={row!.error ?? snapshot.error}
            />
          </>
        )}
      </ScrollArea>

      <Dialog
        open={renaming}
        onOpenChange={(open) => !open && setRenaming(false)}
        title="Rename chat"
        description={`The new name is saved on ${host.label}.`}
        confirmLabel="Save"
        confirmDisabled={!renameValue.trim() || renameRefusal !== null}
        busy={renameBusy}
        onConfirm={commitRename}
      >
        <Input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          placeholder="Chat name"
          aria-label="Chat name"
          autoFocus
        />
      </Dialog>

      <AlertDialog
        open={removing}
        onOpenChange={(open) => !open && setRemoving(false)}
        title="Delete this chat?"
        description={
          <Text variant="small" color="secondary">
            {`“${title}” and its messages will be permanently removed from ${host.label}.`}
          </Text>
        }
        confirmLabel={removeBusy ? "Deleting…" : "Delete"}
        confirmVariant="destructive"
        busy={removeBusy}
        keepOpenOnConfirm
        onConfirm={commitRemove}
      />
    </>
  );
}

interface RemoteChatBinding {
  session: RemoteChatSession;
  adapter: RemoteHostAdapter;
}

/**
 * Owns the adapter and session for one open chat. Both are rebuilt when the
 * host, its grants or the chat change, and disposed with the view, so a late
 * answer for a previous selection can never reach this one.
 */
function useRemoteChatSession(host: PeerHostView | undefined, chatId: string): RemoteChatBinding | null {
  const qc = useQueryClient();
  const [binding, setBinding] = React.useState<RemoteChatBinding | null>(null);
  const hostId = host?.id;
  const grants = host ? `${host.features.join(",")}|${host.capabilities.join(",")}` : "";
  const hostRef = React.useRef(host);
  hostRef.current = host;

  React.useEffect(() => {
    const view = hostRef.current;
    if (!view || view.id !== hostId) return;
    const key = hostQueryKeys.messagesWindow(view.id, chatId);
    const adapter = new RemoteHostAdapter(view);
    const session = new RemoteChatSession({
      adapter,
      chatId,
      cache: {
        read: () => qc.getQueryData<RemoteTranscript>(key),
        write: (transcript) => qc.setQueryData(key, transcript),
      },
    });
    const next = { session, adapter };
    setBinding(next);
    session.start();
    return () => {
      session.dispose();
      adapter.dispose();
      setBinding((current) => (current === next ? null : current));
    };
  }, [qc, hostId, grants, chatId]);

  return binding;
}

type RemoteChatFrameProps = Omit<RemoteChatPaneProps, "chat">;

/**
 * The skills a remote chat may invoke, read from its host. This Mac's own
 * skill catalog is never read for a remote chat.
 */
export function useHostSkills(adapter: RemoteHostAdapter, chatId: string): ComposerSkillCatalog | undefined {
  const granted = adapter.capabilities().has("skills");
  const query = useQuery({
    queryKey: hostQueryKeys.skills(adapter.hostId, chatId),
    queryFn: async () => hostResultValue(await adapter.skills(chatId)),
    enabled: granted,
    staleTime: 30_000,
  });
  if (!granted) return undefined;
  return {
    // A skill picked for one chat is never sent with another host's or chat's turn.
    scopeId: hostResourceKey({ hostId: adapter.hostId, resourceId: chatId }),
    data: query.data,
    isError: query.isError,
    isFetching: query.isFetching,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

/** Binds the pane's session control to this host's adapter and this chat. */
function ControlledRemoteChatPane({
  adapter,
  chatId,
  ...props
}: RemoteChatFrameProps & { adapter: RemoteHostAdapter; chatId: string }) {
  const chat = useChatSession(adapter, { hostId: adapter.hostId, chatId });
  const hostSkills = useHostSkills(adapter, chatId);
  return <RemoteChatPane {...props} chat={chat} {...(hostSkills ? { hostSkills } : {})} />;
}

export function RemoteChatView({ hostId, chatId }: { hostId: string; chatId: string }) {
  const navigate = useNavigate();
  const manage = React.useCallback(() => {
    void navigate({ to: "/settings", search: { section: "remoteAccess" } });
  }, [navigate]);
  const removed = React.useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);
  return <RemoteChatRoute hostId={hostId} chatId={chatId} onManage={manage} onRemoved={removed} />;
}

export interface RemoteChatRouteProps {
  hostId: string;
  chatId: string;
  /** Opens Settings → Remote Access. */
  onManage(): void;
  /** Leaves the route after the open chat was deleted. */
  onRemoved(): void;
}

/** The remote chat route, fed by the host queries the sidebar keeps current. */
export function RemoteChatRoute({ hostId, chatId, onManage, onRemoved }: RemoteChatRouteProps) {
  const list = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const statuses = useQuery<PeerHostStatus[]>({ queryKey: hostQueryKeys.statuses(), queryFn: skipToken });
  const feed = useQuery<PeerHostFeedSnapshot | null>({ queryKey: hostQueryKeys.feed(hostId), queryFn: skipToken });
  const view = list.data?.find((entry) => entry.id === hostId && entry.enabled);
  const binding = useRemoteChatSession(view, chatId);
  const session = binding?.session ?? null;
  const snapshot = React.useSyncExternalStore(
    session?.subscribe ?? subscribeNothing,
    session?.getSnapshot ?? nothing,
    session?.getSnapshot ?? nothing,
  );

  const reconnect = React.useCallback(async (id: string) => {
    try {
      await peerHostsApi.reconnect(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not reconnect to that Mac.");
    }
  }, []);
  const loadOlder = React.useCallback(() => {
    void session?.loadOlder();
  }, [session]);

  // A direct open or refresh mounts before the sidebar has read the paired hosts.
  if (list.isPending) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center" aria-label="Loading conversation">
        <Text variant="small" color="secondary">
          Loading…
        </Text>
      </div>
    );
  }
  if (!list.data) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <EmptyState
          title="Paired Macs could not be read"
          description={list.error instanceof Error ? list.error.message : "Try again in a moment."}
        />
      </div>
    );
  }
  // Until the host reports a status it reads as connecting, not as missing.
  const listed = sidebarHosts(list.data, statuses.data ?? []).find((entry) => entry.id === hostId);
  if (!view || !listed) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <EmptyState
          title="This Mac is not connected"
          description="Pair it again or turn it back on in Settings → Remote Access to open its chats."
        />
      </div>
    );
  }
  // The session's status is fenced by generation; the sidebar's stands in until it knows one.
  const host: SidebarHost =
    snapshot && snapshot.status.generation >= 0
      ? { id: listed.id, label: listed.label, ...availabilityOf(snapshot) }
      : listed;
  const summary = feed.data?.summaries.find((row) => row.id === chatId);
  const title = typeof summary?.title === "string" && summary.title.trim() ? summary.title : "Remote chat";
  const frame: RemoteChatFrameProps = {
    title,
    host,
    snapshot,
    onLoadOlder: loadOlder,
    onReconnect: reconnect,
    onManage,
    onRemoved,
  };

  return binding ? (
    <ControlledRemoteChatPane {...frame} adapter={binding.adapter} chatId={chatId} />
  ) : (
    <RemoteChatPane {...frame} chat={null} />
  );
}

function availabilityOf(snapshot: RemoteChatSnapshot): Pick<SidebarHost, "availability" | "blockedReason"> {
  const { availability, blockedReason } = snapshot.status;
  return blockedReason ? { availability, blockedReason } : { availability };
}
