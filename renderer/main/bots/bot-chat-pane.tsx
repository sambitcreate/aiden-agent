// A Bot's one conversation, rendered from the durable projection (`useBotLive`).
// Sends go through `bots:send` with a fresh request UUID per message, so a retried
// send never doubles. Stop, Resume and Dismiss map to their runtime actions.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Composer } from "../../components/composer";
import { ConnectCard } from "../../components/bots/connect-card";
import { SafeMessageBubble } from "../../components/message-bubble";
import { Button, EmptyState, Text, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { Attachment } from "../../lib/types";
import { useBot } from "../../lib/queries";
import { useBotLive } from "../../lib/use-bot-live";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import type { BotApprovalPrompt } from "../../../main/services/bot-runtime/bot-approvals";
import { BotChatActions, BotChatTitle } from "./bot-chat-header";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bot-chat-mode";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotNeedsModel } from "./bot-needs-model";
import { resolveBotReplyProjection } from "./bot-reply-projection";
import type { BotSessionState } from "./bot-session-state";
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
  return { prompts, remove };
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
        {`${name} wants to use ${prompt.toolName}.`}
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

function attachmentText(attachments: readonly Attachment[]): string {
  return attachments
    .filter((attachment) => attachment.kind === "text" && attachment.text)
    .map((attachment) => `\n\n${attachment.name}:\n${attachment.text}`)
    .join("");
}

/** Chat transcript rows: user and routine bubbles, Updates folds, replies, connect cards. */
function TranscriptEntries({
  entries,
  partial,
  running,
  onConnect,
  onDismissConnection,
}: {
  entries: readonly BotTranscriptEntry[];
  partial: string | null;
  running: boolean;
  onConnect(pluginId: string): void;
  onDismissConnection(pluginId: string): void;
}) {
  const rows: React.ReactNode[] = [];
  entries.forEach((entry, index) => {
    switch (entry.type) {
      case "user":
        rows.push(
          <SafeMessageBubble key={entry.id} role="user" content={entry.text} showCopy={false} />,
        );
        break;
      case "routine":
        rows.push(
          <Text key={entry.id} as="p" variant="small" color="secondary" data-bot-routine-label>
            {entry.label}
          </Text>,
        );
        rows.push(
          <SafeMessageBubble key={`${entry.id}:text`} role="user" content={entry.text} showCopy={false} />,
        );
        break;
      case "assistant": {
        const last = index === entries.length - 1;
        if (entry.toolCalls.length > 0) {
          // Text written before a tool call is progress, folded under Updates.
          rows.push(
            <BotUpdates
              key={`${entry.id}:updates`}
              progressText={entry.text}
              timeline={null}
              active={false}
            />,
          );
        } else if (entry.text.trim()) {
          rows.push(
            <SafeMessageBubble
              key={entry.id}
              role="assistant"
              content={entry.text}
              showCopy
              {...(entry.errorMessage
                ? { footer: <Text variant="small" color="secondary">{entry.errorMessage}</Text> }
                : {})}
            />,
          );
        }
        if (last && running && partial === null) {
          rows.push(<BotUpdates key="working" progressText="" timeline={null} active />);
        }
        break;
      }
      case "notice":
        rows.push(
          <Text key={entry.id} as="p" variant="small" color="secondary" role="note">
            {entry.notice === "session_reset" ? "This conversation was reset." : BOT_INTERRUPTED_TEXT}
          </Text>,
        );
        break;
      case "connect_card":
        rows.push(
          <ConnectCard
            key={entry.id}
            card={entry.card}
            onConnect={onConnect}
            onDismiss={onDismissConnection}
          />,
        );
        break;
      case "tool_result":
        break;
    }
  });
  if (partial !== null) {
    const { progressText, finalText } = resolveBotReplyProjection(partial, null, true);
    if (progressText) rows.push(<BotUpdates key="partial-updates" progressText={progressText} timeline={null} active />);
    if (finalText) rows.push(<SafeMessageBubble key="partial" role="assistant" content={finalText} streaming streamComplete={false} />);
  }
  return <>{rows}</>;
}

export function BotChatPane({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const bot = useBot(botId);
  const live = useBotLive(botId);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [pausedBusy, setPausedBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const snapshot = live.snapshot;
  const state: BotSessionState | undefined = snapshot?.state;
  const running = state?.kind === "running";

  const connectionSetup = useConnectionSetup(() => live.reload());
  const approvals = useBotApprovals(botId);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [snapshot?.entries.length, snapshot?.partial]);

  if (bot.isLoading || snapshot === null) {
    return <Text color="secondary">Loading…</Text>;
  }
  if (!bot.data) {
    return <EmptyState title="Bot not found" description="This Bot may have been deleted." />;
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
          onDelete={() => setDeleteOpen(true)}
        />
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <TranscriptEntries
            entries={snapshot.entries}
            partial={snapshot.partial}
            running={running}
            onConnect={(pluginId) => {
              if (!connectionSetup.open(pluginId)) toast.error("This connection can't be set up from here.");
            }}
            onDismissConnection={(pluginId) => void dismissConnection(pluginId)}
          />
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
        <Composer
          key={`bot:${current.id}`}
          ready={!state || state.kind !== "unavailable"}
          readinessMessage={state?.kind === "unavailable" ? state.reason : undefined}
          hasMessages={snapshot.entries.length > 0}
          chatId={`bot:${current.id}`}
          placeholder={`Ask ${current.name}`}
          onSend={(text, attachments) => send(text, attachments)}
          onQueue={(text, attachments) => send(text, attachments, "followUp")}
          onSteer={(text, attachments) => send(text, attachments, "steer")}
          onStop={() => {
            void botsApi.stop(current.id).catch((error) => {
              toast.error(userFacingErrorMessage(error, `Aiden couldn’t stop ${current.name}.`));
            });
          }}
          isGenerating={running}
          canStopGeneration={running}
          inputRef={composerRef}
          surfaces={BOT_CHAT_COMPOSER_SURFACES}
        />
      </div>
      <BotDeleteDialog bot={current} open={deleteOpen} onOpenChange={setDeleteOpen} />
      {connectionSetup.dialog}
    </div>
  );
}
