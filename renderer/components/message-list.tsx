import { AppControlsPanel } from "./app-controls-panel";
// Renders the transcript: persisted messages + the in-progress streaming reply.

import * as React from "react";
import { Button, Callout, Text } from "./ui";
import { AidenActivityMark } from "./aiden-activity-mark";
import { ActivityFeed } from "./activity-feed";
import { EventPresence } from "./event-presence";
import { SafeMessageBubble } from "./message-bubble";
import { AgentNoticeCard } from "./agent-notice-card";
import type { ReadAloudActionProps } from "./read-aloud-button";
import { MessageForkContextMenu, type MessageForkAction } from "./fork-message-button";
import { MessageActions } from "./message-actions";
import type { ChatForkPosition } from "../shared/chat-copy-contract";
import { forkSummaryRows } from "../lib/chat-copy-view";
import {
  MessageAttachmentPreviewProvider,
  MessageAttachments,
  type MessageImageActions,
} from "./message-attachments";
import { ReasoningBlock } from "./reasoning-block";
import { SubagentChips } from "./subagent-chips";
import { TurnFooter } from "./turn-footer";
import { turnFooterItems } from "../shared/assistant-turn-stats";
import {
  activityTimelineFragment,
  assistantPresentationRows,
  isExtractionStep,
  isRecordingStep,
  isQuestionnaireStep,
  clampLiveTimelineToContent,
} from "../lib/assistant-message-presentation";
import { AskUserQuestionRecap } from "./ask-user-question-recap";
import { WebExtractRecap } from "./web-extract-recap";
import { BrowserRecordingCard } from "./browser-recording-card";
import { reasoningActivityLabel } from "../lib/agent-steps";
import type { Attachment, ChatMessage } from "../lib/types";
import type { ChatArtifactV1, ChatHtmlArtifactV1, HtmlArtifactLayout } from "../shared/chat-artifacts";
import { isChatHtmlArtifact, isChatImageArtifact } from "../shared/chat-artifacts";
import { attachmentsShownWithVisuals } from "../shared/visual-snapshots";
import { HtmlArtifactDraftFrame, HtmlArtifactFrame, type GuestPromptHandler } from "./html-artifact-frame";
import { AidenUiBlock } from "./aiden-ui/aiden-ui-block";
import { AIDEN_UI_LIMITS, type ChatUiVisualV1 } from "../shared/aiden-ui/types";
import { isWireSafeKey } from "../shared/aiden-ui/visual";
import {
  reuseUnchangedUiLists,
  uiVisualsByMessage,
  uiVisualSlots,
  type UiDrafts,
} from "../lib/ui-visual-transcript";
import { chatsApi } from "../lib/ipc";
import { ImageScanPlaceholder, useImageGenerationSlots } from "./image-generation-placeholder";
import { imageGenerationRowSlots, type ImageGenerationSlot } from "../lib/image-generation-slots";
import { withInferredImagePlacements } from "../shared/image-placements";
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
import {
  PROVIDER_FAILURE_ACTION_LABELS,
  providerFailureAction,
  providerFailurePresentation,
  type ProviderFailureAction,
  type ProviderFailureV1,
} from "../shared/provider-failure";
import {
  htmlArtifactSlots,
  reuseUnchangedArtifactLists,
  type PlacedVisualDraft,
  type VisualDrafts,
  htmlArtifactTranscriptPlan,
} from "../lib/html-artifact-transcript";

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
  /**
   * Producing toolCallId per live artifact: HTML visuals by mediaId
   * (render_artifact) and images by attachment id (generate_image, display_image, share_image).
   */
  streamingArtifactPlacements?: ReadonlyMap<string, string>;
  /** mediaIds of live visuals the model asked to span the chat pane. */
  streamingWideVisuals?: ReadonlySet<string>;
  /** Native visuals presented so far in the streaming response. */
  streamingUiVisuals?: readonly ChatUiVisualV1[];
  /** Live render_ui drafts by toolCallId for the streaming response. */
  streamingUiDrafts?: UiDrafts;
  /** Live render_artifact drafts by toolCallId for the streaming response. */
  streamingVisualDrafts?: VisualDrafts;
  /** A visual asked to send a follow-up; the chat applies the admission policy. */
  onVisualPrompt?: GuestPromptHandler;
  /** A reply is running: visual follow-ups go to the draft when confirmed. */
  visualFollowUpBusy?: boolean;
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
  /** The latest failed reply's next steps; older failure cards show none. */
  failureActions?: ProviderFailureActions & { messageId: string };
  /** Offers Resume after the last message; set only while the transcript is idle. */
  interruptedReply?: InterruptedReplyActions;
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
  /** Settled turn facts; joins the tail action row, or stands alone without prose. */
  footer?: React.ReactNode;
  fork?: MessageForkAction;
  /** Save and copy actions for images stored in this (settled) response. */
  imageActions?: MessageImageActions;
  /** Image attachment id → the toolCallId of the call that produced it. */
  imagePlacements?: ReadonlyMap<string, string>;
  /** HTML visuals this response owns, placed after their producing tool row. */
  visuals?: readonly ChatHtmlArtifactV1[];
  /** mediaId → render_artifact toolCallId. */
  visualPlacements?: ReadonlyMap<string, string>;
  /** mediaIds of visuals that span the chat pane instead of the reading column. */
  wideVisuals?: ReadonlySet<string>;
  renderVisual?: RenderVisual;
  /** Live drafts by toolCallId; only the streaming response passes these. */
  visualDrafts?: VisualDrafts;
  /** Native (render_ui) visuals this response owns. */
  uiVisuals?: readonly ChatUiVisualV1[];
  /** Live native drafts by toolCallId; only the streaming response passes these. */
  uiDrafts?: UiDrafts;
  renderUiVisual?: RenderUiVisual;
}

type RenderUiVisual = (visual: ChatUiVisualV1, draft: boolean) => React.ReactNode;

const EMPTY_UI_VISUALS: readonly ChatUiVisualV1[] = [];
const EMPTY_UI_DRAFTS: UiDrafts = new Map();

const EMPTY_VISUALS: readonly ChatHtmlArtifactV1[] = [];
const EMPTY_PLACEMENTS: ReadonlyMap<string, string> = new Map();
const EMPTY_WIDE_VISUALS: ReadonlySet<string> = new Set();

type RenderVisual = (
  artifact: ChatHtmlArtifactV1,
  placementCallId?: string,
  layout?: HtmlArtifactLayout,
) => React.ReactNode;

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
  footer,
  fork,
  imageActions,
  imagePlacements = EMPTY_PLACEMENTS,
  visuals = EMPTY_VISUALS,
  visualPlacements = EMPTY_PLACEMENTS,
  wideVisuals = EMPTY_WIDE_VISUALS,
  renderVisual,
  visualDrafts,
  uiVisuals = EMPTY_UI_VISUALS,
  uiDrafts = EMPTY_UI_DRAFTS,
  renderUiVisual,
}: AssistantResponseProps) {
  const imageGeneration = useImageGenerationSlots(timeline, attachments, imagePlacements, streaming);
  const shownAttachments = React.useMemo(
    () =>
      imageGeneration.hiddenAttachmentIds.size && attachments
        ? attachments.filter((attachment) => !imageGeneration.hiddenAttachmentIds.has(attachment.id))
        : (attachments ?? []),
    [attachments, imageGeneration.hiddenAttachmentIds],
  );
  const rows = assistantPresentationRows(
    content,
    streaming ? clampLiveTimelineToContent(timeline, content.length) : timeline,
    reasoning ?? "",
  );
  // Images and generate_image placeholders sit at their producing call's row.
  const imageSlots = imageGenerationRowSlots(
    timeline ? rows : null,
    imageGeneration.slots,
    shownAttachments,
    imagePlacements,
  );
  const mediaNodes = (
    placeholders: readonly ImageGenerationSlot[] | undefined,
    images: readonly Attachment[] | undefined,
  ) => (
    <>
      {placeholders?.map((slot) => (
        <ImageScanPlaceholder key={slot.stepId} slot={slot} onRevealed={imageGeneration.onRevealed} />
      ))}
      {images?.length ? (
        <MessageAttachments attachments={images} role="assistant" imageActions={imageActions} />
      ) : null}
    </>
  );
  const media = mediaNodes(imageSlots.trailingSlots, imageSlots.trailingAttachments);
  const slots = htmlArtifactSlots(timeline ? rows : null, visuals, visualPlacements, visualDrafts);
  const uiSlots = uiVisualSlots(timeline ? rows : null, uiVisuals, uiDrafts);
  const uiNodes = (list: readonly ChatUiVisualV1[] | undefined, draft: boolean) =>
    renderUiVisual && list?.length ? list.map((visual) => renderUiVisual(visual, draft)) : null;
  const visualNodes = (artifacts: readonly ChatHtmlArtifactV1[] | undefined) =>
    renderVisual && artifacts?.length
      ? artifacts.map((artifact) =>
          renderVisual(
            artifact,
            visualPlacements.get(artifact.mediaId),
            wideVisuals.has(artifact.mediaId) ? "wide" : "column",
          ),
        )
      : null;
  const draftNodes = (drafts: readonly PlacedVisualDraft[] | undefined) =>
    drafts?.map((draft) => (
      <HtmlArtifactDraftFrame
        key={`draft:${draft.toolCallId}`}
        src={draft.src}
        title={draft.title}
        toolCallId={draft.toolCallId}
        layout={draft.layout}
      />
    )) ?? null;
  const reasoningActive = hasActiveThinkingStep(timeline ?? null);
  const active =
    streaming && !streamComplete && (reasoningActive || (!timeline && !content));
  const reasoningLabel = reasoningActivityLabel(timeline, active);
  const showReasoning = Boolean(reasoning);
  if (!rows || !timeline) {
    const activityTimeline = timeline
      ? activityTimelineFragment(
          timeline,
          timeline.steps.filter((step) => isToolStep(step) && !isQuestionnaireStep(step)),
        )
      : null;
    // Same slots as the chronological layout below, with the prose keyed like
    // its first text row, so the reply keeps its elements when the first tool
    // step arrives and the layout switches.
    return (
      <>
        {null /* the chronological layout's leading subagent slot */}
        {[
          <ActivityFeed key="activity" timeline={activityTimeline} animate={streaming} />,
          ...(timeline?.steps.filter(isExtractionStep).map((step) => (
            <WebExtractRecap key={`extraction-${step.id}`} recap={step.extraction} />
          )) ?? []),
          ...(timeline?.steps.filter(isRecordingStep).map((step) => (
            <BrowserRecordingCard key={`recording-${step.id}`} recording={step.recording} />
          )) ?? []),
          ...(timeline?.steps.filter(isQuestionnaireStep).map((step) => (
            <AskUserQuestionRecap key={`questionnaire-${step.id}`} recap={step.questionnaire} />
          )) ?? []),
          subagentChips ? <React.Fragment key="subagents">{subagentChips}</React.Fragment> : null,
          showReasoning ? (
            <ReasoningBlock
              key="reasoning"
              content={reasoning ?? ""}
              streaming={streaming && !streamComplete}
              active={active}
              label={reasoningLabel}
            />
          ) : null,
          content ? (
            <SafeMessageBubble
              key="text-0"
              role="assistant"
              content={content}
              streaming={streaming}
              streamComplete={streamComplete}
              onStreamHandoffComplete={onStreamHandoffComplete}
              readAloud={readAloud}
              footer={footer}
              fork={fork}
            />
          ) : null,
        ]}
        {media}
        {!content ? proselessActions(footer, fork) : null}
        {visualNodes(slots.trailing)}
        {uiNodes(uiSlots.trailing, false)}
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
        if (row.kind === "questionnaire") {
          return <AskUserQuestionRecap key={row.key} recap={row.step.questionnaire} />;
        }
        if (row.kind === "extraction") {
          return <WebExtractRecap key={row.key} recap={row.step.extraction} />;
        }
        if (row.kind === "recording") {
          return <BrowserRecordingCard key={row.key} recording={row.step.recording} />;
        }
        if (row.kind === "activity") {
          return (
            <React.Fragment key={row.key}>
              <ActivityFeed
                timeline={activityTimelineFragment(timeline, row.steps)}
                animate={streaming}
              />
              {visualNodes(slots.byRowKey.get(row.key))}
              {draftNodes(slots.draftsByRowKey.get(row.key))}
              {imageSlots.byRowKey.has(row.key)
                ? mediaNodes(imageSlots.byRowKey.get(row.key)?.slots, imageSlots.byRowKey.get(row.key)?.attachments)
                : null}
              {uiNodes(uiSlots.byRowKey.get(row.key), false)}
              {uiNodes(uiSlots.draftsByRowKey.get(row.key), true)}
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
            // Every text row of a running turn stays on the gated reveal path,
            // so text a tool step closed keeps its release slot after newer
            // prose takes over the last row.
            streaming={streaming}
            streamComplete={streamComplete}
            textClosed={index < rows.length - 1}
            onStreamHandoffComplete={isLastText ? onStreamHandoffComplete : undefined}
            showCopy={isLastText}
            copyText={content}
            readAloud={isLastText ? readAloud : undefined}
            footer={isLastText ? footer : undefined}
            fork={isLastText ? fork : undefined}
          />
        );
      })}
      {media}
      {lastTextIndex < 0 ? proselessActions(footer, fork) : null}
      {visualNodes(slots.trailing)}
      {uiNodes(uiSlots.trailing, false)}
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
  chatId: string;
  deferOffscreenLayout?: boolean;
  /** Absent only for the in-flight reply, which passes `live` instead. */
  message?: ChatMessage;
  /**
   * The in-flight reply. It renders in the same row component, under the key
   * its persisted message will take, so the finished reply settles in place.
   */
  live?: AssistantResponseProps;
  readAloud?: ReadAloudActionProps;
  /** Present only on the latest failed reply. */
  failureActions?: ProviderFailureActions;
  subagentsEnabled: boolean;
  onOpenSubagent: (runId: string, trigger: HTMLButtonElement) => void;
  /** Stable across renders so settled rows stay memoized. */
  onFork?: (messageId: string, position: ChatForkPosition) => void;
  /** Settled user prompts with an earlier prompt can be edited in a fork. */
  forkDisabledReason?: string | null;
  /** Stable like `onFork`; present when a fork from this row can summarize what followed. */
  onForkWithSummary?: (messageId: string, position: ChatForkPosition) => void;
  /** HTML visuals this row currently owns (live copies win during handoff). */
  visuals?: readonly ChatHtmlArtifactV1[];
  /** Stable across renders so settled rows stay memoized. */
  renderVisual?: RenderVisual;
  /** Native visuals this row currently owns (live copies win during handoff). */
  uiVisuals?: readonly ChatUiVisualV1[];
  /** Stable; receives the owning message so local state can be remembered. */
  renderSettledUiVisual?: (visual: ChatUiVisualV1, message: ChatMessage) => React.ReactNode;
}

/**
 * One persisted transcript message. Memoized so streaming frames, which change
 * only the live row, do not re-render or re-derive settled history.
 */
const SettledMessageRow = React.memo(function SettledMessageRow({
  chatId,
  deferOffscreenLayout,
  message,
  live,
  readAloud,
  failureActions,
  subagentsEnabled,
  onOpenSubagent,
  onFork,
  forkDisabledReason,
  onForkWithSummary,
  visuals,
  renderVisual,
  uiVisuals,
  renderSettledUiVisual,
}: SettledMessageRowProps) {
  const placements = message?.htmlArtifactPlacements;
  const visualPlacements = React.useMemo(
    () => new Map((placements ?? []).map((p) => [p.mediaId, p.toolCallId])),
    [placements],
  );
  const wideVisuals = React.useMemo(
    () => new Set((placements ?? []).flatMap((p) => (p.layout === "wide" ? [p.mediaId] : []))),
    [placements],
  );
  const renderUiVisual = React.useCallback<RenderUiVisual>(
    (visual) => (message ? renderSettledUiVisual?.(visual, message) : null),
    [message, renderSettledUiVisual],
  );
  const fork = React.useMemo<MessageForkAction | undefined>(() => {
    if (!message || !onFork || (message.role !== "user" && message.role !== "assistant") || message.notice) {
      return undefined;
    }
    const position: ChatForkPosition = message.role === "user" ? "before" : "after";
    return {
      onFork: () => onFork(message.id, position),
      ...(onForkWithSummary
        ? { onForkWithSummary: () => onForkWithSummary(message.id, position) }
        : {}),
      disabledReason: forkDisabledReason,
    };
  }, [forkDisabledReason, message, onFork, onForkWithSummary]);
  const assistant = Boolean(live) || message?.role === "assistant";
  const imageActions = React.useMemo(() => ({ chatId }), [chatId]);
  const storedImagePlacements = message?.imagePlacements;
  const messageTimeline = message?.role === "assistant" ? message.timeline : undefined;
  const messageAttachments = message?.attachments;
  const imagePlacements = React.useMemo(
    () =>
      withInferredImagePlacements(
        messageTimeline,
        messageAttachments ?? [],
        new Map((storedImagePlacements ?? []).map((p) => [p.attachmentId, p.toolCallId])),
      ),
    [messageAttachments, messageTimeline, storedImagePlacements],
  );
  const row = (
    <div data-transcript-reply={assistant ? "" : undefined} className={deferOffscreenLayout && !visuals?.length && !uiVisuals?.length && !message?.attachments?.length && !message?.appPanels?.length
      ? "transcript-settled-contained flex min-w-0 flex-col gap-3" : "flex min-w-0 flex-col gap-3"}>
      {live ? (
        <AssistantResponse {...live} streaming />
      ) : !message ? null : message.role === "assistant" ? (
        <>
          <AssistantResponse
            content={message.content}
            timeline={message.timeline}
            reasoning={message.reasoning}
            // Snapshots exist for phones; this desktop draws the visual itself.
            attachments={attachmentsShownWithVisuals(message)}
            readAloud={readAloud}
            footer={settledTurnFooter(message)}
            fork={fork}
            imageActions={imageActions}
            imagePlacements={imagePlacements}
            subagentChips={
              subagentsEnabled && message.subagents ? (
                <SubagentChips reference={message.subagents} onOpen={onOpenSubagent} />
              ) : undefined
            }
            visuals={visuals}
            visualPlacements={visualPlacements}
            wideVisuals={wideVisuals}
            renderVisual={renderVisual}
            uiVisuals={uiVisuals}
            renderUiVisual={renderSettledUiVisual ? renderUiVisual : undefined}
          />
          {message.appPanels?.map((panel) => <AppControlsPanel key={panel.id} panel={panel} chatId={chatId} />)}
          {message.providerFailure ? (
            <ProviderFailureCallout failure={message.providerFailure} actions={failureActions} />
          ) : null}
        </>
      ) : message.notice ? (
        <AgentNoticeCard notice={message.notice} content={message.content} />
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
  // A reply keeps its wrapper before it can fork, so settling does not remount it.
  if (!fork && !assistant) return row;
  return (
    <MessageForkContextMenu action={fork} kind={assistant ? "fork" : "edit"}>
      {row}
    </MessageForkContextMenu>
  );
});

export interface ProviderFailureActions {
  onAction: (action: ProviderFailureAction) => void;
  onSwitchModel?: () => void;
  /**
   * Which actions this chat can take. A chat on a paired Mac can try again or
   * continue, but compaction and provider settings live on that Mac. Omitted
   * means every action.
   */
  supports?: (action: ProviderFailureAction) => boolean;
  /** An action is already running; the buttons wait for it. */
  busy?: boolean;
}

export type InterruptedReplyActions = {
  onResume: () => void;
  /** True while Resume is sending. */
  busy?: boolean;
};

/** Shown after the last message when Aiden quit or crashed mid-reply; Resume is never automatic. */
export function InterruptedReplyCallout({ actions }: { actions: InterruptedReplyActions }) {
  return (
    <Callout role="status" data-interrupted-reply="true">
      <Text variant="small-strong">This reply was interrupted</Text>
      <Text variant="small" color="secondary" className="mt-0.5 block">
        Aiden closed before it finished. Resume to pick up where it stopped.
      </Text>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="small" disabled={actions.busy} onClick={actions.onResume}>
          Resume
        </Button>
      </div>
    </Callout>
  );
}

export function ProviderFailureCallout({
  failure,
  actions,
}: {
  failure: ProviderFailureV1;
  actions?: ProviderFailureActions;
}) {
  const presentation = providerFailurePresentation(failure);
  const action = providerFailureAction(failure);
  return (
    <Callout color="red" role="alert" aria-atomic="true" data-provider-failure={failure.category}>
      <Text variant="small-strong" color="red">
        {presentation.title}
      </Text>
      <Text variant="small" color="secondary" className="mt-0.5 block">
        {presentation.description}
      </Text>
      {actions && (actions.supports?.(action) !== false || actions.onSwitchModel) ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actions.supports?.(action) !== false ? (
            <Button
              size="small"
              disabled={actions.busy}
              data-provider-failure-action={action}
              onClick={() => actions.onAction(action)}
            >
              {PROVIDER_FAILURE_ACTION_LABELS[action]}
            </Button>
          ) : null}
          {actions.onSwitchModel ? (
            <Button variant="transparent" size="small" disabled={actions.busy} onClick={actions.onSwitchModel}>
              Switch model
            </Button>
          ) : null}
        </div>
      ) : null}
    </Callout>
  );
}

const UI_STATE_SAVE_DELAY_MS = 800;

function stateKeysAreWireSafe(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.every((item) => stateKeysAreWireSafe(item, depth + 1));
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, inner]) => isWireSafeKey(key) && stateKeysAreWireSafe(inner, depth + 1));
}
const pendingUiStateSaves = new Map<string, ReturnType<typeof setTimeout>>();

/** Remember a visual's local state shortly after the user stops changing it. */
function scheduleUiVisualStateSave(chatId: string, messageId: string, visualId: string, state: Record<string, unknown>) {
  // State the store would refuse (too large, or holding a reserved key) stays local.
  const json = JSON.stringify(state);
  if (new TextEncoder().encode(json).length > AIDEN_UI_LIMITS.stateBytes || !stateKeysAreWireSafe(state)) return;
  const key = `${chatId}\u0000${messageId}\u0000${visualId}`;
  const pending = pendingUiStateSaves.get(key);
  if (pending) clearTimeout(pending);
  pendingUiStateSaves.set(
    key,
    setTimeout(() => {
      pendingUiStateSaves.delete(key);
      void chatsApi.updateUiVisualState(chatId, messageId, visualId, state).catch(() => undefined);
    }, UI_STATE_SAVE_DELAY_MS),
  );
}

/**
 * A reply is keyed by the message it answers, which is known before the reply
 * is persisted: the live row and its saved message share one React identity.
 */
function replyRowKey(previous: ChatMessage | undefined): string {
  return `reply:${previous?.id ?? "start"}`;
}

function transcriptRowKey(message: ChatMessage, previous: ChatMessage | undefined): string {
  return message.role === "assistant" ? replyRowKey(previous) : `message:${message.id}`;
}

export function MessageList({
  chatId,
  messages,
  streamingText,
  streamingReasoning,
  streamingArtifacts = EMPTY_CHAT_ARTIFACTS,
  streamingArtifactPlacements = EMPTY_PLACEMENTS,
  streamingWideVisuals = EMPTY_WIDE_VISUALS,
  streamingVisualDrafts,
  streamingUiVisuals = EMPTY_UI_VISUALS,
  streamingUiDrafts = EMPTY_UI_DRAFTS,
  onVisualPrompt,
  visualFollowUpBusy = false,
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
  failureActions,
  interruptedReply,
  readAloud,
  onFork,
  forkDisabledReason = null,
  onForkWithSummary,
  forkSummary,
  forkBeforeFirstPrompt = true,
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
  const settledReplyKeysRef = React.useRef<ReadonlySet<string>>(new Set());
  const liveKeyRef = React.useRef<{ base: string; key: string } | null>(null);
  const handedOffKeysRef = React.useRef(new Map<string, string>());
  const liveRunRef = React.useRef<{ promptId: string; handoffId: string | null } | null>(null);
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
    const seenIds = new Set<string>();

    // Add attachments from streaming artifacts that aren't persisted elsewhere
    for (const artifact of streamingArtifacts) {
      if (!isChatImageArtifact(artifact)) continue;
      if (!persistedAttachmentIds.has(artifact.attachment.id)) {
        attachments.push(artifact.attachment);
        seenIds.add(artifact.attachment.id);
      }
    }

    // During handoff, include attachments from the persisted message that's being suppressed
    // so they're shown exactly once in the live row instead of disappearing
    if (persistedHandoffMessageId) {
      const persistedMessage = messages.find((m) => m.id === persistedHandoffMessageId);
      if (persistedMessage?.attachments) {
        for (const attachment of persistedMessage.attachments) {
          // Only add if not already included from streaming artifacts
          if (!seenIds.has(attachment.id)) {
            attachments.push(attachment);
            seenIds.add(attachment.id);
          }
        }
      }
    }

    return attachments;
  }, [persistedAttachmentIds, streamingArtifacts, persistedHandoffMessageId, messages]);
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
      liveHtmlArtifacts.length > 0 ||
      streamingUiVisuals.length > 0 ||
      streamingUiDrafts.size > 0,
  );
  const htmlArtifactPlan = React.useMemo(
    () => htmlArtifactTranscriptPlan(messages, liveHtmlArtifacts, streamingRowVisible),
    [liveHtmlArtifacts, messages, streamingRowVisible],
  );
  // The plan decides which anchor owns each artifact (live copies win during
  // handoff); the owning response then places it after its tool row.
  const previousArtifactsByAnchor = React.useRef<Map<string, ChatHtmlArtifactV1[]> | undefined>(
    undefined,
  );
  const htmlArtifactsByAnchor = React.useMemo(() => {
    const entries = new Map<string, ChatHtmlArtifactV1[]>();
    for (const entry of htmlArtifactPlan) {
      const anchored = entries.get(entry.anchor) ?? [];
      anchored.push(entry.artifact);
      entries.set(entry.anchor, anchored);
    }
    return reuseUnchangedArtifactLists(previousArtifactsByAnchor.current, entries);
  }, [htmlArtifactPlan]);
  React.useEffect(() => {
    previousArtifactsByAnchor.current = htmlArtifactsByAnchor;
  }, [htmlArtifactsByAnchor]);
  const liveUiIds = React.useMemo(() => new Set(streamingUiVisuals.map((visual) => visual.id)), [streamingUiVisuals]);
  const previousUiByMessage = React.useRef<Map<string, ChatUiVisualV1[]> | undefined>(undefined);
  const uiByMessage = React.useMemo(
    () => reuseUnchangedUiLists(previousUiByMessage.current, uiVisualsByMessage(messages, liveUiIds, streamingRowVisible)),
    [liveUiIds, messages, streamingRowVisible],
  );
  React.useEffect(() => {
    previousUiByMessage.current = uiByMessage;
  }, [uiByMessage]);
  const onVisualPromptRef = React.useRef(onVisualPrompt);
  React.useLayoutEffect(() => {
    onVisualPromptRef.current = onVisualPrompt;
  }, [onVisualPrompt]);
  const stableVisualPrompt = React.useCallback<GuestPromptHandler>(
    (text, mediaId) => onVisualPromptRef.current?.(text, mediaId),
    [],
  );
  const renderVisual = React.useCallback(
    (artifact: ChatHtmlArtifactV1, placementCallId?: string, layout?: HtmlArtifactLayout) => (
      <HtmlArtifactFrame
        key={`html:${artifact.mediaId}`}
        chatId={chatId}
        artifact={artifact}
        onGuestPrompt={stableVisualPrompt}
        followUpBusy={visualFollowUpBusy}
        placementCallId={placementCallId}
        layout={layout}
      />
    ),
    [chatId, stableVisualPrompt, visualFollowUpBusy],
  );

  const renderLiveUiVisual = React.useCallback<RenderUiVisual>(
    (visual, draft) => (
      <AidenUiBlock
        key={`ui:${visual.id}`}
        visual={visual}
        draft={draft}
        followUpBusy={visualFollowUpBusy}
        onAction={(action) => {
          if (action.kind === "send") stableVisualPrompt(action.text, visual.id);
        }}
      />
    ),
    [stableVisualPrompt, visualFollowUpBusy],
  );
  const renderSettledUiVisual = React.useCallback(
    (visual: ChatUiVisualV1, message: ChatMessage) => (
      <AidenUiBlock
        key={`ui:${visual.id}`}
        visual={visual}
        attachments={message.attachments}
        followUpBusy={visualFollowUpBusy}
        onAction={(action) => {
          if (action.kind === "send") stableVisualPrompt(action.text, visual.id);
        }}
        onStateChange={(state) => scheduleUiVisualStateSave(chatId, message.id, visual.id, state)}
      />
    ),
    [chatId, stableVisualPrompt, visualFollowUpBusy],
  );

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


  const transcriptRows: React.ReactNode[] = [];
  const summaryRows = forkWithSummaryEnabled ? forkSummaryRows(messages) : null;
  const unforkablePromptId =
    forkEnabled && !forkBeforeFirstPrompt ? messages.find((message) => message.role === "user")?.id : undefined;
  // The persisted copy of the reply still on screen waits until the live row
  // hands over, then takes the live row's key: one reply, settled in place.
  const settlingMessageId = streamingRowVisible ? persistedHandoffMessageId : null;
  const settlingIndex = settlingMessageId
    ? messages.findIndex((message) => message.id === settlingMessageId)
    : -1;
  // The live row stands where its saved message will be, keyed by the message
  // it answers: the prompt it started from stays its key while steering
  // guidance or a queued prompt is saved before the handoff. A run whose
  // handoff has finished gives way to the next one.
  if (!streamingRowVisible || (liveRunRef.current?.handoffId && liveRunRef.current.handoffId !== settlingMessageId)) {
    liveRunRef.current = null;
  }
  const startedFrom = liveRunRef.current
    ? messages.find((message) => message.id === liveRunRef.current?.promptId)
    : undefined;
  const promptMessageForLiveRow =
    startedFrom ?? (settlingIndex >= 0 ? messages[settlingIndex - 1] : messages[messages.length - 1]);
  // Every saved row's key is settled before the live row picks its own, so the
  // two never collide in one render.
  const settledRowKeys = new Map<string, string>();
  const settledReplyKeys = new Set<string>();
  {
    let previous: ChatMessage | undefined;
    for (const message of messages) {
      if (message.id !== settlingMessageId) {
        const key = handedOffKeysRef.current.get(message.id) ?? transcriptRowKey(message, previous);
        settledRowKeys.set(message.id, key);
        if (message.role === "assistant") settledReplyKeys.add(key);
      }
      previous = message;
    }
  }
  const liveBaseKey = replyRowKey(promptMessageForLiveRow);
  let liveKey = liveBaseKey;
  if (streamingRowVisible) {
    if (!liveRunRef.current && promptMessageForLiveRow) {
      liveRunRef.current = { promptId: promptMessageForLiveRow.id, handoffId: null };
    }
    if (liveRunRef.current && settlingMessageId) liveRunRef.current.handoffId = settlingMessageId;
    const held = liveKeyRef.current;
    if (held?.base === liveBaseKey && !settledReplyKeys.has(held.key)) {
      liveKey = held.key;
    } else {
      // A new reply to a prompt that already has a saved reply (a regenerated
      // answer) starts fresh instead of inheriting that reply's open sections,
      // and a saved reply that arrives without taking the live row's place (its
      // text differs from what streamed) leaves the live row a key of its own.
      for (
        let n = 1;
        settledReplyKeysRef.current.has(liveKey) || settledReplyKeys.has(liveKey);
        n += 1
      ) {
        liveKey = `${liveBaseKey}~${n}`;
      }
    }
    liveKeyRef.current = { base: liveBaseKey, key: liveKey };
    if (settlingMessageId) handedOffKeysRef.current.set(settlingMessageId, liveKey);
  } else {
    liveKeyRef.current = null;
  }
  const liveRow = streamingRowVisible ? (
    <SettledMessageRow
      key={liveKey}
      live={{
        content: streamingText ?? "",
        timeline,
        reasoning: streamingReasoning,
        attachments: liveAttachments,
        subagentChips:
          subagentsEnabled && liveSubagents.length > 0 ? (
            <SubagentChips runs={liveSubagents} onOpen={onOpenSubagent} />
          ) : undefined,
        streamComplete,
        onStreamHandoffComplete,
        visuals: htmlArtifactsByAnchor.get("streaming"),
        visualPlacements: streamingArtifactPlacements,
        imagePlacements: streamingArtifactPlacements,
        wideVisuals: streamingWideVisuals,
        visualDrafts: streamingVisualDrafts,
        renderVisual,
        uiVisuals: streamingUiVisuals,
        uiDrafts: streamingUiDrafts,
        renderUiVisual: renderLiveUiVisual,
      }}
      chatId={chatId}
      subagentsEnabled={subagentsEnabled}
      onOpenSubagent={onOpenSubagent}
    />
  ) : null;

  for (const [messageIndex, message] of messages.entries()) {
    if (message.id === settlingMessageId) {
      transcriptRows.push(liveRow);
      continue;
    }
    transcriptRows.push(
      <SettledMessageRow
        key={settledRowKeys.get(message.id)}
        chatId={chatId}
        deferOffscreenLayout={messageIndex < messages.length - 32}
        message={message}
        readAloud={readAloudMessageId === message.id ? readAloud : undefined}
        failureActions={failureActions?.messageId === message.id ? failureActions : undefined}
        subagentsEnabled={subagentsEnabled}
        onOpenSubagent={onOpenSubagent}
        onFork={forkEnabled && message.id !== unforkablePromptId ? stableOnFork : undefined}
        forkDisabledReason={forkDisabledReason}
        onForkWithSummary={summaryRows?.has(message.id) ? stableOnForkWithSummary : undefined}
        visuals={htmlArtifactsByAnchor.get(`message:${message.id}`)}
        renderVisual={renderVisual}
        uiVisuals={uiByMessage.get(message.id)}
        renderSettledUiVisual={renderSettledUiVisual}
      />,
    );
    if (forkSummary?.afterMessageId === message.id) {
      transcriptRows.push(<React.Fragment key="fork-summary">{forkSummary.node}</React.Fragment>);
    }
  }

  if (streamingRowVisible && settlingIndex < 0) transcriptRows.push(liveRow);
  if (interruptedReply && !streamingRowVisible) {
    transcriptRows.push(<InterruptedReplyCallout key="interrupted-reply" actions={interruptedReply} />);
  }
  React.useLayoutEffect(() => {
    settledReplyKeysRef.current = settledReplyKeys;
  });

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
  }, [activity?.phase, activity?.label, activity?.mark, current]);

  if (!current) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      // One fixed-height line: the label swaps on presentation timers, and a
      // wrapping label would move the bottom edge the transcript follows.
      className="agent-activity-layer agent-event-in flex h-6 w-fit max-w-full items-center gap-2"
      data-agent-activity={current.phase}
    >
      <AidenActivityMark mark={current.mark} size={20} className="shrink-0 text-primary" />
      <Text
        variant="small"
        color="secondary"
        title={current.label}
        className={
          current.phase === "thinking" ||
          current.phase === "loading" ||
          current.phase === "visualizing"
            ? "agent-thinking-shimmer min-w-0 truncate"
            : "min-w-0 truncate"
        }
      >
        {current.label}
      </Text>
    </div>
  );
}
