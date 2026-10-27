import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "./types.js";

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: "google",
  kind: "openai",
  label: "Google",
  baseUrl: "",
  models: ["gemini-pro", "gemini-flash"],
  defaultModel: "gemini-pro",
  needsKey: true,
  hasKey: true,
  isBuiltin: true,
  ...overrides,
});

test("new work resolves away from a hidden active or default model", async () => {
  const {
    initialVisibleModelSelection,
    isModelSelectionReadyForNewWork,
    resolveVisibleModelSelection,
  } = await import("./use-model-selection");
  assert.equal(
    initialVisibleModelSelection({ providerId: "", model: "" }, [provider()], undefined, false),
    undefined,
  );
  assert.deepEqual(
    initialVisibleModelSelection(
      { providerId: "", model: "" },
      [provider()],
      { google: ["gemini-pro"] },
      true,
    ),
    { providerId: "google", model: "gemini-flash" },
  );
  assert.deepEqual(
    resolveVisibleModelSelection({ providerId: "google", model: "gemini-pro" }, [provider()], {
      google: ["gemini-pro"],
    }),
    { providerId: "google", model: "gemini-flash" },
  );
  assert.equal(
    resolveVisibleModelSelection({ providerId: "google", model: "gemini-pro" }, [provider()], {
      google: ["gemini-pro", "gemini-flash"],
    }),
    undefined,
  );
  const allHidden = {
    google: { defaultVisibility: "hidden" as const, exceptions: [] },
  };
  assert.equal(
    isModelSelectionReadyForNewWork(
      { providerId: "google", model: "gemini-pro" },
      [provider()],
      allHidden,
      false,
    ),
    false,
  );
  assert.equal(
    isModelSelectionReadyForNewWork(
      { providerId: "google", model: "gemini-pro" },
      [provider()],
      allHidden,
      true,
    ),
    true,
  );
});

test("readiness requires the selected model to exist on a usable live provider", async () => {
  const { isModelSelectionAvailable } = await import("./use-model-selection");
  const selection = { providerId: "google", model: "gemini-pro" };
  assert.equal(isModelSelectionAvailable(selection, [provider()]), true);
  assert.equal(
    isModelSelectionAvailable({ providerId: "google", model: "removed-model" }, [provider()]),
    false,
  );
  assert.equal(isModelSelectionAvailable(selection, [provider({ hasKey: false })]), false);
  assert.equal(isModelSelectionAvailable(selection, undefined), false);
});

test("same-window model writes notify every mounted consumer", async () => {
  const values = new Map<string, string>();
  const events = new EventTarget();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });

  const { persistModelSelection, readModelSelectionRevision, subscribeModelSelection } =
    await import("./use-model-selection");
  const first: Array<{ providerId: string; model: string }> = [];
  const second: Array<{ providerId: string; model: string }> = [];
  const unsubscribeFirst = subscribeModelSelection((selection) => first.push(selection));
  const unsubscribeSecond = subscribeModelSelection((selection) => second.push(selection));

  const previousRevision = readModelSelectionRevision();
  persistModelSelection("anthropic", "claude-sonnet");

  assert.deepEqual(first, [{ providerId: "anthropic", model: "claude-sonnet" }]);
  assert.deepEqual(second, first);
  assert.equal(readModelSelectionRevision(), previousRevision + 1);
  unsubscribeFirst();
  unsubscribeSecond();
});

test("a chat with messages answers with its own model; an empty chat follows the app's", async () => {
  const { chatModelSelection } = await import("./use-model-selection");
  const app = { providerId: "google", model: "gemini-flash" };
  const chat = { providerId: "anthropic", model: "claude-sonnet" };
  assert.deepEqual(chatModelSelection(chat, true, app), chat);
  assert.deepEqual(chatModelSelection(chat, false, app), app, "an empty chat uses the new-chat model");
  assert.deepEqual(
    chatModelSelection({ providerId: "anthropic" }, true, app),
    app,
    "a chat that never recorded a whole pair falls back to the new-chat model",
  );
  assert.deepEqual(chatModelSelection(undefined, true, app), app);
});

test("leaving a chat cannot clear the model target of the chat opened after it", async () => {
  const { readActiveChatModelTarget, setActiveChatModelTarget } = await import("./use-model-selection");
  const target = (chatId: string) => ({
    chatId,
    selection: { providerId: "google", model: "gemini-pro" },
    select: () => undefined,
  });
  const leaveA = setActiveChatModelTarget(target("chat-a"));
  const leaveB = setActiveChatModelTarget(target("chat-b"));
  leaveA();
  assert.equal(readActiveChatModelTarget()?.chatId, "chat-b");
  leaveB();
  assert.equal(readActiveChatModelTarget(), null, "with no chat open, a model change sets the new-chat model");
});

test("a new-chat model Aiden sets on the host reaches the window, and a pick here reaches the host once", async () => {
  const values = new Map<string, string>();
  const events = new EventTarget();
  const invoked: unknown[][] = [];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      aidenAPI: { ipc: { invoke: async (...args: unknown[]) => { invoked.push(args); return {}; } } },
    },
  });
  const { persistModelSelection, readModelSelection, subscribeHostNewChatModel } =
    await import("./use-model-selection");
  persistModelSelection("lmstudio", "qwen3-8b");
  persistModelSelection("lmstudio", "qwen3-8b");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(invoked, [["settings:set", { lastProviderId: "lmstudio", lastModel: "qwen3-8b" }]]);

  let deliver: ((payload: unknown) => void) | undefined;
  const unsubscribe = subscribeHostNewChatModel(((_channel: string, handler: (payload: unknown) => void) => {
    deliver = handler;
    return () => { deliver = undefined; };
  }) as never);
  deliver?.({ providerId: "openai", model: "gpt-5.5" });
  assert.deepEqual(readModelSelection(), { providerId: "openai", model: "gpt-5.5" });
  deliver?.({ providerId: 7, model: "x" });
  assert.deepEqual(readModelSelection(), { providerId: "openai", model: "gpt-5.5" });
  unsubscribe();
  assert.equal(deliver, undefined);
});

test("at startup the host's new-chat model is brought in line with this window's pick", async () => {
  const values = new Map<string, string>([
    ["aiden-agent.providerId", "lmstudio"],
    ["aiden-agent.model", "model-b"],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const { mirrorNewChatModelToHost } = await import("./use-model-selection");
  // The host still names the model an older version wrote after a send in another chat.
  let host = { lastProviderId: "lmstudio", lastModel: "model-a" };
  const writes: unknown[] = [];
  const api = {
    get: async () => structuredClone(host),
    set: async (patch: typeof host) => {
      writes.push(patch);
      host = { ...host, ...patch };
    },
  };
  await mirrorNewChatModelToHost(api);
  assert.deepEqual(host, { lastProviderId: "lmstudio", lastModel: "model-b" });
  await mirrorNewChatModelToHost(api);
  assert.equal(writes.length, 1, "nothing is written when they already match");
  values.clear();
  host = { lastProviderId: "lmstudio", lastModel: "model-a" };
  await mirrorNewChatModelToHost(api);
  assert.equal(host.lastModel, "model-a", "a window with no pick yet leaves the host alone");
});
