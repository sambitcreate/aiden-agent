import * as React from "react";
import type { AssistantMessage } from "./use-assistant-chat";

/**
 * The Aiden transcript. Plain text with preserved whitespace rather than
 * Markdown: the persona is instructed to keep formatting sparse, and the main
 * window's renderer carries workspace-chat concerns this window does not have.
 */
export function AssistantThread({
  messages,
  streaming,
  error,
}: {
  messages: AssistantMessage[];
  streaming: boolean;
  error: string | null;
}): React.ReactElement {
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, streaming]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={streaming}
        className="flex flex-col gap-3"
      >
        {messages.map((message, index) => {
          const speaker = message.role === "user" ? "You" : "Aiden";
          return (
            <div
              key={index}
              className={
                message.role === "user"
                  ? "self-end max-w-[85%] rounded-2xl bg-control px-3 py-1.5 text-sm text-primary"
                  : "max-w-full text-sm text-primary"
              }
            >
              <span className="sr-only">{speaker}: </span>
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
              {message.role === "assistant" && !message.content && streaming ? (
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
