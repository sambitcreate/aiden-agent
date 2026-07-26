import * as React from "react";
import { ArrowUp, Minus, Plus, Square } from "lucide-react";
import { ASSISTANT_SUGGESTED_PROMPTS } from "../../shared/assistant";
import { AssistantRecent } from "./assistant-recent";
import { AssistantThread } from "./assistant-thread";
import {
  canSendAssistantMessage,
  type AssistantChat,
  type AssistantReadiness,
} from "./use-assistant-chat";

const AIDEN_MARK_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;

// "Choose a provider" is the wrong thing to say when the provider list simply
// failed to load — the user has providers, and sending them to Settings to fix
// a problem that isn't there wastes their time.
const READINESS_TEXT: Record<Exclude<AssistantReadiness, "ready">, string> = {
  loading: "Loading your providers…",
  unavailable: "Aiden could not load your providers. Try again in a moment.",
  unset: "Choose a provider and model in the main composer before chatting here.",
};

/** The expanded Aiden surface, docked inside the main window. */
export function AssistantPanel({
  chat,
  onMinimize,
}: {
  chat: AssistantChat;
  onMinimize: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState("");
  const canSend = canSendAssistantMessage(draft, {
    streaming: chat.streaming,
    ready: chat.ready,
  });

  const submit = () => {
    if (!canSend) return;
    chat.send(draft);
    setDraft("");
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
            aria-label="New conversation"
            className="rounded-md p-1 text-tertiary transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary"
            onClick={chat.newThread}
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Minimize Aiden"
            className="rounded-md p-1 text-tertiary transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary"
            onClick={onMinimize}
          >
            <Minus className="size-4" />
          </button>
        </span>
      </header>

      {chat.messages.length === 0 ? (
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
          <AssistantRecent threads={chat.threads} onOpen={chat.openThread} />
        </div>
      ) : (
        <AssistantThread messages={chat.messages} streaming={chat.streaming} error={chat.error} />
      )}

      <div className="shrink-0 p-2.5">
        {chat.readiness === "ready" ? null : (
          <p className="px-1 pb-2 text-xs text-tertiary">{READINESS_TEXT[chat.readiness]}</p>
        )}
        <div className="flex items-end gap-1.5 rounded-2xl bg-background p-2 outline outline-1 outline-field/80">
          <textarea
            rows={1}
            value={draft}
            disabled={!chat.ready}
            placeholder="Ask about Aiden"
            aria-label="Message Aiden"
            className="max-h-32 flex-1 resize-none bg-transparent px-1 py-1 text-sm text-primary outline-none placeholder:text-tertiary"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {chat.streaming ? (
            <button
              type="button"
              aria-label="Stop"
              className="rounded-full bg-control p-1.5 text-primary transition-colors duration-150 ease-out hover:bg-control-hover"
              onClick={chat.stop}
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              className="rounded-full bg-accent p-1.5 text-accent-foreground transition-colors duration-150 ease-out hover:bg-accent-hover disabled:opacity-40"
              onClick={submit}
            >
              <ArrowUp className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
