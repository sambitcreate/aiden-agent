import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexAuthSession,
  handleCodexAuthTerminal,
  releaseCodexAuthSession,
  type CodexAuthSessionApi,
  type CodexAuthSessionHandlers,
} from "./codex-auth-session.js";
import type {
  ProviderAuthDone,
  ProviderAuthError,
  ProviderAuthEvent,
  ProviderAuthPrompt,
} from "./types.js";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_FLOW_ID = "22222222-2222-4222-8222-222222222222";
const PROMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeApi implements CodexAuthSessionApi {
  readonly order: string[] = [];
  readonly responses: unknown[] = [];
  readonly cancellations: unknown[] = [];
  private readonly prompts = new Set<(value: ProviderAuthPrompt) => void>();
  private readonly events = new Set<(value: ProviderAuthEvent) => void>();
  private readonly completions = new Set<(value: ProviderAuthDone) => void>();
  private readonly errors = new Set<(value: ProviderAuthError) => void>();
  rejectStart = false;
  rejectEventSubscription = false;
  rejectCancel = false;
  cancelResult: { cancelled: true } | { cancelled: false; reason: "finishing" } = {
    cancelled: true,
  };

  async authStart(): Promise<{ started: true }> {
    this.order.push("start");
    if (this.rejectStart) throw new Error("start failed");
    return { started: true };
  }

  async authRespond(request: unknown): Promise<{ accepted: true }> {
    this.responses.push(request);
    return { accepted: true };
  }

  async authCancel(
    request: unknown,
  ): Promise<{ cancelled: true } | { cancelled: false; reason: "finishing" }> {
    this.cancellations.push(request);
    if (this.rejectCancel) throw new Error("cancel failed");
    return this.cancelResult;
  }

  onAuthPrompt(handler: (prompt: ProviderAuthPrompt) => void): () => void {
    this.order.push("prompt-subscribe");
    this.prompts.add(handler);
    return () => this.prompts.delete(handler);
  }

  onAuthEvent(handler: (event: ProviderAuthEvent) => void): () => void {
    this.order.push("event-subscribe");
    if (this.rejectEventSubscription) throw new Error("subscription failed");
    this.events.add(handler);
    return () => this.events.delete(handler);
  }

  onAuthDone(handler: (event: ProviderAuthDone) => void): () => void {
    this.order.push("done-subscribe");
    this.completions.add(handler);
    return () => this.completions.delete(handler);
  }

  onAuthError(handler: (event: ProviderAuthError) => void): () => void {
    this.order.push("error-subscribe");
    this.errors.add(handler);
    return () => this.errors.delete(handler);
  }

  emitPrompt(value: ProviderAuthPrompt): void {
    for (const handler of [...this.prompts]) handler(value);
  }

  emitEvent(value: ProviderAuthEvent): void {
    for (const handler of [...this.events]) handler(value);
  }

  emitDone(value: ProviderAuthDone): void {
    for (const handler of [...this.completions]) handler(value);
  }

  emitError(value: ProviderAuthError): void {
    for (const handler of [...this.errors]) handler(value);
  }

  listenerCount(): number {
    return this.prompts.size + this.events.size + this.completions.size + this.errors.size;
  }
}

function handlers(received: string[]): CodexAuthSessionHandlers {
  return {
    onPrompt: () => received.push("prompt"),
    onEvent: () => received.push("event"),
    onDone: () => received.push("done"),
    onError: () => received.push("error"),
  };
}

function prompt(flowId = FLOW_ID, promptId = PROMPT_ID): ProviderAuthPrompt {
  return {
    flowId,
    providerId: "openai-codex",
    promptId,
    type: "text",
    message: "Continue",
  };
}

test("subscribes to every notification before starting and filters by flow id", async () => {
  const api = new FakeApi();
  const received: string[] = [];
  const session = createCodexAuthSession(api, handlers(received), () => FLOW_ID);

  await session.start();
  assert.deepEqual(api.order, [
    "prompt-subscribe",
    "event-subscribe",
    "done-subscribe",
    "error-subscribe",
    "start",
  ]);

  api.emitPrompt(prompt(OTHER_FLOW_ID));
  api.emitEvent({
    flowId: FLOW_ID,
    providerId: "openai-codex",
    type: "progress",
    message: "Signing in",
  });
  assert.deepEqual(received, ["event"]);
});

test("routes responses and cancellation only through the session identifiers", async () => {
  const api = new FakeApi();
  const session = createCodexAuthSession(api, handlers([]), () => FLOW_ID);
  await session.start();
  api.emitPrompt(prompt());

  await session.respond(PROMPT_ID, "option-1");
  await session.cancel();

  assert.deepEqual(api.responses, [
    {
      flowId: FLOW_ID,
      providerId: "openai-codex",
      promptId: PROMPT_ID,
      value: "option-1",
    },
  ]);
  assert.deepEqual(api.cancellations, [{ flowId: FLOW_ID, providerId: "openai-codex" }]);
});

test("cancellation tombstones prompts, events, and responses before and after acknowledgement", async () => {
  const api = new FakeApi();
  let resolveCancel = (
    _value: { cancelled: true } | { cancelled: false; reason: "finishing" },
  ): void => undefined;
  api.authCancel = async (request: unknown) => {
    api.cancellations.push(request);
    return new Promise((resolve) => {
      resolveCancel = resolve;
    });
  };
  const received: string[] = [];
  const session = createCodexAuthSession(api, handlers(received), () => FLOW_ID);
  await session.start();
  api.emitPrompt(prompt());
  assert.deepEqual(received, ["prompt"]);

  const cancellation = session.cancel();
  assert.equal(session.isCancelling(), true);
  assert.equal(session.isCurrentPrompt(PROMPT_ID), false);
  api.emitPrompt(prompt(FLOW_ID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  api.emitEvent({
    flowId: FLOW_ID,
    providerId: "openai-codex",
    type: "progress",
    message: "Late progress",
  });
  await assert.rejects(session.respond(PROMPT_ID, "late"), /unavailable/u);
  assert.deepEqual(received, ["prompt"]);

  resolveCancel({ cancelled: true });
  await cancellation;
  api.emitPrompt(prompt());
  api.emitEvent({
    flowId: FLOW_ID,
    providerId: "openai-codex",
    type: "progress",
    message: "Later progress",
  });
  assert.deepEqual(received, ["prompt"]);
  assert.equal(api.cancellations.length, 1);
});

test("a failed cancellation can be retried without reopening the tombstoned session", async () => {
  const api = new FakeApi();
  api.rejectCancel = true;
  const received: string[] = [];
  const session = createCodexAuthSession(api, handlers(received), () => FLOW_ID);
  await session.start();
  api.emitPrompt(prompt());

  await assert.rejects(session.cancel(), /cancel failed/u);
  api.emitPrompt(prompt(FLOW_ID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  api.emitEvent({
    flowId: FLOW_ID,
    providerId: "openai-codex",
    type: "progress",
    message: "Late progress",
  });
  await assert.rejects(session.respond(PROMPT_ID, "late"), /unavailable/u);

  api.rejectCancel = false;
  assert.deepEqual(await session.cancel(), { cancelled: true });
  assert.equal(api.cancellations.length, 2);
  assert.deepEqual(received, ["prompt"]);
});

test("tracks prompt replacement and terminal disposal while a response is in flight", async () => {
  const api = new FakeApi();
  let resolveResponse = (_value: { accepted: true }): void => undefined;
  api.authRespond = async (request: unknown) => {
    api.responses.push(request);
    return new Promise<{ accepted: true }>((resolve) => {
      resolveResponse = resolve;
    });
  };
  const session = createCodexAuthSession(api, handlers([]), () => FLOW_ID);
  await session.start();
  api.emitPrompt(prompt());
  const response = session.respond(PROMPT_ID, "first");

  const nextPromptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  api.emitPrompt(prompt(FLOW_ID, nextPromptId));
  assert.equal(session.isCurrentPrompt(PROMPT_ID), false);
  assert.equal(session.isCurrentPrompt(nextPromptId), true);
  resolveResponse({ accepted: true });
  await response;

  api.emitDone({ flowId: FLOW_ID, providerId: "openai-codex", cancelled: false });
  assert.equal(session.isActive(), false);
  assert.equal(session.isCurrentPrompt(nextPromptId), false);
});

test("rejects a duplicate response while the first IPC request is still pending", async () => {
  const api = new FakeApi();
  let resolveResponse = (_value: { accepted: true }): void => undefined;
  api.authRespond = async (request: unknown) => {
    api.responses.push(request);
    return new Promise<{ accepted: true }>((resolve) => {
      resolveResponse = resolve;
    });
  };
  const session = createCodexAuthSession(api, handlers([]), () => FLOW_ID);
  await session.start();
  api.emitPrompt(prompt());

  const first = session.respond(PROMPT_ID, "first");
  await assert.rejects(session.respond(PROMPT_ID, "duplicate"), /unavailable/u);
  assert.equal(api.responses.length, 1);
  resolveResponse({ accepted: true });
  await first;
});

test("terminal delivery invalidates a response operation before its IPC settles", async () => {
  const api = new FakeApi();
  let resolveResponse = (_value: { accepted: true }): void => undefined;
  api.authRespond = async (request: unknown) => {
    api.responses.push(request);
    return new Promise<{ accepted: true }>((resolve) => {
      resolveResponse = resolve;
    });
  };
  const session = createCodexAuthSession(api, handlers([]), () => FLOW_ID);
  await session.start();
  api.emitPrompt(prompt());
  const response = session.respond(PROMPT_ID, "first");

  api.emitDone({ flowId: FLOW_ID, providerId: "openai-codex", cancelled: false });
  assert.equal(session.isActive(), false);
  resolveResponse({ accepted: true });
  await response;
  assert.equal(session.isCurrentPrompt(PROMPT_ID), false);
});

test("terminal delivery removes all listeners before notifying the consumer", async () => {
  const api = new FakeApi();
  const received: string[] = [];
  const session = createCodexAuthSession(api, handlers(received), () => FLOW_ID);
  await session.start();

  api.emitDone({ flowId: FLOW_ID, providerId: "openai-codex", cancelled: false });
  assert.deepEqual(received, ["done"]);
  assert.equal(api.listenerCount(), 0);
  await assert.rejects(session.cancel(), /unavailable/u);

  api.emitError({
    flowId: FLOW_ID,
    providerId: "openai-codex",
    code: "sign_in_failed",
    message: "Ignored after completion",
  });
  assert.deepEqual(received, ["done"]);
  await assert.rejects(session.start(), /unavailable/u);
});

test("a rejected start and explicit disposal both remove every listener", async () => {
  const rejectedApi = new FakeApi();
  rejectedApi.rejectStart = true;
  const rejected = createCodexAuthSession(rejectedApi, handlers([]), () => FLOW_ID);
  await assert.rejects(rejected.start(), /start failed/u);
  assert.equal(rejectedApi.listenerCount(), 0);

  const disposedApi = new FakeApi();
  const disposed = createCodexAuthSession(disposedApi, handlers([]), () => FLOW_ID);
  disposed.dispose();
  assert.equal(disposedApi.listenerCount(), 0);

  const partiallySubscribedApi = new FakeApi();
  partiallySubscribedApi.rejectEventSubscription = true;
  assert.throws(
    () => createCodexAuthSession(partiallySubscribedApi, handlers([]), () => FLOW_ID),
    /subscription failed/u,
  );
  assert.equal(partiallySubscribedApi.listenerCount(), 0);
});

test("unmount keeps terminal cache reconciliation alive across the commit boundary", async () => {
  const api = new FakeApi();
  api.cancelResult = { cancelled: false, reason: "finishing" };
  let mounted = true;
  let refreshes = 0;
  let mountedUpdates = 0;
  const session = createCodexAuthSession(
    api,
    {
      ...handlers([]),
      onDone: () =>
        handleCodexAuthTerminal({
          refreshProviderState: () => {
            refreshes += 1;
          },
          isMounted: () => mounted,
          updateMountedView: () => {
            mountedUpdates += 1;
          },
        }),
    },
    () => FLOW_ID,
  );
  await session.start();
  mounted = false;

  await Promise.all([releaseCodexAuthSession(session), releaseCodexAuthSession(session)]);
  assert.equal(api.cancellations.length, 1);
  assert.equal(api.listenerCount(), 4);

  api.emitDone({ flowId: FLOW_ID, providerId: "openai-codex", cancelled: false });
  assert.equal(api.listenerCount(), 0);
  assert.equal(refreshes, 1);
  assert.equal(mountedUpdates, 0);
  assert.equal(session.isActive(), false);
});

test("unmount removes listeners when cancellation IPC cannot promise a terminal event", async () => {
  const api = new FakeApi();
  api.rejectCancel = true;
  const session = createCodexAuthSession(api, handlers([]), () => FLOW_ID);
  await session.start();

  await releaseCodexAuthSession(session);

  assert.equal(api.cancellations.length, 1);
  assert.equal(api.listenerCount(), 0);
  assert.equal(session.isActive(), false);
});
