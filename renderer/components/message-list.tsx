// Renders the transcript: persisted messages + the in-progress streaming reply.

import { Ban, CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { Callout, Text } from "./ui";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "../lib/types";

interface MessageListProps {
  messages: ChatMessage[];
  /** Text of the assistant reply currently streaming, or null when idle. */
  streamingText: string | null;
  /** Transient, stateful tool activity for the current generation. */
  toolActivity: ToolActivity | null;
  error: string | null;
}

export interface ToolActivity {
  state: "running" | "completed" | "failed" | "blocked";
  label: string;
}

export function MessageList({ messages, streamingText, toolActivity, error }: MessageListProps) {
  const ActivityIcon = toolActivity
    ? toolActivity.state === "running"
      ? LoaderCircle
      : toolActivity.state === "completed"
        ? CheckCircle2
        : toolActivity.state === "failed"
          ? CircleAlert
          : Ban
    : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-6 sm:px-5">
      {messages.map((m) => (
        <MessageBubble key={m.id} role={m.role} content={m.content} attachments={m.attachments} />
      ))}

      {toolActivity && ActivityIcon ? (
        <div
          role={toolActivity.state === "failed" ? "alert" : "status"}
          className="flex w-fit max-w-full items-center gap-2 rounded-pill bg-well px-2.5 py-1.5"
        >
          <ActivityIcon
            className={
              toolActivity.state === "running"
                ? "size-3.5 animate-spin text-accent"
                : toolActivity.state === "completed"
                  ? "size-3.5 text-green"
                  : toolActivity.state === "failed"
                    ? "size-3.5 text-red"
                    : "size-3.5 text-support-warning"
            }
          />
          <Text variant="small" color="secondary" className="min-w-0 break-words">
            {toolActivity.label}
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
