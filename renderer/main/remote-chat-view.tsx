import * as React from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { MessageList } from "../components/message-list";
import { RemoteHostMarker, RemoteHostStatusRow } from "../components/sidebar-remote";
import { Button, EmptyState, ScrollArea, Text, toast } from "../components/ui";
import { peerHostsApi, type ApprovalPrompt } from "../lib/ipc";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { RemoteHostAdapter } from "../lib/hosts/remote-host-adapter";
import type { RemoteTranscript } from "../lib/hosts/remote-chat-mapper";
import { RemoteChatSession, type RemoteChatSnapshot } from "../lib/hosts/remote-chat-session";
import { remoteRunTranscript } from "../lib/hosts/remote-stream-translator";
import { sidebarHosts, type SidebarHost } from "../lib/sidebar-remote-groups";
import type { AskUserQuestionPromptV1 } from "../shared/ask-user-question";
import type { PeerHostFeedSnapshot, PeerHostStatus, PeerHostView } from "../shared/peer-host";

/**
 * `/host/$hostId/chat/$chatId`: a chat that lives on a paired host, read and
 * followed live from this Mac. Viewing only: there is no composer, prompts
 * are shown without controls, and nothing here touches this Mac's files,
 * terminal, browser or screen. Every read goes through the host adapter.
 */

const NO_SUBAGENTS: [] = [];
const noop = () => {};
const subscribeNothing = () => noop;
const nothing = () => null;

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

function toolLabel(toolName: string): string {
  return toolName.replace(/_/g, " ");
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

function ReadOnlyQuestionCard({ prompt, hostLabel }: { prompt: AskUserQuestionPromptV1; hostLabel: string }) {
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
            {`Answer it on ${hostLabel}.`}
          </Text>
        </div>
      </div>
    </section>
  );
}

export interface RemoteChatPaneProps {
  title: string;
  host: SidebarHost;
  /** `null` until the session for this chat exists. */
  snapshot: RemoteChatSnapshot | null;
  onLoadOlder(): void;
  onReconnect(hostId: string): Promise<void>;
  onManage(): void;
}

/** The remote chat's presentation; all state arrives in `snapshot`. */
export function RemoteChatPane({ title, host, snapshot, onLoadOlder, onReconnect, onManage }: RemoteChatPaneProps) {
  const messages = snapshot?.transcript.messages ?? [];
  const run = snapshot?.run;
  const row = snapshot ? remoteRunTranscript(snapshot.run, messages) : null;
  const stale = host.availability !== "online";
  const unavailable = host.availability === "offline" || host.availability === "blocked";
  const loading = !snapshot || (!snapshot.loaded && snapshot.error === null);
  const approvals = run && !run.ended ? run.approvals : [];
  const questions = run && !run.ended ? run.questions : [];

  return (
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
          {approvals.map((prompt) => (
            <ReadOnlyApprovalCard key={prompt.approvalId} prompt={prompt} hostLabel={host.label} />
          ))}
          {questions.map((prompt) => (
            <ReadOnlyQuestionCard key={prompt.promptId} prompt={prompt} hostLabel={host.label} />
          ))}
          {unavailable ? (
            <>
              <RemoteHostStatusRow host={host} onReconnect={onReconnect} onManage={onManage} />
              <Text variant="small" color="secondary" as="p" className="px-1" data-remote-chat-stale="true">
                {`Showing the last-known transcript. It updates when ${host.label} is back.`}
              </Text>
            </>
          ) : (
            <Text variant="small" color="secondary" as="p" className="px-1 text-center">
              {`This chat runs on ${host.label}. Sending from this Mac arrives in a later update.`}
            </Text>
          )}
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
  );
}

/**
 * Owns the adapter and session for one open chat. Both are rebuilt when the
 * host, its grants or the chat change, and disposed with the view, so a late
 * answer for a previous selection can never reach this one.
 */
function useRemoteChatSession(host: PeerHostView | undefined, chatId: string): RemoteChatSession | null {
  const qc = useQueryClient();
  const [session, setSession] = React.useState<RemoteChatSession | null>(null);
  const hostId = host?.id;
  const grants = host ? `${host.features.join(",")}|${host.capabilities.join(",")}` : "";
  const hostRef = React.useRef(host);
  hostRef.current = host;

  React.useEffect(() => {
    const view = hostRef.current;
    if (!view || view.id !== hostId) return;
    const key = hostQueryKeys.messagesWindow(view.id, chatId);
    const adapter = new RemoteHostAdapter(view);
    const next = new RemoteChatSession({
      adapter,
      chatId,
      cache: {
        read: () => qc.getQueryData<RemoteTranscript>(key),
        write: (transcript) => qc.setQueryData(key, transcript),
      },
    });
    setSession(next);
    next.start();
    return () => {
      next.dispose();
      adapter.dispose();
      setSession((current) => (current === next ? null : current));
    };
  }, [qc, hostId, grants, chatId]);

  return session;
}

export function RemoteChatView({ hostId, chatId }: { hostId: string; chatId: string }) {
  const navigate = useNavigate();
  const manage = React.useCallback(() => {
    void navigate({ to: "/settings", search: { section: "remoteAccess" } });
  }, [navigate]);
  return <RemoteChatRoute hostId={hostId} chatId={chatId} onManage={manage} />;
}

export interface RemoteChatRouteProps {
  hostId: string;
  chatId: string;
  /** Opens Settings → Remote Access. */
  onManage(): void;
}

/** The remote chat route, fed by the host queries the sidebar keeps current. */
export function RemoteChatRoute({ hostId, chatId, onManage }: RemoteChatRouteProps) {
  const list = useQuery<PeerHostView[]>({ queryKey: hostQueryKeys.list(), queryFn: skipToken });
  const statuses = useQuery<PeerHostStatus[]>({ queryKey: hostQueryKeys.statuses(), queryFn: skipToken });
  const feed = useQuery<PeerHostFeedSnapshot | null>({ queryKey: hostQueryKeys.feed(hostId), queryFn: skipToken });
  const view = list.data?.find((entry) => entry.id === hostId && entry.enabled);
  const session = useRemoteChatSession(view, chatId);
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

  return (
    <RemoteChatPane
      title={title}
      host={host}
      snapshot={snapshot}
      onLoadOlder={loadOlder}
      onReconnect={reconnect}
      onManage={onManage}
    />
  );
}

function availabilityOf(snapshot: RemoteChatSnapshot): Pick<SidebarHost, "availability" | "blockedReason"> {
  const { availability, blockedReason } = snapshot.status;
  return blockedReason ? { availability, blockedReason } : { availability };
}
