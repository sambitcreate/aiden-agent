// Renders the transcript: persisted messages + the in-progress streaming reply.

import * as React from "react";
import { Callout, Text } from "./ui";
import { AidenOrb } from "./aiden-orb";
import { ActivityFeed } from "./activity-feed";
import { EventPresence } from "./event-presence";
import { SafeMessageBubble } from "./message-bubble";
import { MessageAttachmentPreviewProvider, MessageAttachments } from "./message-attachments";
import { ReasoningBlock } from "./reasoning-block";
import { SubagentChips } from "./subagent-chips";
import {
  activityTimelineFragment,
  assistantPresentationRows,
} from "../lib/assistant-message-presentation";
import type { Attachment, ChatMessage } from "../lib/types";
import type { ChatArtifactV1, ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { isChatHtmlArtifact, isChatImageArtifact } from "../shared/chat-artifacts";
import { HtmlArtifactList } from "./html-artifact-frame";
import type { AgentActivity } from "../lib/agent-activity";
import {
  captureSubagentChipFocus,
  resolveSubagentChipFocusHandoff,
  retainSubagentChipFocusAfterPointerDown,
  type SubagentChipFocusCapture,
} from "../lib/subagent-panel-state";
import { isToolStep, type GenerationTimeline } from "../shared/generation-timeline";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import { providerFailurePresentation, type ProviderFailureV1 } from "../shared/provider-failure";

const EMPTY_CHAT_ARTIFACTS: readonly ChatArtifactV1[] = [];

interface MessageListProps {
  chatId: string;
  messages: ChatMessage[];
  /** Text of the assistant reply currently streaming, or null when idle. */
  streamingText: string | null;
  /** Reasoning explicitly emitted by the current supported provider. */
  streamingReasoning: string | null;
  /** Versioned GUI artifacts emitted by Pi extensions during this response. */
  streamingArtifacts?: readonly ChatArtifactV1[];
  streamComplete?: boolean;
  onStreamHandoffComplete?: () => void;
  timeline: GenerationTimeline | null;
  liveSubagents: readonly SubagentRunSnapshot[];
  subagentsEnabled: boolean;
  onOpenSubagent: (runId: string, trigger: HTMLButtonElement) => void;
  /** Current active generation phase, derived from real stream/tool state. */
  agentActivity: AgentActivity | null;
  error: string | null;
}

interface AssistantResponseProps {
  content: string;
  timeline: GenerationTimeline | null | undefined;
  reasoning?: string | null;
  attachments?: readonly Attachment[];
  htmlArtifacts?: readonly ChatHtmlArtifactV1[];
  chatId?: string;
  subagentChips?: React.ReactNode;
  streaming?: boolean;
  streamComplete?: boolean;
  onStreamHandoffComplete?: () => void;
}

function AssistantResponse({
  content,
  timeline,
  reasoning,
  attachments,
  htmlArtifacts,
  chatId,
  subagentChips,
  streaming = false,
  streamComplete,
  onStreamHandoffComplete,
}: AssistantResponseProps) {
  const rows = assistantPresentationRows(content, timeline);
  if (!rows || !timeline) {
    return (
      <>
        <ActivityFeed timeline={timeline ?? null} animate={streaming} />
        {subagentChips}
        {reasoning ? (
          <ReasoningBlock
            content={reasoning}
            streaming={streaming && !streamComplete}
            active={streaming && !streamComplete && !content}
          />
        ) : null}
        {content ? (
          <SafeMessageBubble
            role="assistant"
            content={content}
            streaming={streaming}
            streamComplete={streamComplete}
            onStreamHandoffComplete={onStreamHandoffComplete}
          />
        ) : null}
        {attachments?.length ? (
          <MessageAttachments attachments={attachments} role="assistant" />
        ) : null}
        {chatId && htmlArtifacts?.length ? (
          <HtmlArtifactList chatId={chatId} artifacts={htmlArtifacts} />
        ) : null}
      </>
    );
  }

  let lastTextIndex = -1;
  rows.forEach((row, index) => {
    if (row.kind === "text") lastTextIndex = index;
  });
  const subagentActivityKey = rows.find(
    (row) =>
      row.kind === "activity" &&
      row.steps.some((step) => isToolStep(step) && step.toolName === "subagent"),
  )?.key;

  return (
    <>
      {reasoning ? (
        <ReasoningBlock
          content={reasoning}
          streaming={streaming && !streamComplete}
          active={streaming && !streamComplete && !content}
        />
      ) : null}
      {subagentChips && !subagentActivityKey ? subagentChips : null}
      {rows.map((row, index) => {
        if (row.kind === "activity") {
          return (
            <React.Fragment key={row.key}>
              <ActivityFeed
                timeline={activityTimelineFragment(timeline, row.steps)}
                animate={streaming}
              />
              {subagentActivityKey === row.key ? subagentChips : null}
            </React.Fragment>
          );
        }
        const isLastText = index === lastTextIndex;
        return (
          <SafeMessageBubble
            key={row.key}
            role="assistant"
            content={row.content}
            streaming={streaming && isLastText}
            streamComplete={isLastText ? streamComplete : undefined}
            onStreamHandoffComplete={isLastText ? onStreamHandoffComplete : undefined}
            showCopy={isLastText}
            copyText={content}
          />
        );
      })}
      {attachments?.length ? (
        <MessageAttachments attachments={attachments} role="assistant" />
      ) : null}
      {chatId && htmlArtifacts?.length ? (
        <HtmlArtifactList chatId={chatId} artifacts={htmlArtifacts} />
      ) : null}
    </>
  );
}

export function ProviderFailureCallout({ failure }: { failure: ProviderFailureV1 }) {
  const presentation = providerFailurePresentation(failure);
  return (
    <Callout color="red" role="alert" aria-atomic="true" data-provider-failure={failure.category}>
      <Text variant="small-strong" color="red">
        {presentation.title}
      </Text>
      <Text variant="small" color="secondary" className="mt-0.5 block">
        {presentation.description}
      </Text>
    </Callout>
  );
}

export function MessageList({
  chatId,
  messages,
  streamingText,
  streamingReasoning,
  streamingArtifacts = EMPTY_CHAT_ARTIFACTS,
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
  const persistedAttachmentIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) ids.add(attachment.id);
    }
    return ids;
  }, [messages]);
  const persistedHtmlIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const artifact of message.htmlArtifacts ?? []) ids.add(artifact.mediaId);
    }
    return ids;
  }, [messages]);
  const liveAttachments = React.useMemo(() => {
    const attachments: Attachment[] = [];
    for (const artifact of streamingArtifacts) {
      if (!isChatImageArtifact(artifact)) continue;
      if (!persistedAttachmentIds.has(artifact.attachment.id)) {
        attachments.push(artifact.attachment);
      }
    }
    return attachments;
  }, [persistedAttachmentIds, streamingArtifacts]);
  const liveHtmlArtifacts = React.useMemo(() => {
    const artifacts: ChatHtmlArtifactV1[] = [];
    for (const artifact of streamingArtifacts) {
      if (!isChatHtmlArtifact(artifact)) continue;
      if (!persistedHtmlIds.has(artifact.mediaId)) artifacts.push(artifact);
    }
    return artifacts;
  }, [persistedHtmlIds, streamingArtifacts]);

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
    <MessageAttachmentPreviewProvider>
      <div
        ref={transcriptRef}
        className="aiden-dock-inset chat-content-column flex flex-col gap-5 py-6"
        data-subagent-chip-focus-scope="true"
      >
        {messages.map((m) => (
          <div key={m.id} className="flex min-w-0 flex-col gap-3">
            {m.role === "assistant" ? (
              <>
                <AssistantResponse
                  content={m.content}
                  timeline={m.timeline}
                  reasoning={m.reasoning}
                  attachments={m.attachments}
                  htmlArtifacts={m.htmlArtifacts}
                  chatId={chatId}
                  subagentChips={
                    subagentsEnabled && m.subagents ? (
                      <SubagentChips reference={m.subagents} onOpen={onOpenSubagent} />
                    ) : undefined
                  }
                />
                {m.providerFailure ? <ProviderFailureCallout failure={m.providerFailure} /> : null}
              </>
            ) : (
              <SafeMessageBubble
                role={m.role}
                content={m.content}
                attachments={m.attachments}
                skill={m.skill}
              />
            )}
          </div>
        ))}

        {timeline ||
        liveSubagents.length > 0 ||
        streamingReasoning ||
        streamingText ||
        liveAttachments.length > 0 ||
        liveHtmlArtifacts.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-3">
            <AssistantResponse
              content={streamingText ?? ""}
              timeline={timeline}
              reasoning={streamingReasoning}
              attachments={liveAttachments}
              htmlArtifacts={liveHtmlArtifacts}
              chatId={chatId}
              subagentChips={
                subagentsEnabled && liveSubagents.length > 0 ? (
                  <SubagentChips runs={liveSubagents} onOpen={onOpenSubagent} />
                ) : undefined
              }
              streaming
              streamComplete={streamComplete}
              onStreamHandoffComplete={onStreamHandoffComplete}
            />
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
    </MessageAttachmentPreviewProvider>
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
