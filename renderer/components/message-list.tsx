// Renders the transcript: persisted messages + the in-progress streaming reply.

import * as React from "react";
import { Ban, CircleAlert, CircleDot } from "lucide-react";
import { ThinkingOrb, type OrbTheme } from "thinking-orbs";
import { Callout, Text } from "./ui";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "../lib/types";
import type { AgentActivity, ToolActivity } from "../lib/agent-activity";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";

interface OrbAppearance {
  theme: OrbTheme;
  paused: boolean;
}

function readOrbAppearance(): OrbAppearance {
  if (typeof document === "undefined") return { theme: "light", paused: true };
  const root = document.documentElement;
  return {
    theme: root.dataset.appearanceScheme === "dark" ? "dark" : "light",
    paused: root.dataset.reduceMotion === "true",
  };
}

function useOrbAppearance(): OrbAppearance {
  const [appearance, setAppearance] = React.useState(readOrbAppearance);

  React.useEffect(() => {
    const update = () => setAppearance(readOrbAppearance());
    window.addEventListener(APPEARANCE_CHANGE_EVENT, update);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, update);
  }, []);

  return appearance;
}

interface MessageListProps {
  messages: ChatMessage[];
  /** Text of the assistant reply currently streaming, or null when idle. */
  streamingText: string | null;
  /** Transient, stateful tool activity for the current generation. */
  toolActivity: ToolActivity | null;
  /** Current active generation phase, derived from real stream/tool state. */
  agentActivity: AgentActivity | null;
  error: string | null;
}

export function MessageList({
  messages,
  streamingText,
  toolActivity,
  agentActivity,
  error,
}: MessageListProps) {
  const orbAppearance = useOrbAppearance();
  const ActivityIcon = toolActivity
    ? toolActivity.state === "finished"
      ? CircleDot
      : toolActivity.state === "failed"
        ? CircleAlert
        : toolActivity.state === "blocked"
          ? Ban
          : null
    : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-6 sm:px-5">
      {messages.map((m) => (
        <MessageBubble key={m.id} role={m.role} content={m.content} attachments={m.attachments} />
      ))}

      {toolActivity && ActivityIcon ? (
        <div
          role={toolActivity.state === "failed" ? "alert" : "status"}
          className="flex w-fit max-w-full items-center gap-2 py-0.5"
        >
          <ActivityIcon
            className={
              toolActivity.state === "finished"
                ? "size-3.5 text-secondary"
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

      {streamingText ? <MessageBubble role="assistant" content={streamingText} streaming /> : null}

      {agentActivity ? (
        <div
          role="status"
          aria-live="polite"
          className="flex w-fit max-w-full items-center gap-2 py-0.5"
          data-agent-activity={agentActivity.phase}
        >
          <ThinkingOrb
            aria-hidden="true"
            state={agentActivity.orbState}
            size={20}
            theme={orbAppearance.theme}
            paused={orbAppearance.paused}
            className="shrink-0 text-primary"
          />
          <Text
            variant="small"
            color="secondary"
            className={
              agentActivity.phase === "thinking"
                ? "agent-thinking-shimmer min-w-0 break-words"
                : "min-w-0 break-words"
            }
          >
            {agentActivity.label}
          </Text>
        </div>
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
