import assert from "node:assert/strict";
import test from "node:test";

import {
  initialCodexAuthViewState,
  reduceCodexAuthView,
  type CodexAuthViewState,
} from "./codex-auth-view-state.js";
import type { ProviderAuthPrompt } from "./types.js";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_FLOW_ID = "22222222-2222-4222-8222-222222222222";
const PROMPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROMPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function start(): CodexAuthViewState {
  return reduceCodexAuthView(initialCodexAuthViewState, { type: "start", flowId: FLOW_ID });
}

function prompt(promptId: string, type: ProviderAuthPrompt["type"]): ProviderAuthPrompt {
  return {
    flowId: FLOW_ID,
    providerId: "openai-codex",
    promptId,
    type,
    message: `Prompt ${promptId}`,
  };
}

test("prompt replacement clears a secret atomically before rendering the next prompt", () => {
  let state = start();
  state = reduceCodexAuthView(state, { type: "prompt", prompt: prompt(PROMPT_A, "secret") });
  const firstPromptGeneration = state.promptGeneration;
  state = reduceCodexAuthView(state, {
    type: "prompt-value",
    flowId: FLOW_ID,
    promptId: PROMPT_A,
    generation: firstPromptGeneration,
    value: "never-render-this",
  });
  state = reduceCodexAuthView(state, { type: "prompt", prompt: prompt(PROMPT_B, "text") });
  state = reduceCodexAuthView(state, {
    type: "prompt-value",
    flowId: FLOW_ID,
    promptId: PROMPT_A,
    generation: firstPromptGeneration,
    value: "queued-old-secret",
  });

  assert.equal(state.view?.prompt?.promptId, PROMPT_B);
  assert.equal(state.view?.prompt?.type, "text");
  assert.equal(state.promptValue, "");
});

test("submission removes the draft immediately and rejection restores an empty prompt", () => {
  let state = start();
  state = reduceCodexAuthView(state, { type: "prompt", prompt: prompt(PROMPT_A, "secret") });
  const submittedGeneration = state.promptGeneration;
  state = reduceCodexAuthView(state, {
    type: "prompt-value",
    flowId: FLOW_ID,
    promptId: PROMPT_A,
    generation: submittedGeneration,
    value: "submitted-secret",
  });
  state = reduceCodexAuthView(state, {
    type: "responding",
    flowId: FLOW_ID,
    promptId: PROMPT_A,
  });

  assert.equal(state.view?.phase, "responding");
  assert.equal(state.promptValue, "");

  state = reduceCodexAuthView(state, {
    type: "response-rejected",
    flowId: FLOW_ID,
    promptId: PROMPT_A,
    message: "Try again",
  });
  assert.equal(state.view?.phase, "waiting");
  assert.equal(state.view?.prompt?.promptId, PROMPT_A);
  assert.equal(state.promptValue, "");

  state = reduceCodexAuthView(state, {
    type: "prompt-value",
    flowId: FLOW_ID,
    promptId: PROMPT_A,
    generation: submittedGeneration,
    value: "queued-submitted-secret",
  });
  assert.equal(state.promptValue, "");
});

test("prompt and event delivery cannot reopen a cancelling flow", () => {
  let state = start();
  state = reduceCodexAuthView(state, { type: "prompt", prompt: prompt(PROMPT_A, "text") });
  state = reduceCodexAuthView(state, { type: "cancelling", flowId: FLOW_ID });

  const afterPrompt = reduceCodexAuthView(state, {
    type: "prompt",
    prompt: prompt(PROMPT_B, "text"),
  });
  const afterEvent = reduceCodexAuthView(state, {
    type: "event",
    event: {
      flowId: FLOW_ID,
      providerId: "openai-codex",
      type: "auth_url",
      url: "https://example.com/late",
    },
  });

  assert.strictEqual(afterPrompt, state);
  assert.strictEqual(afterEvent, state);
  assert.equal(state.view?.phase, "cancelling");
  assert.equal(state.view?.prompt, undefined);
  assert.equal(state.view?.action, undefined);
});

test("a rejected cancellation exposes a recoverable retry state", () => {
  let state = start();
  state = reduceCodexAuthView(state, { type: "cancelling", flowId: FLOW_ID });
  state = reduceCodexAuthView(state, {
    type: "cancel-rejected",
    flowId: FLOW_ID,
    message: "Try cancelling again",
  });

  assert.equal(state.view?.phase, "cancel_failed");
  assert.equal(state.view?.prompt, undefined);
  assert.equal(state.view?.action, undefined);
  assert.equal(state.authFailure, "Try cancelling again");

  state = reduceCodexAuthView(state, { type: "cancelling", flowId: FLOW_ID });
  assert.equal(state.view?.phase, "cancelling");
  assert.equal(state.authFailure, null);
});

test("action, prompt, and progress steps replace one another instead of accumulating", () => {
  let state = start();
  state = reduceCodexAuthView(state, {
    type: "event",
    event: {
      flowId: FLOW_ID,
      providerId: "openai-codex",
      type: "auth_url",
      url: "https://example.com/sign-in",
    },
  });
  assert.equal(state.view?.action?.type, "auth_url");

  state = reduceCodexAuthView(state, { type: "prompt", prompt: prompt(PROMPT_A, "manual_code") });
  assert.equal(state.view?.action, undefined);
  assert.equal(state.view?.prompt?.promptId, PROMPT_A);

  state = reduceCodexAuthView(state, {
    type: "event",
    event: {
      flowId: FLOW_ID,
      providerId: "openai-codex",
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.com/device",
    },
  });
  assert.equal(state.view?.prompt, undefined);
  assert.equal(state.view?.action?.type, "device_code");

  state = reduceCodexAuthView(state, {
    type: "event",
    event: {
      flowId: FLOW_ID,
      providerId: "openai-codex",
      type: "progress",
      message: "Checking sign-in…",
    },
  });
  assert.equal(state.view?.prompt, undefined);
  assert.equal(state.view?.action, undefined);
  assert.equal(state.view?.message, "Checking sign-in…");
});

test("late response and cancellation updates cannot replace a newer or terminal state", () => {
  let state = start();
  state = reduceCodexAuthView(state, { type: "prompt", prompt: prompt(PROMPT_A, "text") });
  state = reduceCodexAuthView(state, { type: "responding", flowId: FLOW_ID, promptId: PROMPT_A });
  state = reduceCodexAuthView(state, { type: "prompt", prompt: prompt(PROMPT_B, "select") });

  const afterReplacement = reduceCodexAuthView(state, {
    type: "response-accepted",
    flowId: FLOW_ID,
    promptId: PROMPT_A,
  });
  assert.strictEqual(afterReplacement, state);
  assert.equal(afterReplacement.view?.prompt?.promptId, PROMPT_B);

  state = reduceCodexAuthView(state, { type: "error", flowId: FLOW_ID, message: "Stopped" });
  const afterTerminal = reduceCodexAuthView(state, {
    type: "cancel-result",
    flowId: FLOW_ID,
    finishing: false,
  });
  assert.strictEqual(afterTerminal, state);
  assert.equal(afterTerminal.view, null);
  assert.equal(afterTerminal.authFailure, "Stopped");
});

test("events and terminal results from another flow cannot mutate the current view", () => {
  const state = start();
  const afterEvent = reduceCodexAuthView(state, {
    type: "event",
    event: {
      flowId: OTHER_FLOW_ID,
      providerId: "openai-codex",
      type: "progress",
      message: "Wrong flow",
    },
  });
  const afterDone = reduceCodexAuthView(state, { type: "done", flowId: OTHER_FLOW_ID });

  assert.strictEqual(afterEvent, state);
  assert.strictEqual(afterDone, state);
});
