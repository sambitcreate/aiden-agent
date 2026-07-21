import type { ProviderAuthEvent, ProviderAuthPrompt } from "./types";

export type CodexAuthActionableEvent = Extract<
  ProviderAuthEvent,
  { type: "auth_url" | "device_code" }
>;

export type CodexAuthPhase =
  | "starting"
  | "waiting"
  | "responding"
  | "cancelling"
  | "cancel_failed"
  | "finishing";

export interface CodexAuthView {
  flowId: string;
  phase: CodexAuthPhase;
  prompt?: ProviderAuthPrompt;
  action?: CodexAuthActionableEvent;
  message: string;
}

export interface CodexAuthViewState {
  view: CodexAuthView | null;
  authFailure: string | null;
  promptFailure: string | null;
  promptValue: string;
  promptGeneration: number;
}

export const initialCodexAuthViewState: CodexAuthViewState = {
  view: null,
  authFailure: null,
  promptFailure: null,
  promptValue: "",
  promptGeneration: 0,
};

export type CodexAuthViewAction =
  | { type: "start"; flowId: string }
  | { type: "started"; flowId: string }
  | { type: "start-error"; flowId: string; message: string }
  | { type: "prompt"; prompt: ProviderAuthPrompt }
  | { type: "event"; event: ProviderAuthEvent }
  | {
      type: "prompt-value";
      flowId: string;
      promptId: string;
      generation: number;
      value: string;
    }
  | { type: "responding"; flowId: string; promptId: string }
  | { type: "response-accepted"; flowId: string; promptId: string }
  | { type: "response-rejected"; flowId: string; promptId: string; message: string }
  | { type: "cancelling"; flowId: string }
  | { type: "cancel-result"; flowId: string; finishing: boolean }
  | { type: "cancel-rejected"; flowId: string; message: string }
  | { type: "done"; flowId: string }
  | { type: "error"; flowId: string; message: string }
  | { type: "set-auth-failure"; message: string }
  | { type: "clear-auth-failure" };

function hasFlow(
  state: CodexAuthViewState,
  flowId: string,
): state is CodexAuthViewState & { view: CodexAuthView } {
  return state.view?.flowId === flowId;
}

function hasPrompt(
  state: CodexAuthViewState,
  flowId: string,
  promptId: string,
): state is CodexAuthViewState & { view: CodexAuthView & { prompt: ProviderAuthPrompt } } {
  return hasFlow(state, flowId) && state.view?.prompt?.promptId === promptId;
}

function eventMessage(event: ProviderAuthEvent): string {
  if (event.type === "auth_url") {
    return event.instructions ?? "Complete sign-in in your browser.";
  }
  if (event.type === "device_code") {
    return "Enter this temporary code on OpenAI's verification page.";
  }
  return event.message;
}

/**
 * Auth steps are mutually exclusive and flow-bound. Keeping the draft in the
 * same reducer makes prompt replacement atomic, so a secret can never render in
 * a later text prompt while a passive effect catches up.
 */
export function reduceCodexAuthView(
  state: CodexAuthViewState,
  action: CodexAuthViewAction,
): CodexAuthViewState {
  switch (action.type) {
    case "start":
      return {
        view: {
          flowId: action.flowId,
          phase: "starting",
          message: "Preparing ChatGPT sign-in…",
        },
        authFailure: null,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "started":
      if (!hasFlow(state, action.flowId) || state.view?.phase !== "starting") return state;
      return {
        ...state,
        view: { ...state.view, phase: "waiting", message: "Waiting for OpenAI…" },
      };
    case "start-error":
      if (!hasFlow(state, action.flowId)) return state;
      return {
        view: null,
        authFailure: action.message,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "prompt":
      if (!hasFlow(state, action.prompt.flowId)) return state;
      if (state.view.phase === "cancelling" || state.view.phase === "finishing") return state;
      return {
        view: {
          ...state.view,
          phase: "waiting",
          prompt: action.prompt,
          action: undefined,
          message: action.prompt.message,
        },
        authFailure: null,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "event": {
      if (!hasFlow(state, action.event.flowId)) return state;
      if (state.view.phase === "cancelling" || state.view.phase === "finishing") return state;
      const actionable =
        action.event.type === "auth_url" || action.event.type === "device_code"
          ? action.event
          : undefined;
      return {
        view: {
          ...state.view,
          phase: "waiting",
          prompt: undefined,
          action: actionable,
          message: eventMessage(action.event),
        },
        authFailure: null,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    }
    case "prompt-value":
      if (
        !hasPrompt(state, action.flowId, action.promptId) ||
        state.view.phase !== "waiting" ||
        state.promptGeneration !== action.generation
      ) {
        return state;
      }
      return { ...state, promptValue: action.value };
    case "responding":
      if (!hasPrompt(state, action.flowId, action.promptId)) return state;
      return {
        ...state,
        view: { ...state.view, phase: "responding", message: "Sending your response…" },
        authFailure: null,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "response-accepted":
      if (!hasPrompt(state, action.flowId, action.promptId)) return state;
      return {
        view: {
          ...state.view,
          phase: "waiting",
          prompt: undefined,
          action: undefined,
          message: "Waiting for OpenAI…",
        },
        authFailure: null,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "response-rejected":
      if (!hasPrompt(state, action.flowId, action.promptId)) return state;
      return {
        ...state,
        view: { ...state.view, phase: "waiting", message: state.view.prompt.message },
        promptFailure: action.message,
        promptValue: "",
      };
    case "cancelling":
      if (!hasFlow(state, action.flowId)) return state;
      return {
        view: {
          ...state.view,
          phase: "cancelling",
          prompt: undefined,
          action: undefined,
          message: "Cancelling ChatGPT sign-in…",
        },
        authFailure: null,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "cancel-result":
      if (!hasFlow(state, action.flowId)) return state;
      return {
        ...state,
        view: {
          ...state.view,
          phase: action.finishing ? "finishing" : "cancelling",
          prompt: undefined,
          action: undefined,
          message: action.finishing
            ? "Finishing secure credential storage…"
            : "Cancelling ChatGPT sign-in…",
        },
      };
    case "cancel-rejected":
      if (!hasFlow(state, action.flowId)) return state;
      return {
        view: {
          ...state.view,
          phase: "cancel_failed",
          prompt: undefined,
          action: undefined,
          message: "ChatGPT sign-in is still open.",
        },
        authFailure: action.message,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "done":
      return hasFlow(state, action.flowId) ? initialCodexAuthViewState : state;
    case "error":
      if (!hasFlow(state, action.flowId)) return state;
      return {
        view: null,
        authFailure: action.message,
        promptFailure: null,
        promptValue: "",
        promptGeneration: state.promptGeneration + 1,
      };
    case "set-auth-failure":
      return { ...state, authFailure: action.message, promptFailure: null };
    case "clear-auth-failure":
      return state.authFailure === null ? state : { ...state, authFailure: null };
  }
}
