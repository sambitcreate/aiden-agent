import * as React from "react";
import { ArrowUp, Plus, Square, X } from "lucide-react";
import { invoke } from "../lib/ipc";
import { ASSISTANT_SUGGESTED_PROMPTS } from "../shared/assistant";
import { AssistantRecent } from "./assistant-recent";
import { AssistantThread } from "./assistant-thread";
import { canSendAssistantMessage, useAssistantChat } from "./use-assistant-chat";

const DRAG = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export function AssistantApp(): React.ReactElement {
  const chat = useAssistantChat();
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

  return (
    <div className="flex h-screen flex-col text-primary">
      <header
        className="flex h-11 shrink-0 items-center justify-between border-b border-separator pl-20 pr-2"
        style={DRAG}
      >
        <span className="text-sm font-medium">Aiden</span>
        <div className="flex items-center gap-0.5" style={NO_DRAG}>
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
            aria-label="Close Aiden"
            className="rounded-md p-1 text-tertiary transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary"
            onClick={() => void invoke("assistant:hide-window")}
          >
            <X className="size-4" />
          </button>
        </div>
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
        {!chat.ready ? (
          <p className="px-1 pb-2 text-xs text-tertiary">
            Choose a provider and model in the main window before chatting here.
          </p>
        ) : null}
        <div className="flex items-end gap-1.5 rounded-2xl bg-popover p-2 outline outline-1 outline-field/80">
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
