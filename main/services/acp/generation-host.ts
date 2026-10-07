/**
 * Adapt one attended desktop generation to the ACP host contract: approvals
 * use Aiden's approval card, agent questions use the structured question
 * prompt, and native agent activity becomes timeline steps that persist on the
 * assistant message and reach the native clients.
 */
import type { Tool } from "@earendil-works/pi-ai";

import type {
  AskUserQuestionResponseV1,
  AskUserQuestionV1,
} from "../../../renderer/shared/ask-user-question.js";
import type { ToolApprovalScope } from "../../../renderer/shared/tool-approval-scope.js";
import type { AgentStepStatus } from "../../../renderer/shared/generation-timeline.js";
import type { ToolApprovalOutcome } from "../tool-approval.js";
import type { AcpRootIdentity } from "./client-files.js";
import type { AcpHostPermission, AcpQuestion } from "./harness.js";
import type { AcpApprovalOutcome, AcpApprovalRequest, AcpTurnHost } from "./host.js";

/** Aiden's own tools that duplicate the agent's built-in file and shell tools. */
export const AGENT_DUPLICATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "run_command",
]);

export const CONTEXT_REBUILT_STEP = "agent_context_rebuilt";

export interface GenerationTimelinePort {
  toolStarted(toolCallId: string, toolName: string, args: unknown): void;
  toolRunning(toolCallId: string): void;
  toolAwaitingApproval(toolCallId: string): void;
  toolFinished(
    toolCallId: string,
    status: Extract<AgentStepStatus, "completed" | "failed" | "blocked" | "cancelled">,
    resultDetails?: unknown,
  ): void;
  publicToolCallId(toolCallId: string): string | undefined;
}

export interface AcpGenerationHostOptions {
  chatId: string;
  streamId: string;
  label: string;
  /** The chat's folder, or undefined for a chat without one. */
  folderPath: string | undefined;
  /** The folder's identity, captured when the turn started; required for any file access. */
  folderIdentity?: AcpRootIdentity;
  /** Working directory for chats without a folder; it grants no file access. */
  scratchDir: string;
  permission(): AcpHostPermission;
  timeline: GenerationTimelinePort;
  requestApproval(
    prompt: { streamId: string; toolCallId: string; toolName: string; summary: string; scopes?: readonly ToolApprovalScope[] },
    signal: AbortSignal,
  ): Promise<ToolApprovalOutcome>;
  /** The scope the user chose on a settled approval card. */
  takeApprovalScope(streamId: string, publicToolCallId: string): ToolApprovalScope | undefined;
  requestQuestion?(
    toolCallId: string,
    questions: AskUserQuestionV1[],
    signal: AbortSignal,
  ): Promise<AskUserQuestionResponseV1>;
}

const CARD_TOOL: Record<AcpApprovalRequest["kind"], string> = {
  command: "run_command",
  file_change: "edit_file",
  file_read: "read_file",
  fetch: "web_fetch",
  other: "agent_tool",
};

const VERB: Record<AcpApprovalRequest["kind"], string> = {
  command: "run a command",
  file_change: "change files",
  file_read: "read files",
  fetch: "fetch from the web",
  other: "use a tool",
};

export function approvalSummary(label: string, request: AcpApprovalRequest): string {
  const lines = [`${label} wants to ${VERB[request.kind]}: ${request.title}`];
  if (request.paths.length > 0) lines.push(`Files: ${request.paths.join(", ")}`);
  if (request.warning) lines.push(`Warning from ${label}: ${request.warning}`);
  return lines.join("\n");
}

const RESERVED_LABELS = new Set(["Other", "Type something.", "Next"]);
const MAX_LABEL = 60;

function promptLabel(label: string, index: number, used: Set<string>): string {
  let candidate = Array.from(label.replace(/\s+/gu, " ").trim()).slice(0, MAX_LABEL).join("").trim();
  if (!candidate || RESERVED_LABELS.has(candidate) || used.has(candidate)) {
    const suffix = ` (${index + 1})`;
    candidate = `${Array.from(candidate || "Option").slice(0, MAX_LABEL - suffix.length).join("")}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Map an agent question (2–4 fixed choices) onto Aiden's question prompt,
 * meeting its contract: bounded unique labels that avoid the composer's
 * reserved ones, and a non-empty description per option. Returns the label
 * each agent option is shown as, so the answer maps back exactly.
 */
export function questionFor(
  question: AcpQuestion,
): { question: AskUserQuestionV1; labels: Map<string, string> } | undefined {
  const options = question.options.slice(0, 4);
  if (options.length < 2) return undefined;
  const used = new Set<string>();
  const labels = new Map<string, string>();
  const mapped = options.map((option, index) => {
    const label = promptLabel(option.label, index, used);
    labels.set(label, option.id);
    return { label, description: option.label.trim() || label };
  });
  return {
    question: {
      question: question.title.trim().slice(0, 1_000) || "Choose an option.",
      header: "Question",
      multiSelect: false,
      options: mapped,
    },
    labels,
  };
}

export function createAcpGenerationHost(options: AcpGenerationHostOptions): AcpTurnHost {
  let notices = 0;
  return {
    chatId: options.chatId,
    cwd: options.folderPath ?? options.scratchDir,
    // Fail closed: without the identity captured at turn start there is no
    // file access at all, never a fallback to the mutable pathname.
    roots: options.folderIdentity && options.permission() !== "none" ? [options.folderIdentity] : [],
    permission: options.permission,
    async requestApproval(request, signal): Promise<AcpApprovalOutcome> {
      const id = request.activityId ?? request.toolCallId;
      // The activity row exists already; mark it waiting on the card.
      options.timeline.toolAwaitingApproval(id);
      const publicId = options.timeline.publicToolCallId(id) ?? id;
      const outcome = await options.requestApproval(
        {
          streamId: options.streamId,
          toolCallId: publicId,
          toolName: CARD_TOOL[request.kind],
          summary: approvalSummary(options.label, request),
          ...(request.offersAlways ? { scopes: ["once", "chat"] as const } : {}),
        },
        signal,
      );
      if (outcome === "allowed") {
        options.timeline.toolRunning(id);
        return options.takeApprovalScope(options.streamId, publicId) === "chat" ? "allow_always" : "allow_once";
      }
      if (outcome === "denied") return "reject";
      return "cancelled";
    },
    ...(options.requestQuestion
      ? {
          async askQuestion(question, signal) {
            const mapped = questionFor(question);
            if (!mapped) return undefined;
            const response = await options.requestQuestion!(`acp-question-${Date.now()}`, [mapped.question], signal);
            const answer = response.answers[0];
            if (response.cancelled || !answer || answer.kind !== "option") return undefined;
            return mapped.labels.get(answer.answer);
          },
        }
      : {}),
    activity: {
      started: (id, toolName, args) => options.timeline.toolStarted(id, toolName, args),
      running: (id) => options.timeline.toolRunning(id),
      finished: (id, status, details) => options.timeline.toolFinished(id, status, details),
    },
    bridgeableTools(tools: readonly Tool[]): Tool[] {
      return tools.filter((tool) => !AGENT_DUPLICATED_TOOL_NAMES.has(tool.name));
    },
    notice() {
      // A visible, persisted activity row; mobile clients render its label.
      notices += 1;
      const id = `acp-notice-${notices}`;
      options.timeline.toolStarted(id, CONTEXT_REBUILT_STEP, {});
      options.timeline.toolFinished(id, "completed");
    },
  };
}

/**
 * v1 runs agent harnesses only in chats the user is watching on this Mac:
 * not Bots, Assistant, scheduled or Remote-started runs, where nobody could
 * answer the agent's approvals in time.
 */
export function canHostAcpHarness(input: {
  rendererOwner: boolean;
  remoteOwner: boolean;
  bot: boolean;
  assistant: boolean;
  usageSource?: string;
  interactionSurface?: string;
}): boolean {
  return (
    input.rendererOwner &&
    !input.remoteOwner &&
    !input.bot &&
    !input.assistant &&
    (input.usageSource === undefined || input.usageSource === "chat") &&
    (input.interactionSurface === undefined || input.interactionSurface === "desktop")
  );
}
