import * as React from "react";
import { ArrowUp, Minus, Plus, Square } from "lucide-react";
import { ASSISTANT_SUGGESTED_PROMPTS } from "../../shared/assistant";
import { AssistantAutomationApproval } from "./assistant-automation-approval";
import { AssistantComputerUseApproval } from "./assistant-computer-use-approval";
import { AssistantRecent } from "./assistant-recent";
import { AssistantThread } from "./assistant-thread";
import { Button, Textarea } from "../ui";
import { AssistantLive } from "./assistant-live";
import type { AssistantLiveController } from "./use-assistant-live";
import { assistantThreadChangeBlockedReason } from "./assistant-live-ownership";
import {
  canSendAssistantMessage,
  type AssistantChat,
  type AssistantReadiness,
} from "./use-assistant-chat";

const AIDEN_MARK_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;

export function assistantMinimizeLabel(live: AssistantLiveController): string {
  if (live.active) return "Stop Live before minimizing Aiden";
  if (live.busy || live.setupOpen) return "Cancel Live setup before minimizing Aiden";
  return "Minimize Aiden";
}

// "Choose a provider" is the wrong thing to say when the provider list simply
// failed to load — the user has providers, and sending them to Settings to fix
// a problem that isn't there wastes their time.
const READINESS_TEXT: Record<Exclude<AssistantReadiness, "ready">, string> = {
  loading: "Loading your providers…",
  "conversation-loading": "Opening conversation…",
  stopping: "Stopping response…",
  rendering: "Finishing response…",
  "turn-saving": "Saving conversation…",
  "reload-required": "Message save status is unknown. Reload Aiden before sending again.",
  unavailable: "Aiden could not load your providers. Try again in a moment.",
  unset: "Choose a provider and model in the main composer before chatting here.",
};

/** The expanded Aiden surface, docked inside the main window. */
export function AssistantPanel({
  chat,
  draft,
  inputRef,
  onDraftChange,
  onMinimize,
  live,
}: {
  chat: AssistantChat;
  draft: string;
  inputRef: React.Ref<HTMLTextAreaElement>;
  onDraftChange: (draft: string) => void;
  onMinimize: () => void;
  live: AssistantLiveController;
}): React.ReactElement {
  const canSend = canSendAssistantMessage(draft, {
    streaming: chat.streaming,
    ready: chat.ready,
  });
  const minimizeBlocked = live.active || live.busy || live.setupOpen;
  const threadChangeBlockedReason = assistantThreadChangeBlockedReason(chat, live);

  const submit = () => {
    if (!canSend) return;
    chat.send(draft, onDraftChange);
    onDraftChange("");
  };

  // Interactivity is owned by the dock wrapper, which withdraws it while the
  // panel animates out.
  return (
    <div className="flex h-[min(34rem,calc(100vh-8rem))] w-[min(23rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl bg-popover shadow-composer outline outline-1 outline-field/80">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-separator pl-3 pr-2">
        <span className="flex items-center gap-2">
          <span className="block size-5 overflow-hidden rounded-full">
            <img src={AIDEN_MARK_URL} alt="" className="size-full scale-[1.32] object-cover" />
          </span>
          <span className="text-sm font-medium text-primary">Aiden</span>
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={
              threadChangeBlockedReason
                ? `New conversation unavailable: ${threadChangeBlockedReason}`
                : "New conversation"
            }
            title={threadChangeBlockedReason ?? undefined}
            disabled={!chat.canChangeThread || Boolean(threadChangeBlockedReason)}
            className="rounded-md p-1 text-tertiary transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary disabled:opacity-40"
            onClick={() => {
              if (!chat.canChangeThread || threadChangeBlockedReason) return;
              chat.newThread();
              onDraftChange("");
            }}
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            aria-label={assistantMinimizeLabel(live)}
            title={minimizeBlocked ? assistantMinimizeLabel(live) : undefined}
            disabled={minimizeBlocked}
            className="rounded-md p-1 text-tertiary transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary disabled:opacity-40"
            onClick={onMinimize}
          >
            <Minus className="size-4" />
          </button>
        </span>
      </header>

      {live.active && chat.approvals[0]?.toolName === "computer_use" ? (
        <div className="pb-2">
          <AssistantComputerUseApproval
            prompt={chat.approvals[0]}
            deciding={chat.decidingApprovalId === chat.approvals[0].approvalId}
            onDecision={(decision) => void chat.decideApproval(chat.approvals[0]!, decision)}
          />
        </div>
      ) : null}

      {live.active ? (
        <AssistantLive live={live} />
      ) : chat.messages.length === 0 ? (
        <div className="flex flex-1 flex-col justify-end gap-4 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-1">
            <p className="px-1 text-xs font-medium text-tertiary">Try asking</p>
            {ASSISTANT_SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={!chat.ready}
                className="rounded-lg px-2 py-1.5 text-left text-sm text-secondary transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary disabled:opacity-50"
                onClick={() => chat.send(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
          <AssistantRecent
            threads={chat.threads}
            disabled={!chat.canChangeThread || Boolean(threadChangeBlockedReason)}
            onOpen={(chatId) => {
              if (!chat.canChangeThread || threadChangeBlockedReason) return;
              chat.openThread(chatId);
            }}
          />
          {chat.error ? (
            <p role="alert" className="px-1 text-xs text-support-red">
              {chat.error}
            </p>
          ) : null}
        </div>
      ) : (
        <AssistantThread
          messages={chat.messages}
          streaming={chat.streaming}
          streamComplete={chat.streamComplete}
          onStreamHandoffComplete={chat.finishStreamHandoff}
          error={chat.error}
        />
      )}

      {!live.active ? <AssistantLive live={live} /> : null}

      {!live.active ? (
        <div className="shrink-0 p-2.5">
          {chat.approvals[0] ? (
            <div className="pb-2">
              <AssistantAutomationApproval
                prompt={chat.approvals[0]}
                deciding={
                  chat.readiness === "stopping" ||
                  chat.decidingApprovalId === chat.approvals[0].approvalId
                }
                onDecision={(decision) => void chat.decideApproval(chat.approvals[0]!, decision)}
              />
            </div>
          ) : null}
          {chat.readiness === "ready" ? null : (
            <p className="px-1 pb-2 text-xs text-tertiary">{READINESS_TEXT[chat.readiness]}</p>
          )}
          <div className="flex items-end gap-1.5 rounded-2xl bg-background p-2 outline outline-1 outline-field/80">
            <Textarea
              ref={inputRef}
              density="compact"
              rows={1}
              wrap="soft"
              value={draft}
              disabled={!chat.ready}
              placeholder="Ask about Aiden"
              aria-label="Message Aiden"
              className="min-w-0 max-h-32 flex-1 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-1 py-1 text-sm leading-5 outline-none hover:border-transparent focus:border-transparent focus:bg-transparent"
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {chat.streaming ? (
              <Button
                variant="filled"
                size="small"
                iconOnly
                className="rounded-full"
                aria-label={chat.readiness === "stopping" ? "Stopping" : "Stop"}
                disabled={chat.readiness === "stopping"}
                onClick={chat.stop}
              >
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button
                variant="accent"
                size="small"
                iconOnly
                className="rounded-full"
                aria-label="Send message"
                disabled={!canSend}
                onClick={submit}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
