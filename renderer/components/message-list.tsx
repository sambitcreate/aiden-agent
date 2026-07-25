// Renders the transcript: persisted messages + the in-progress streaming reply.

import * as React from "react";
import { ThinkingOrb, type OrbTheme } from "thinking-orbs";
import { Callout, ErrorBoundary, Text } from "./ui";
import { ActivityFeed } from "./activity-feed";
import { EventPresence } from "./event-presence";
import { MessageBubble } from "./message-bubble";
import { ReasoningBlock } from "./reasoning-block";
import type { ChatMessage } from "../lib/types";
import type { AgentActivity } from "../lib/agent-activity";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import type { GenerationTimeline } from "../shared/generation-timeline";

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
  /** Reasoning explicitly emitted by the current supported provider. */
  streamingReasoning: string | null;
  streamComplete?: boolean;
  onStreamHandoffComplete?: () => void;
  timeline: GenerationTimeline | null;
  /** Current active generation phase, derived from real stream/tool state. */
  agentActivity: AgentActivity | null;
  error: string | null;
}

export function MessageList({
  messages,
  streamingText,
  streamingReasoning,
  streamComplete,
  onStreamHandoffComplete,
  timeline,
  agentActivity,
  error,
}: MessageListProps) {
  const orbAppearance = useOrbAppearance();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-6 sm:px-5">
      {messages.map((m) => (
        <div key={m.id} className="flex min-w-0 flex-col gap-3">
          {m.role === "assistant" && m.timeline?.steps.length ? (
            <ActivityFeed timeline={m.timeline} animate={false} />
          ) : null}
          {m.role === "assistant" && m.reasoning ? <ReasoningBlock content={m.reasoning} /> : null}
          <ErrorBoundary
            fallback={<UnrenderableMessage content={m.content} />}
            resetKey={m.content}
          >
            <MessageBubble role={m.role} content={m.content} attachments={m.attachments} />
          </ErrorBoundary>
        </div>
      ))}

      {timeline || streamingReasoning || streamingText ? (
        <div className="flex min-w-0 flex-col gap-3">
          <ActivityFeed timeline={timeline} />
          {streamingReasoning ? (
            <ReasoningBlock
              content={streamingReasoning}
              streaming={!streamComplete}
              active={!streamComplete && !streamingText}
            />
          ) : null}
          {streamingText ? (
            <ErrorBoundary
              fallback={<UnrenderableMessage content={streamingText} />}
              resetKey={streamingText}
            >
              <MessageBubble
                role="assistant"
                content={streamingText}
                streaming
                streamComplete={streamComplete}
                onStreamHandoffComplete={onStreamHandoffComplete}
              />
            </ErrorBoundary>
          ) : null}
        </div>
      ) : null}

      <AgentActivityTransition activity={agentActivity} appearance={orbAppearance} />

      <EventPresence present={Boolean(error)}>
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
      </EventPresence>
    </div>
  );
}

// Markdown, KaTeX, and highlighting all run over untrusted model output. If one
// message throws, keep the rest of the transcript alive and show its raw text.
function UnrenderableMessage({ content }: { content: string }) {
  return (
    <Callout color="red">
      <Text variant="small-strong" color="red">
        This message could not be formatted
      </Text>
      <Text variant="small" color="secondary" className="mt-0.5 block whitespace-pre-wrap">
        {content}
      </Text>
    </Callout>
  );
}

function AgentActivityTransition({
  activity,
  appearance,
}: {
  activity: AgentActivity | null;
  appearance: OrbAppearance;
}) {
  interface ExitingActivity {
    id: number;
    value: AgentActivity;
  }
  const currentRef = React.useRef(activity);
  const [current, setCurrent] = React.useState(activity);
  const [exiting, setExiting] = React.useState<ExitingActivity[]>([]);
  const exitIdRef = React.useRef(0);
  const exitTimersRef = React.useRef(new Map<number, number>());

  React.useEffect(() => {
    const old = currentRef.current;
    if (old?.phase === activity?.phase && old?.label === activity?.label) return;
    currentRef.current = activity;
    setCurrent(activity);
    if (!old) return;
    if (document.documentElement.dataset.reduceMotion === "true") {
      setExiting([]);
      return;
    }
    const id = ++exitIdRef.current;
    setExiting([{ id, value: old }]);
    const timer = window.setTimeout(() => {
      exitTimersRef.current.delete(id);
      setExiting((items) => items.filter((item) => item.id !== id));
    }, 180);
    exitTimersRef.current.set(id, timer);
  }, [activity]);

  React.useEffect(
    () => () => {
      for (const timer of exitTimersRef.current.values()) window.clearTimeout(timer);
      exitTimersRef.current.clear();
    },
    [],
  );

  if (!current && exiting.length === 0) return null;
  const row = (value: AgentActivity, presence: "in" | "out", key: string) => (
    <div
      key={key}
      role="status"
      aria-live={presence === "in" ? "polite" : "off"}
      aria-hidden={presence === "out" ? "true" : undefined}
      className={`agent-activity-layer flex w-fit max-w-full items-center gap-2 py-0.5 ${
        presence === "in" ? "agent-event-in" : "agent-event-out"
      }`}
      data-agent-activity={value.phase}
    >
      <ThinkingOrb
        aria-hidden="true"
        state={value.orbState}
        size={20}
        theme={appearance.theme}
        paused={appearance.paused}
        className="shrink-0 text-primary"
      />
      <Text
        variant="small"
        color="secondary"
        className={
          value.phase === "thinking" || value.phase === "loading"
            ? "agent-thinking-shimmer min-w-0 break-words"
            : "min-w-0 break-words"
        }
      >
        {value.label}
      </Text>
    </div>
  );
  return (
    <div className="agent-activity-transition grid">
      {exiting.map((item) => row(item.value, "out", `out:${item.id}`))}
      {current ? row(current, "in", `in:${current.phase}:${current.label}`) : null}
    </div>
  );
}
