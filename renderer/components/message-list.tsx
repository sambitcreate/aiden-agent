// Renders the transcript: persisted messages + the in-progress streaming reply.

import { Callout, Text } from "./ui";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "../lib/types";

interface MessageListProps {
  messages: ChatMessage[];
  /** Text of the assistant reply currently streaming, or null when idle. */
  streamingText: string | null;
  /** Transient tool-activity label (e.g. "Using web_search…"), or null. */
  toolStatus: string | null;
  error: string | null;
}

export function MessageList({ messages, streamingText, toolStatus, error }: MessageListProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-6 sm:px-5">
      {messages.map((m) => (
        <MessageBubble key={m.id} role={m.role} content={m.content} attachments={m.attachments} />
      ))}

      {toolStatus ? (
        <div className="flex items-center gap-2">
          <span className="size-1.5 animate-pulse rounded-full bg-accent" />
          <Text variant="small" color="secondary">
            {toolStatus}
          </Text>
        </div>
      ) : null}

      {streamingText !== null ? (
        <MessageBubble role="assistant" content={streamingText} streaming />
      ) : null}

      {error ? (
        <Callout color="red">
          <Text variant="small-strong" color="red">
            Generation failed
          </Text>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            {error}
          </Text>
        </Callout>
      ) : null}
    </div>
  );
}
