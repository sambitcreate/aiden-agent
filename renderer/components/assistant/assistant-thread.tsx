import * as React from "react";
import { SafeMessageBubble } from "../message-bubble";
import type { AssistantMessage } from "./use-assistant-chat";

/** The Aiden transcript, rendered through the same message path as the main chat. */
export function AssistantThread({
  messages,
  streaming,
  streamComplete,
  onStreamHandoffComplete,
  error,
}: {
  messages: AssistantMessage[];
  streaming: boolean;
  streamComplete: boolean;
  onStreamHandoffComplete: () => void;
  error: string | null;
}): React.ReactElement {
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, streamComplete, streaming]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={streaming || streamComplete}
        className="flex flex-col gap-5"
      >
        {messages.map((message, index) => {
          const speaker = message.role === "user" ? "You" : "Aiden";
          const isStreamingReply =
            (streaming || streamComplete) &&
            message.role === "assistant" &&
            index === messages.length - 1;
          return (
            <div key={index} className="flex min-w-0 flex-col gap-3">
              <span className="sr-only">{speaker}: </span>
              <SafeMessageBubble
                role={message.role}
                content={message.content}
                streaming={isStreamingReply}
                streamComplete={streamComplete && isStreamingReply}
                onStreamHandoffComplete={isStreamingReply ? onStreamHandoffComplete : undefined}
              />
              {isStreamingReply && !message.content ? (
                <span className="text-tertiary">…</span>
              ) : null}
            </div>
          );
        })}
        {error ? (
          <p role="alert" className="text-sm text-support-red">
            {error}
          </p>
        ) : null}
      </div>
      <div ref={endRef} />
    </div>
  );
}
