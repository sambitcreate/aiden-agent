// Shared contracts for handing off drafts and live desktop streams from the
// Floating Chat Starter / Mini-Modal to the Main Aiden window.

import type { AskUserQuestionPromptV1 } from "./ask-user-question.js";
import type { ChatArtifactV1 } from "./chat-artifacts.js";
import type { ChatUiVisualV1 } from "./aiden-ui/types.js";
import type { ChatContextPressureV1 } from "./context-pressure.js";
import type { GenerationTimeline } from "./generation-timeline.js";
import type { SubagentRunSnapshot } from "./subagent-runs.js";
import type { TodoSnapshotViewV1 } from "./todo.js";
import type { ToolApprovalDetails } from "./assistant.js";
import type { ToolApprovalPreview } from "./tool-approval-preview.js";
import type { ToolApprovalScope } from "./tool-approval-scope.js";

export interface HandoffApprovalPrompt {
  streamId: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  details?: ToolApprovalDetails;
  preview?: ToolApprovalPreview;
  scopes?: readonly ToolApprovalScope[];
  autoWouldJudge?: true;
}

export interface HandoffQueuedMessage {
  content: string;
  attachments?: unknown[];
}

export interface DesktopHandoffLiveStreamSnapshot {
  streamId: string;
  chatId: string;
  workspaceId: string;
  content: string;
  reasoning: string;
  timeline: GenerationTimeline | null;
  artifacts: ChatArtifactV1[];
  uiVisuals: ChatUiVisualV1[];
  subagents: SubagentRunSnapshot[];
  todoSnapshot: TodoSnapshotViewV1 | null;
  contextPressure: ChatContextPressureV1 | null;
  pendingApprovals: HandoffApprovalPrompt[];
  pendingQuestions: AskUserQuestionPromptV1[];
}

export interface ClaimedDraftHandoff {
  kind: "draft";
  ticketId: string;
  workspaceId: string;
  text: string;
  attachments: unknown[];
  providerId?: string;
  model?: string;
}

export interface ClaimedChatHandoff {
  kind: "chat";
  chatId: string;
  liveStream: DesktopHandoffLiveStreamSnapshot | null;
  draftText?: string;
  draftAttachments?: unknown[];
  queuedMessages?: HandoffQueuedMessage[];
}

export type ClaimedDesktopHandoff = ClaimedDraftHandoff | ClaimedChatHandoff;

export interface ClaimHandoffRequest {
  chatId?: string;
  ticketId?: string;
}

const CLAIM_KEYS = new Set(["chatId", "ticketId"]);

export function parseClaimHandoffRequest(input: unknown): ClaimHandoffRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid handoff claim request.");
  }
  const record = input as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (!CLAIM_KEYS.has(key)) throw new Error("Invalid handoff claim fields.");
  }
  const chatId = typeof record.chatId === "string" && record.chatId.trim() ? record.chatId.trim() : undefined;
  const ticketId = typeof record.ticketId === "string" && record.ticketId.trim() ? record.ticketId.trim() : undefined;
  if (!chatId && !ticketId) {
    throw new Error('Expected either "chatId" or "ticketId" to claim a handoff.');
  }
  return { ...(chatId ? { chatId } : {}), ...(ticketId ? { ticketId } : {}) };
}
