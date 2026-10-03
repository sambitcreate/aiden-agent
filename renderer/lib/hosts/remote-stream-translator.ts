import type { AgentActivity, ToolActivity } from "../agent-activity";
import { resolveAgentActivity } from "../agent-activity";
import type { ApprovalPrompt } from "../ipc";
import type { ChatMessage } from "../types";
import {
  ASK_USER_QUESTION_VERSION,
  parseAskUserQuestions,
  type AskUserQuestionPromptV1,
} from "../../shared/ask-user-question";
import {
  latestActiveAgentStep,
  parseGenerationTimeline,
  type GenerationTimeline,
} from "../../shared/generation-timeline";
import type { PeerRunEvent, PeerRunStreamState, PeerRunSubscription } from "../../shared/peer-host";
import { parseToolApprovalScope, type ToolApprovalScope } from "../../shared/tool-approval-scope";

/**
 * Pure reducer from a paired host's run stream (`PeerRunEvent`, contract
 * revision 19) to the transcript state the local chat pane feeds
 * `MessageList`. It never calls anything: a step returns the next view and
 * whether the persisted messages window must be refetched before the next
 * event is applied.
 */

export type RemoteRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface RemoteToolActivity extends ToolActivity {
  toolId: string;
}

export interface RemoteRunView {
  runId: string | null;
  chatId: string | null;
  /** Who started the run on the host (`device`, `desktop`, …), when announced. */
  origin: string | null;
  /** Sequence of the newest applied event; 0 before any. */
  cursor: number;
  status: RemoteRunStatus;
  /** `run.ended` (or a `gone`/`ended` stream state) was seen; nothing more will arrive. */
  ended: boolean;
  text: string;
  reasoning: string;
  /** The last content event was a text delta, so the reply is actively being written. */
  textStreaming: boolean;
  timeline: GenerationTimeline | null;
  tool: RemoteToolActivity | null;
  /** Pending approvals, read-only on this Mac (`canAllow: false`). */
  approvals: ApprovalPrompt[];
  questions: AskUserQuestionPromptV1[];
  errorMessage: string | null;
  /** Assistant message the host persisted for a `done` run. */
  doneMessageId: string | null;
  /**
   * Part of the live text was not delivered (a `gap` snapshot or a truncated
   * subscription). The partial text is not shown; the persisted window
   * replaces it when the run ends.
   */
  incomplete: boolean;
}

export interface RemoteRunStep {
  view: RemoteRunView;
  /** Refetch the newest messages window before applying anything else. */
  refetch: boolean;
}

export function initialRemoteRunView(runId: string | null = null, chatId: string | null = null): RemoteRunView {
  return {
    runId,
    chatId,
    origin: null,
    cursor: 0,
    status: "idle",
    ended: false,
    text: "",
    reasoning: "",
    textStreaming: false,
    timeline: null,
    tool: null,
    approvals: [],
    questions: [],
    errorMessage: null,
    doneMessageId: null,
    incomplete: false,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isTerminal(status: RemoteRunStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

/** The host's run summary state, as carried by `snapshot` and `run.ended`. */
function statusFromHostState(state: unknown, fallback: RemoteRunStatus): RemoteRunStatus {
  switch (state) {
    case "working":
    case "needs_approval":
    case "needs_input":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return fallback;
  }
}

function approvalPrompt(value: unknown): ApprovalPrompt | null {
  const payload = record(value);
  const approvalId = str(payload?.approvalId);
  if (!payload || !approvalId) return null;
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes
        .map(parseToolApprovalScope)
        .filter((scope): scope is ToolApprovalScope => scope !== undefined)
    : [];
  return {
    approvalId,
    toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "",
    toolName: str(payload.toolName) ?? "Tool",
    summary: str(payload.summary) ?? "Aiden needs approval.",
    // Read-only here: answering arrives with run control.
    canAllow: false,
    ...(scopes.length > 0 ? { scopes } : {}),
    source: "remote",
  };
}

function questionPrompt(value: unknown, runId: string): AskUserQuestionPromptV1 | null {
  const payload = record(value);
  const promptId = str(payload?.promptId);
  const toolCallId = str(payload?.toolCallId);
  const questions = parseAskUserQuestions(payload?.questions);
  if (!payload || !promptId || !toolCallId || !questions) return null;
  const expiresAt = typeof payload.expiresAt === "string" && Number.isFinite(Date.parse(payload.expiresAt))
    ? payload.expiresAt
    : undefined;
  return {
    version: ASK_USER_QUESTION_VERSION,
    promptId,
    streamId: runId,
    toolCallId,
    questions,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function withApproval(list: ApprovalPrompt[], prompt: ApprovalPrompt | null): ApprovalPrompt[] {
  if (!prompt || list.some((entry) => entry.approvalId === prompt.approvalId)) return list;
  return [...list, prompt];
}

function withQuestion(list: AskUserQuestionPromptV1[], prompt: AskUserQuestionPromptV1 | null) {
  if (!prompt || list.some((entry) => entry.promptId === prompt.promptId)) return list;
  return [...list, prompt];
}

function settledPrompts(view: RemoteRunView): RemoteRunView {
  return { ...view, tool: null, approvals: [], questions: [], textStreaming: false };
}

/**
 * Applies one run event. Events for a different run start a fresh view;
 * duplicates at or below the cursor are dropped, except a `snapshot` at the
 * cursor and the single `run.ended` that repeats the terminal sequence.
 */
export function applyRemoteRunEvent(current: RemoteRunView, event: PeerRunEvent): RemoteRunStep {
  let view = current;
  if (event.streamId !== view.runId) {
    view = initialRemoteRunView(event.streamId, view.chatId);
  }
  const payload = event.payload;
  if (event.type === "run.ended") {
    if (view.ended || event.sequence < view.cursor) return { view: current, refetch: false };
  } else if (event.type === "snapshot") {
    if (event.sequence < view.cursor) return { view: current, refetch: false };
  } else if (event.sequence <= view.cursor) {
    return { view: current, refetch: false };
  }
  // Nothing but `run.ended` follows a terminal event.
  if (isTerminal(view.status) && event.type !== "run.ended" && event.type !== "snapshot") {
    return { view: current, refetch: false };
  }
  view = { ...view, cursor: Math.max(view.cursor, event.sequence) };
  const chatId = str(payload.chatId);
  if (chatId) view.chatId = chatId;

  switch (event.type) {
    case "run.started":
      // The host persisted the turn's user message before the run began.
      return {
        view: { ...view, status: "running", origin: str(payload.origin) },
        refetch: true,
      };
    case "status":
      return { view: { ...view, status: "running" }, refetch: false };
    case "text_delta": {
      const text = typeof payload.text === "string" ? payload.text : "";
      return {
        view: { ...view, status: "running", text: view.text + text, textStreaming: text.length > 0 },
        refetch: false,
      };
    }
    case "reasoning_delta": {
      const text = typeof payload.text === "string" ? payload.text : "";
      return {
        view: { ...view, status: "running", reasoning: view.reasoning + text, textStreaming: false },
        refetch: false,
      };
    }
    case "tool_started": {
      const name = str(payload.name) ?? "Tool";
      return {
        view: {
          ...view,
          status: "running",
          textStreaming: false,
          tool: { toolId: str(payload.toolId) ?? "", state: "running", label: name, toolName: name },
        },
        refetch: false,
      };
    }
    case "tool_finished": {
      if (!view.tool || view.tool.toolId !== payload.toolId) return { view, refetch: false };
      return {
        view: { ...view, tool: { ...view.tool, state: payload.status === "failed" ? "failed" : "finished" } },
        refetch: false,
      };
    }
    case "timeline": {
      const timeline = parseGenerationTimeline(payload.timeline);
      return { view: timeline ? { ...view, timeline } : view, refetch: false };
    }
    case "approval_required":
      return { view: { ...view, approvals: withApproval(view.approvals, approvalPrompt(payload)) }, refetch: false };
    case "approval_resolved":
      return {
        view: { ...view, approvals: view.approvals.filter((entry) => entry.approvalId !== payload.approvalId) },
        refetch: false,
      };
    case "question_required":
      return {
        view: { ...view, questions: withQuestion(view.questions, questionPrompt(payload, view.runId ?? "")) },
        refetch: false,
      };
    case "question_resolved":
      return {
        view: { ...view, questions: view.questions.filter((entry) => entry.promptId !== payload.promptId) },
        refetch: false,
      };
    case "snapshot": {
      if (payload.reason === "gap") {
        // Events were lost: reseed the prompts the host still has pending and
        // read the persisted transcript before resuming.
        const runId = view.runId ?? "";
        const approvals = (Array.isArray(payload.approvals) ? payload.approvals : [])
          .map(approvalPrompt)
          .reduce<ApprovalPrompt[]>(withApproval, []);
        const questions = (Array.isArray(payload.questions) ? payload.questions : [])
          .map((entry) => questionPrompt(entry, runId))
          .reduce<AskUserQuestionPromptV1[]>(withQuestion, []);
        const status = statusFromHostState(payload.state, view.status === "idle" ? "running" : view.status);
        return {
          view: {
            ...view,
            status,
            text: "",
            reasoning: "",
            textStreaming: false,
            tool: null,
            approvals: isTerminal(status) ? [] : approvals,
            questions: isTerminal(status) ? [] : questions,
            incomplete: !isTerminal(status),
          },
          refetch: true,
        };
      }
      // `reset`: the provider restarted this reply; the text starts over.
      return {
        view: { ...view, text: "", reasoning: "", textStreaming: false, incomplete: false },
        refetch: false,
      };
    }
    case "done":
      return {
        view: { ...settledPrompts(view), status: "done", doneMessageId: str(payload.messageId) },
        refetch: true,
      };
    case "error":
      return {
        view: {
          ...settledPrompts(view),
          status: "error",
          errorMessage: str(payload.message) ?? "The run on the host failed.",
        },
        refetch: true,
      };
    case "cancelled":
      return { view: { ...settledPrompts(view), status: "cancelled" }, refetch: true };
    case "run.ended": {
      const status = isTerminal(view.status) ? view.status : statusFromHostState(payload.state, "done");
      return {
        view: { ...settledPrompts(view), status, ended: true },
        // Only a run whose terminal event was missed still needs the persisted turn.
        refetch: !isTerminal(view.status),
      };
    }
    default:
      return { view, refetch: false };
  }
}

/** Folds a list of events, accumulating whether any of them asked for a refetch. */
export function applyRemoteRunEvents(current: RemoteRunView, events: readonly PeerRunEvent[]): RemoteRunStep {
  let view = current;
  let refetch = false;
  for (const event of events) {
    const step = applyRemoteRunEvent(view, event);
    view = step.view;
    refetch ||= step.refetch;
  }
  return { view, refetch };
}

/**
 * Applies a fresh subscription (or a resubscription). A different run starts
 * over; a truncated buffer means the live text cannot be rebuilt, so the view
 * waits for the persisted window instead.
 */
export function applyRemoteRunSubscription(current: RemoteRunView, subscription: PeerRunSubscription): RemoteRunStep {
  let view = current;
  if (subscription.chatId) view = { ...view, chatId: subscription.chatId };
  if (subscription.runId === null) return { view, refetch: false };
  let refetch = false;
  if (subscription.runId !== view.runId) {
    view = initialRemoteRunView(subscription.runId, view.chatId);
  }
  if (subscription.truncated) {
    view = { ...view, text: "", reasoning: "", textStreaming: false, incomplete: true };
    refetch = true;
  }
  const folded = applyRemoteRunEvents(view, subscription.events);
  view = folded.view;
  refetch ||= folded.refetch;
  const state = applyRemoteRunStreamState(view, subscription.state);
  return { view: state.view, refetch: refetch || state.refetch };
}

/** A main-side stream state change for the observed key. */
export function applyRemoteRunStreamState(current: RemoteRunView, state: PeerRunStreamState): RemoteRunStep {
  if ((state === "ended" || state === "gone") && current.runId !== null && !current.ended) {
    return {
      view: {
        ...settledPrompts(current),
        status: isTerminal(current.status) ? current.status : current.status === "idle" ? "idle" : "done",
        ended: true,
      },
      refetch: !isTerminal(current.status),
    };
  }
  return { view: current, refetch: false };
}

/** The refetched window already ends in the failed turn, which renders its own notice. */
function failureIsPersisted(messages: readonly ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" && (last.providerFailure !== undefined || last.timeline?.status === "failed");
}

export interface RemoteRunTranscript {
  streamingText: string | null;
  streamingReasoning: string | null;
  timeline: GenerationTimeline | null;
  agentActivity: AgentActivity | null;
  error: string | null;
  streamComplete: boolean;
  persistedHandoffMessageId: string | null;
}

/**
 * The `MessageList` inputs for a run view against the loaded messages. The
 * streaming row stays until the persisted assistant message is in the window,
 * so a finished reply does not flash away while the refetch is in flight.
 */
export function remoteRunTranscript(view: RemoteRunView, messages: readonly ChatMessage[]): RemoteRunTranscript {
  const active = view.status === "running" && !view.ended;
  const persisted = view.doneMessageId !== null && messages.some((message) => message.id === view.doneMessageId);
  const handoff = view.status === "done" && !persisted && !view.incomplete && view.text.length > 0;
  const showRow = active || handoff;
  const streamingText = showRow ? (view.incomplete ? "" : view.text) : null;
  const pendingQuestion = view.questions.length > 0 && view.approvals.length === 0;
  const activeStep = latestActiveAgentStep(view.timeline);
  const toolActivity: ToolActivity | null = activeStep
    ? { state: "running", label: activeStep.label, toolName: activeStep.toolName }
    : view.tool?.state === "running"
      ? view.tool
      : null;
  let agentActivity: AgentActivity | null = null;
  if (active && pendingQuestion) {
    agentActivity = { phase: "waiting", label: "Waiting for an answer", orbState: "listening" };
  } else if (active) {
    agentActivity = resolveAgentActivity({
      isStarting: view.text.length === 0 && view.reasoning.length === 0 && !toolActivity && !view.incomplete,
      isStopping: false,
      streamingText,
      textStreaming: view.textStreaming,
      pendingApproval: view.approvals.length > 0,
      toolActivity,
    });
  }
  return {
    streamingText,
    streamingReasoning: showRow && !view.incomplete && view.reasoning ? view.reasoning : null,
    timeline: showRow && !view.incomplete ? view.timeline : null,
    agentActivity,
    error: view.status === "error" && !failureIsPersisted(messages) ? view.errorMessage : null,
    streamComplete: handoff,
    persistedHandoffMessageId: null,
  };
}
