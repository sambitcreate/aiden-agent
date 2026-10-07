// Renders the transcript: persisted messages + the in-progress streaming reply.

import * as React from "react";
import { Callout, Text } from "./ui";
import { AidenOrb } from "./aiden-orb";
import { ActivityFeed } from "./activity-feed";
import { EventPresence } from "./event-presence";
import { SafeMessageBubble } from "./message-bubble";
import type { ReadAloudActionProps } from "./read-aloud-button";
import { MessageForkContextMenu, type MessageForkAction } from "./fork-message-button";
import { MessageActions } from "./message-actions";
import type { ChatForkPosition } from "../shared/chat-copy-contract";
import { forkSummaryRows } from "../lib/chat-copy-view";
import { MessageAttachmentPreviewProvider, MessageAttachments } from "./message-attachments";
import { ReasoningBlock } from "./reasoning-block";
import { SubagentChips } from "./subagent-chips";
import { TurnFooter } from "./turn-footer";
import { turnFooterItems } from "../shared/assistant-turn-stats";
import {
  activityTimelineFragment,
  assistantPresentationRows,
} from "../lib/assistant-message-presentation";
import { reasoningActivityLabel } from "../lib/agent-steps";
import type { Attachment, ChatMessage } from "../lib/types";
import type { ChatArtifactV1 } from "../shared/chat-artifacts";
import { isChatHtmlArtifact, isChatImageArtifact } from "../shared/chat-artifacts";
import { HtmlArtifactFrame } from "./html-artifact-frame";
import { activityPresentationDelay, type AgentActivity } from "../lib/agent-activity";
import {
  captureSubagentChipFocus,
  resolveSubagentChipFocusHandoff,
  retainSubagentChipFocusAfterPointerDown,
  type SubagentChipFocusCapture,
} from "../lib/subagent-panel-state";
import {
  hasActiveThinkingStep,
  isToolStep,
  type GenerationTimeline,
} from "../shared/generation-timeline";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import { providerFailurePresentation, type ProviderFailureV1 } from "../shared/provider-failure";
import {
  htmlArtifactTranscriptPlan,
  type HtmlArtifactTranscriptEntry,
} from "../lib/html-artifact-transcript";
import { BotUpdates } from "../main/bots/bot-updates";
import { resolveBotReplyProjection } from "../main/bots/bot-reply-projection";

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
  /** Persisted assistant message that duplicates the completed streaming row during handoff. */
  persistedHandoffMessageId?: string | null;
  onStreamHandoffComplete?: () => void;
  timeline: GenerationTimeline | null;
  liveSubagents: readonly SubagentRunSnapshot[];
  subagentsEnabled: boolean;
  onOpenSubagent: (runId: string, trigger: HTMLButtonElement) => void;
  /** Current active generation phase, derived from real stream/tool state. */
  agentActivity: AgentActivity | null;
  error: string | null;
  /** Message id whose whole response may host the read-aloud action. */
  readAloudMessageId?: string;
  readAloud?: ReadAloudActionProps;
  /** Fork the chat at a settled message; absent where forking is unsupported. */
  onFork?: (messageId: string, position: ChatForkPosition) => void;
  /** Shown on the fork actions while the chat is busy. */
  forkDisabledReason?: string | null;
  /** Fork and summarize what followed; offered only where something follows. */
  onForkWithSummary?: (messageId: string, position: ChatForkPosition) => void;
  /** This fork's summary card, placed after the last copied message. */
  forkSummary?: { afterMessageId: string; node: React.ReactNode };
  /**
   * False where nothing comes before the first prompt shown, and editing it
   * in a fork is refused (a paired Mac's chat): that prompt offers no fork.
   */
  forkBeforeFirstPrompt?: boolean;
  /**
   * Bot chats read like messages: tool activity and narration before the
   * final answer fold into one collapsed "Updates" line.
   */
  botPresentation?: boolean;
}

interface AssistantResponseProps {
  content: string;
  timeline: GenerationTimeline | null | undefined;
  reasoning?: string | null;
  attachments?: readonly Attachment[];
  subagentChips?: React.ReactNode;
  streaming?: boolean;
  streamComplete?: boolean;
  onStreamHandoffComplete?: () => void;
  /** Read-aloud action for the latest eligible whole response. */
  readAloud?: ReadAloudActionProps;
  richLinks?: boolean;
  /** Settled turn facts; joins the tail action row, or stands alone without prose. */
  footer?: React.ReactNode;
  fork?: MessageForkAction;
  botPresentation?: boolean;
}

/** A Bot reply: one collapsed Updates line, then only the final answer. */
function BotAssistantResponse({
  content,
  timeline,
  attachments,
  streaming = false,
  streamComplete,
  onStreamHandoffComplete,
  readAloud,
  richLinks = true,
  footer,
}: AssistantResponseProps) {
  const active = streaming && !streamComplete;
  const projection = resolveBotReplyProjection(content, timeline, active);
  const toolTimeline = timeline
    ? activityTimelineFragment(timeline, timeline.steps.filter(isToolStep))
    : null;
  return (
    <>
      <BotUpdates progressText={projection.progressText} timeline={toolTimeline} active={active} />
      {projection.finalText ? (
        <SafeMessageBubble
          role="assistant"
          content={projection.finalText}
          streaming={streaming}
          streamComplete={streamComplete}
          onStreamHandoffComplete={onStreamHandoffComplete}
          readAloud={readAloud}
          richLinks={richLinks}
          footer={footer}
        />
      ) : null}
      {attachments?.length ? (
        <MessageAttachments attachments={attachments} role="assistant" />
      ) : null}
    </>
  );
}

function AssistantResponse({
  content,
  timeline,
  reasoning,
  attachments,
  subagentChips,
  streaming = false,
  streamComplete,
  onStreamHandoffComplete,
  readAloud,
  richLinks = true,
  footer,
  fork,
  botPresentation = false,
}: AssistantResponseProps) {
  if (botPresentation) {
    return (
      <BotAssistantResponse
        content={content}
        timeline={timeline}
        attachments={attachments}
        streaming={streaming}
        streamComplete={streamComplete}
        onStreamHandoffComplete={onStreamHandoffComplete}
        readAloud={readAloud}
        richLinks={richLinks}
        footer={footer}
      />
    );
  }
  const rows = assistantPresentationRows(content, timeline, reasoning ?? "");
  const reasoningActive = hasActiveThinkingStep(timeline ?? null);
  const active =
    streaming && !streamComplete && (reasoningActive || (!timeline && !content));
  const reasoningLabel = reasoningActivityLabel(timeline, active);
  const showReasoning = Boolean(reasoning);
  if (!rows || !timeline) {
    const activityTimeline = timeline
      ? activityTimelineFragment(timeline, timeline.steps.filter(isToolStep))
      : null;
    return (
      <>
        <ActivityFeed timeline={activityTimeline} animate={streaming} />
        {subagentChips}
        {showReasoning ? (
          <ReasoningBlock
            content={reasoning ?? ""}
            streaming={streaming && !streamComplete}
            active={active}
            label={reasoningLabel}
          />
        ) : null}
        {content ? (
          <SafeMessageBubble
            role="assistant"
            content={content}
            streaming={streaming}
            streamComplete={streamComplete}
            onStreamHandoffComplete={onStreamHandoffComplete}
            readAloud={readAloud}
            richLinks={richLinks}
            footer={footer}
            fork={fork}
          />
        ) : null}
        {attachments?.length ? (
          <MessageAttachments attachments={attachments} role="assistant" />
        ) : null}
        {!content ? proselessActions(footer, fork) : null}
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
      {subagentChips && !subagentActivityKey ? subagentChips : null}
      {rows.map((row, index) => {
        if (row.kind === "reasoning") {
          const stepActive = streaming && !streamComplete && row.step.finishedAt === undefined;
          return (
            <ReasoningBlock
              key={row.key}
              content={row.content}
              streaming={stepActive}
              active={stepActive}
              label={reasoningActivityLabel(activityTimelineFragment(timeline, [row.step]), stepActive)}
            />
          );
        }
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
            readAloud={isLastText ? readAloud : undefined}
            richLinks={richLinks}
            footer={isLastText ? footer : undefined}
            fork={isLastText ? fork : undefined}
          />
        );
      })}
      {attachments?.length ? (
        <MessageAttachments attachments={attachments} role="assistant" />
      ) : null}
      {lastTextIndex < 0 ? proselessActions(footer, fork) : null}
    </>
  );
}

/** A reply with only attachments or activity still needs its fork action. */
function proselessActions(footer: React.ReactNode, fork: MessageForkAction | undefined): React.ReactNode {
  if (!fork) return footer ?? null;
  // The reply's media sits above, so hovering this row reveals the action.
  return (
    <div className="group">
      <MessageActions copyText="" footer={footer} fork={fork} />
    </div>
  );
}

function settledTurnFooter(message: ChatMessage): React.ReactNode {
  const items = turnFooterItems(message);
  return items.length > 0 ? <TurnFooter items={items} /> : undefined;
}

interface SettledMessageRowProps {
  message: ChatMessage;
  readAloud?: ReadAloudActionProps;
  richLinks: boolean;
  subagentsEnabled: boolean;
  onOpenSubagent: (runId: string, trigger: HTMLButtonElement) => void;
  /** Stable across renders so settled rows stay memoized. */
  onFork?: (messageId: string, position: ChatForkPosition) => void;
  /** Settled user prompts with an earlier prompt can be edited in a fork. */
  forkDisabledReason?: string | null;
  /** Stable like `onFork`; present when a fork from this row can summarize what followed. */
  onForkWithSummary?: (messageId: string, position: ChatForkPosition) => void;
  botPresentation?: boolean;
}

/**
 * One persisted transcript message. Memoized so streaming frames, which change
 * only the live row, do not re-render or re-derive settled history.
 */
const SettledMessageRow = React.memo(function SettledMessageRow({
  message,
  readAloud,
  richLinks,
  subagentsEnabled,
  onOpenSubagent,
  onFork,
  forkDisabledReason,
  onForkWithSummary,
  botPresentation = false,
}: SettledMessageRowProps) {
  const fork = React.useMemo<MessageForkAction | undefined>(() => {
    if (!onFork || (message.role !== "user" && message.role !== "assistant")) return undefined;
    const position: ChatForkPosition = message.role === "user" ? "before" : "after";
    return {
      onFork: () => onFork(message.id, position),
      ...(onForkWithSummary
        ? { onForkWithSummary: () => onForkWithSummary(message.id, position) }
        : {}),
      disabledReason: forkDisabledReason,
    };
  }, [forkDisabledReason, message.id, message.role, onFork, onForkWithSummary]);
  const row = (
    <div className="flex min-w-0 flex-col gap-3">
      {message.role === "assistant" ? (
        <>
          <AssistantResponse
            content={message.content}
            timeline={message.timeline}
            reasoning={message.reasoning}
            attachments={message.attachments}
            readAloud={readAloud}
            richLinks={richLinks}
            footer={settledTurnFooter(message)}
            fork={fork}
            botPresentation={botPresentation}
            subagentChips={
              subagentsEnabled && message.subagents ? (
                <SubagentChips reference={message.subagents} onOpen={onOpenSubagent} />
              ) : undefined
            }
          />
          {message.providerFailure ? (
            <ProviderFailureCallout failure={message.providerFailure} />
          ) : null}
        </>
      ) : (
        <SafeMessageBubble
          role={message.role}
          content={message.content}
          attachments={message.attachments}
          skill={message.skill}
          fork={fork}
        />
      )}
    </div>
  );
  if (!fork) return row;
  return (
    <MessageForkContextMenu action={fork} kind={message.role === "user" ? "edit" : "fork"}>
      {row}
    </MessageForkContextMenu>
  );
});

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

export function richLinkHandoffDuplicateMessageId(
  messages: readonly ChatMessage[],
  streamingText: string | null,
  streamComplete: boolean,
  persistedHandoffMessageId: string | null,
): string | null {
  if (!streamComplete || streamingText === null || persistedHandoffMessageId === null) return null;
  const message = messages.find((candidate) => candidate.id === persistedHandoffMessageId);
  return message?.role === "assistant" && message.content === streamingText ? message.id : null;
}

export function MessageList({
  chatId,
  messages,
  streamingText,
  streamingReasoning,
  streamingArtifacts = EMPTY_CHAT_ARTIFACTS,
  streamComplete,
  persistedHandoffMessageId = null,
  onStreamHandoffComplete,
  timeline,
  liveSubagents,
  subagentsEnabled,
  onOpenSubagent,
  agentActivity,
  error,
  readAloudMessageId,
  readAloud,
  onFork,
  forkDisabledReason = null,
  onForkWithSummary,
  forkSummary,
  forkBeforeFirstPrompt = true,
  botPresentation = false,
}: MessageListProps) {
  const onForkRef = React.useRef(onFork);
  const onForkWithSummaryRef = React.useRef(onForkWithSummary);
  React.useLayoutEffect(() => {
    onForkRef.current = onFork;
    onForkWithSummaryRef.current = onForkWithSummary;
  }, [onFork, onForkWithSummary]);
  const forkEnabled = Boolean(onFork);
  const forkWithSummaryEnabled = forkEnabled && Boolean(onForkWithSummary);
  const stableOnFork = React.useCallback(
    (messageId: string, position: ChatForkPosition) => onForkRef.current?.(messageId, position),
    [],
  );
  const stableOnForkWithSummary = React.useCallback(
    (messageId: string, position: ChatForkPosition) =>
      onForkWithSummaryRef.current?.(messageId, position),
    [],
  );
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);
  const chipFocusCaptureRef = React.useRef<SubagentChipFocusCapture | null>(null);
  const persistedAttachmentIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) ids.add(attachment.id);
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
  // While the streaming row is still mounted its live HTML cards stay exactly
  // where they appeared; the persisted copies wait hidden so the handoff is a
  // single atomic swap instead of an unmount/remount flash in two frames.
  const liveHtmlArtifacts = React.useMemo(
    () => streamingArtifacts.filter(isChatHtmlArtifact),
    [streamingArtifacts],
  );
  const streamingRowVisible = Boolean(
    timeline ||
      liveSubagents.length > 0 ||
      streamingReasoning ||
      streamingText ||
      liveAttachments.length > 0 ||
      liveHtmlArtifacts.length > 0,
  );
  const richLinkHandoffDuplicateId = richLinkHandoffDuplicateMessageId(
    messages,
    streamingText,
    Boolean(streamComplete),
    persistedHandoffMessageId,
  );
  const htmlArtifactPlan = React.useMemo(
    () => htmlArtifactTranscriptPlan(messages, liveHtmlArtifacts, streamingRowVisible),
    [liveHtmlArtifacts, messages, streamingRowVisible],
  );
  const htmlArtifactsByAnchor = React.useMemo(() => {
    const entries = new Map<string, HtmlArtifactTranscriptEntry[]>();
    for (const entry of htmlArtifactPlan) {
      const anchored = entries.get(entry.anchor) ?? [];
      anchored.push(entry);
      entries.set(entry.anchor, anchored);
    }
    return entries;
  }, [htmlArtifactPlan]);

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
    // Nothing to hand off while no chip owns focus or the focused chip is still
    // mounted; skip the transcript-wide query on ordinary streaming renders.
    const capture = chipFocusCaptureRef.current;
    if (!capture) return;
    if (capture.element.isConnected) return;
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

  const artifactFrames = (anchor: string) =>
    (htmlArtifactsByAnchor.get(anchor) ?? []).map((entry) => (
      <HtmlArtifactFrame
        key={entry.key}
        chatId={chatId}
        artifact={entry.artifact}
      />
    ));

  const transcriptRows: React.ReactNode[] = [];
  const summaryRows = forkWithSummaryEnabled ? forkSummaryRows(messages) : null;
  const unforkablePromptId =
    forkEnabled && !forkBeforeFirstPrompt ? messages.find((message) => message.role === "user")?.id : undefined;
  for (const message of messages) {
    transcriptRows.push(
      <SettledMessageRow
        key={`message:${message.id}`}
        message={message}
        readAloud={readAloudMessageId === message.id ? readAloud : undefined}
        richLinks={message.id !== richLinkHandoffDuplicateId}
        subagentsEnabled={subagentsEnabled}
        onOpenSubagent={onOpenSubagent}
        onFork={forkEnabled && message.id !== unforkablePromptId ? stableOnFork : undefined}
        forkDisabledReason={forkDisabledReason}
        onForkWithSummary={summaryRows?.has(message.id) ? stableOnForkWithSummary : undefined}
        botPresentation={botPresentation}
      />,
    );
    transcriptRows.push(...artifactFrames(`message:${message.id}`));
    if (forkSummary?.afterMessageId === message.id) {
      transcriptRows.push(<React.Fragment key="fork-summary">{forkSummary.node}</React.Fragment>);
    }
  }

  if (streamingRowVisible) {
    transcriptRows.push(
      <div key="streaming" className="flex min-w-0 flex-col gap-3">
        <AssistantResponse
          content={streamingText ?? ""}
          timeline={timeline}
          reasoning={streamingReasoning}
          attachments={liveAttachments}
          subagentChips={
            subagentsEnabled && liveSubagents.length > 0 ? (
              <SubagentChips runs={liveSubagents} onOpen={onOpenSubagent} />
            ) : undefined
          }
          streaming
          streamComplete={streamComplete}
          onStreamHandoffComplete={onStreamHandoffComplete}
          botPresentation={botPresentation}
        />
      </div>,
    );
    transcriptRows.push(...artifactFrames("streaming"));
  }

  return (
    <MessageAttachmentPreviewProvider>
      <div
        ref={transcriptRef}
        className="aiden-dock-inset chat-content-column flex flex-col gap-5 py-6"
        data-subagent-chip-focus-scope="true"
      >
        {transcriptRows}

        <AgentActivityTransition activity={agentActivity} />

        <EventPresence present={Boolean(error)}>
          {error ? (
            <Callout color="red" role="alert" aria-atomic="true">
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
  const [current, setCurrent] = React.useState(activity);
  React.useEffect(() => {
    if (current?.phase === activity?.phase && current?.label === activity?.label) return;
    const delay = activityPresentationDelay(
      current,
      activity,
      document.documentElement.dataset.reduceMotion === "true",
    );
    if (!delay) {
      setCurrent(activity);
      return;
    }
    const timer = window.setTimeout(() => setCurrent(activity), delay);
    return () => window.clearTimeout(timer);
  }, [activity?.phase, activity?.label, activity?.orbState, current]);

  if (!current) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="agent-activity-layer agent-event-in flex w-fit max-w-full items-center gap-2 py-0.5"
      data-agent-activity={current.phase}
    >
      <AidenOrb state={current.orbState} size={20} className="shrink-0 text-primary" />
      <Text
        variant="small"
        color="secondary"
        className={
          current.phase === "thinking" ||
          current.phase === "loading" ||
          current.phase === "visualizing"
            ? "agent-thinking-shimmer min-w-0 break-words"
            : "min-w-0 break-words"
        }
      >
        {current.label}
      </Text>
    </div>
  );
}
