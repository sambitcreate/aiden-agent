// Renders the transcript: persisted messages + the in-progress streaming reply.

import * as React from "react";
import { Callout, ErrorBoundary, Text } from "./ui";
import { AidenOrb } from "./aiden-orb";
import { ActivityFeed } from "./activity-feed";
import { EventPresence } from "./event-presence";
import { MessageBubble } from "./message-bubble";
import { ReasoningBlock } from "./reasoning-block";
import { SubagentChips } from "./subagent-chips";
import type { ChatMessage } from "../lib/types";
import type { AgentActivity } from "../lib/agent-activity";
import {
  captureSubagentChipFocus,
  resolveSubagentChipFocusHandoff,
  retainSubagentChipFocusAfterPointerDown,
  type SubagentChipFocusCapture,
} from "../lib/subagent-panel-state";
import type { GenerationTimeline } from "../shared/generation-timeline";
import type { SubagentRunSnapshotV1 } from "../shared/subagent-runs";

interface MessageListProps {
  messages: ChatMessage[];
  /** Text of the assistant reply currently streaming, or null when idle. */
  streamingText: string | null;
  /** Reasoning explicitly emitted by the current supported provider. */
  streamingReasoning: string | null;
  streamComplete?: boolean;
  onStreamHandoffComplete?: () => void;
  timeline: GenerationTimeline | null;
  liveSubagents: readonly SubagentRunSnapshotV1[];
  subagentsEnabled: boolean;
  onOpenSubagent: (runId: string, trigger: HTMLButtonElement) => void;
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
  liveSubagents,
  subagentsEnabled,
  onOpenSubagent,
  agentActivity,
  error,
}: MessageListProps) {
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);
  const chipFocusCaptureRef = React.useRef<SubagentChipFocusCapture | null>(null);

  React.useEffect(() => {
    const captureFocusedChip = (target: EventTarget | null) => {
      const chip =
        target instanceof Element
          ? target.closest<HTMLElement>("[data-subagent-chip-run-id]")
          : null;
      if (chip && transcriptRef.current?.contains(chip)) {
        chipFocusCaptureRef.current = captureSubagentChipFocus(chip);
        return;
      }
      if (
        (target === document.body || target === document.documentElement) &&
        chipFocusCaptureRef.current &&
        !chipFocusCaptureRef.current.element.isConnected
      ) {
        return;
      }
      chipFocusCaptureRef.current = null;
    };
    const onFocusIn = (event: FocusEvent) => captureFocusedChip(event.target);
    const onPointerDown = (event: PointerEvent) => {
      chipFocusCaptureRef.current = retainSubagentChipFocusAfterPointerDown(
        chipFocusCaptureRef.current,
        event.target instanceof Node ? event.target : null,
      );
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  React.useLayoutEffect(() => {
    const root = transcriptRef.current;
    if (!root) return;
    const handoff = resolveSubagentChipFocusHandoff(
      chipFocusCaptureRef.current,
      document.activeElement,
      [document.body, document.documentElement],
      root.querySelectorAll<HTMLElement>("[data-subagent-chip-run-id]"),
    );
    if (handoff.action === "clear") {
      chipFocusCaptureRef.current = null;
      return;
    }
    if (handoff.action === "focus") {
      chipFocusCaptureRef.current = captureSubagentChipFocus(handoff.target);
      handoff.target.focus({ preventScroll: true });
    }
  });

  return (
    <div
      ref={transcriptRef}
      className="aiden-dock-inset mx-auto flex w-full max-w-3xl flex-col gap-5 py-6"
      data-subagent-chip-focus-scope="true"
    >
      {messages.map((m) => (
        <div key={m.id} className="flex min-w-0 flex-col gap-3">
          {m.role === "assistant" && m.timeline?.steps.length ? (
            <ActivityFeed timeline={m.timeline} animate={false} />
          ) : null}
          {subagentsEnabled && m.role === "assistant" && m.subagents ? (
            <SubagentChips reference={m.subagents} onOpen={onOpenSubagent} />
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

      {timeline || liveSubagents.length > 0 || streamingReasoning || streamingText ? (
        <div className="flex min-w-0 flex-col gap-3">
          <ActivityFeed timeline={timeline} />
          {subagentsEnabled && liveSubagents.length > 0 ? (
            <SubagentChips runs={liveSubagents} onOpen={onOpenSubagent} />
          ) : null}
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

      <AgentActivityTransition activity={agentActivity} />

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

function AgentActivityTransition({ activity }: { activity: AgentActivity | null }) {
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
      <AidenOrb state={value.orbState} size={20} className="shrink-0 text-primary" />
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
