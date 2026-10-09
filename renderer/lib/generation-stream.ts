// Owner-filtered notifications for one generation stream. ChatPane's
// startGeneration and Design Studio both subscribe here before invoking main,
// so no opening tokens are dropped (ADR-DS §5).
import { parseAgentsInstructionNotices } from "../shared/agents-instructions-notice";
import { parseAskUserQuestionPrompt, type AskUserQuestionPromptV1 } from "../shared/ask-user-question";
import { chatArtifactIdentity, parseChatArtifactEventV1, type ChatArtifactV1 } from "../shared/chat-artifacts";
import { parseChatContextPressureNotification } from "../shared/context-pressure";
import type { ChatTimelineNotification, GenerationTimeline } from "../shared/generation-timeline";
import { parseSubagentRunSnapshot, type SubagentRunSnapshot } from "../shared/subagent-runs";
import { parseToolApprovalScope } from "../shared/tool-approval-scope";
import { parseTodoSnapshotView } from "../shared/todo";
import { restoreUndeliveredGuidance, undeliveredGuidanceFromTerminal } from "./composer-draft-store";
import type { ApprovalPrompt, ChatStatusPhase, StreamCallbacks, ToolPhase } from "./ipc";
import { onNotification } from "./ipc-bridge";
import { mergeSubagentSnapshots } from "./subagent-view-state";
import type { Chat } from "./types";

interface ChatDelta {
  streamId: string;
  delta: string;
  /** Discard deltas from a failed overflow attempt before its retry starts. */
  reset?: boolean;
}
interface ChatReasoningDelta {
  streamId: string;
  delta: string;
}
interface ChatArtifactNotification {
  streamId: string;
  event: unknown;
}
interface ChatStatus {
  streamId: string;
  phase: ChatStatusPhase | "agents_instructions_limited";
  notices?: unknown;
}
interface ChatDone {
  streamId: string;
  content: string;
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
  undeliveredGuidance?: string[];
}
interface ChatError {
  streamId: string;
  message: string;
  content?: string;
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
  undeliveredGuidance?: string[];
}
interface ChatTool {
  streamId: string;
  phase: ToolPhase;
  toolName: string;
}
interface ChatApproval extends ApprovalPrompt {
  streamId: string;
}
type ChatQuestionnaire = AskUserQuestionPromptV1;
interface ChatSubagents {
  streamId: string;
  snapshot: unknown;
}
interface ChatTodo {
  streamId: string;
  snapshot: unknown;
}

export interface GenerationStreamScope {
  chatId: string;
  workspaceId?: string;
}

export interface GenerationStreamProjection {
  content: string;
  lastTextDeltaAt: number | null;
  reasoning: string;
  timeline: GenerationTimeline | null;
  artifacts: ChatArtifactV1[];
  subagents: SubagentRunSnapshot[];
}

export interface GenerationStreamSubscription {
  dispose(): void;
  projection(): GenerationStreamProjection;
}

export function subscribeGenerationStream(
  streamId: string,
  scope: GenerationStreamScope,
  callbacks: StreamCallbacks,
): GenerationStreamSubscription {
  let projectedContent = "";
  let projectedLastTextDeltaAt: number | null = null;
  let projectedReasoning = "";
  let projectedTimeline: GenerationTimeline | null = null;
  let projectedArtifacts: ChatArtifactV1[] = [];
  let projectedSubagents: SubagentRunSnapshot[] = [];
  const unsubs: Array<() => void> = [];
  const dispose = () => {
    for (const u of unsubs) u();
    unsubs.length = 0;
  };

  unsubs.push(
    onNotification<ChatDelta>("chat:delta", (p) => {
      if (p.streamId !== streamId) return;
      if (p.reset) {
        projectedContent = "";
        projectedLastTextDeltaAt = null;
        projectedReasoning = "";
        callbacks.onReset?.();
      } else {
        projectedContent += p.delta;
        if (p.delta) projectedLastTextDeltaAt = Date.now();
        callbacks.onDelta(p.delta);
      }
    }),
  );
  unsubs.push(
    onNotification<ChatReasoningDelta>("chat:reasoning-delta", (p) => {
      if (p.streamId === streamId) {
        projectedReasoning += p.delta;
        callbacks.onReasoningDelta?.(p.delta);
      }
    }),
  );
  unsubs.push(
    onNotification<ChatStatus>("chat:status", (p) => {
      if (p.streamId !== streamId) return;
      if (p.phase === "agents_instructions_limited") {
        const notices = parseAgentsInstructionNotices(p.notices);
        if (notices) callbacks.onAgentsInstructionNotices?.(notices);
      } else {
        callbacks.onStatus?.(p.phase);
      }
    }),
  );
  unsubs.push(
    onNotification<unknown>("chat:context-pressure", (p) => {
      const event = parseChatContextPressureNotification(p);
      if (event && event.streamId === streamId) {
        callbacks.onContextPressure?.(event.pressure);
      }
    }),
  );
  unsubs.push(
    onNotification<ChatDone>("chat:done", (p) => {
      if (p.streamId !== streamId) return;
      restoreUndeliveredGuidance(scope.chatId, undeliveredGuidanceFromTerminal(p));
      void Promise.resolve(callbacks.onDone(p.content, p.timeline, p.chat, p.reasoning))
        .catch((error: unknown) =>
          callbacks.onError(error instanceof Error ? error.message : String(error)),
        )
        .finally(dispose);
    }),
  );
  unsubs.push(
    onNotification<ChatError>("chat:error", (p) => {
      if (p.streamId !== streamId) return;
      restoreUndeliveredGuidance(scope.chatId, undeliveredGuidanceFromTerminal(p));
      callbacks.onError(p.message, p.content, p.timeline, p.chat, p.reasoning);
      dispose();
    }),
  );
  unsubs.push(
    onNotification<ChatTimelineNotification>("chat:timeline", (p) => {
      if (p.streamId === streamId) {
        projectedTimeline = p.timeline;
        callbacks.onTimeline?.(p.timeline);
      }
    }),
  );
  if (callbacks.onArtifactEvent) {
    unsubs.push(
      onNotification<ChatArtifactNotification>("chat:artifact", (p) => {
        if (p.streamId !== streamId) return;
        const event = parseChatArtifactEventV1(p.event);
        if (!event) return;
        if (event.operation === "reset") {
          projectedArtifacts = [];
        } else if (event.operation === "present") {
          const identity = chatArtifactIdentity(event.artifact);
          const index = projectedArtifacts.findIndex(
            (candidate) => chatArtifactIdentity(candidate) === identity,
          );
          projectedArtifacts =
            index >= 0
              ? projectedArtifacts.map((candidate, i) => (i === index ? event.artifact : candidate))
              : [...projectedArtifacts, event.artifact];
        }
        callbacks.onArtifactEvent?.(event);
      }),
    );
  }
  if (callbacks.onSubagents) {
    unsubs.push(
      onNotification<ChatSubagents>("chat:subagents", (p) => {
        if (p.streamId !== streamId) return;
        const snapshot = parseSubagentRunSnapshot(p.snapshot);
        if (snapshot?.generationId === streamId) {
          projectedSubagents = mergeSubagentSnapshots(projectedSubagents, [snapshot], {
            chatId: scope.chatId,
            workspaceId: scope.workspaceId ?? "default",
          });
          callbacks.onSubagents?.(snapshot);
        }
      }),
    );
  }
  unsubs.push(
    onNotification<ChatTool>("chat:tool", (p) => {
      if (p.streamId === streamId) callbacks.onTool?.(p.phase, p.toolName);
    }),
  );
  unsubs.push(
    onNotification<ChatApproval>("chat:approval", (p) => {
      if (p.streamId === streamId)
        callbacks.onApproval?.({
          approvalId: p.approvalId,
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          summary: p.summary,
          details: p.details,
          // Offered allow scopes ("this chat", "always"); absent means once only.
          ...(Array.isArray(p.scopes) ? { scopes: p.scopes.filter((entry) => parseToolApprovalScope(entry)) } : {}),
          ...(typeof p.canAllow === "boolean" ? { canAllow: p.canAllow } : {}),
        });
    }),
  );
  unsubs.push(
    onNotification<ChatQuestionnaire>("chat:questionnaire", (payload) => {
      if (payload.streamId !== streamId) return;
      const prompt = parseAskUserQuestionPrompt(payload);
      if (prompt) callbacks.onQuestionnaire?.(prompt);
    }),
  );
  if (callbacks.onTodo) {
    unsubs.push(
      onNotification<ChatTodo>("chat:todo", (payload) => {
        if (payload.streamId !== streamId) return;
        const snapshot = parseTodoSnapshotView(payload.snapshot);
        if (snapshot?.chatId === scope.chatId) callbacks.onTodo?.(snapshot);
      }),
    );
  }

  return {
    dispose,
    projection: () => ({
      content: projectedContent,
      lastTextDeltaAt: projectedLastTextDeltaAt,
      reasoning: projectedReasoning,
      timeline: projectedTimeline,
      artifacts: projectedArtifacts,
      subagents: projectedSubagents,
    }),
  };
}
