import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, createModels, type Model } from "@earendil-works/pi-ai";
import {
  CURSOR_BASE_URL,
  CURSOR_PROVIDER_ID,
  __testUtils,
  cursorProvider,
  parseCursorModels,
} from "./cursor-provider.js";
import { currentCursorSession, runWithCursorSession } from "./cursor-session-binding.js";
import { registerAidenBuiltinProviders } from "./concentrate-provider.js";

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Exhaust the stream so overlapping Cursor turns can settle.
  }
}

test("Cursor catalog parsing keeps executable identities and reviewed capabilities", () => {
  const models = parseCursorModels([
    {
      id: "composer-1.5",
      name: "Composer 1.5",
      reasoning: true,
      thinkingLevelMap: {
        off: "false",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    },
    { id: "auto", name: "Auto", contextWindow: 128_000, maxTokens: 16_384 },
    { id: "composer-1.5", name: "duplicate is ignored", contextWindow: 1, maxTokens: 1 },
    { id: "x".repeat(257), name: "too long", contextWindow: 1, maxTokens: 1 },
  ]);

  assert.deepEqual(
    models.map((model) => model.id),
    ["composer-1.5", "auto"],
  );
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.equal(models[0].api, "openai-completions");
  assert.equal(models[0].provider, CURSOR_PROVIDER_ID);
  assert.equal(models[0].baseUrl, CURSOR_BASE_URL);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].thinkingLevelMap?.high, "high");
  assert.deepEqual(models[1].input, ["text"]);
  assert.equal(models[1].reasoning, false);
});

test("Cursor is an Aiden built-in with live SDK discovery and no secret projection", async (t) => {
  t.after(() => __testUtils.resetTurnQueue());
  const discovered: unknown[] = [];
  const provider = cursorProvider({
    discoverModels: async ({ apiKey, forceRefresh }) => {
      discovered.push({ apiKey, forceRefresh });
      return [
        {
          id: "composer-1.5",
          name: "Composer 1.5",
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ];
    },
  });
  const writes: Model<"openai-completions">[][] = [];
  await provider.refreshModels?.({
    allowNetwork: true,
    force: true,
    credential: { type: "api_key", key: "crsr_test_secret" },
    stored: undefined,
    publish: async (publication) => {
      if (publication.persist) {
        writes.push(publication.persist.models as Model<"openai-completions">[]);
      }
      publication.update?.();
      return true;
    },
    signal: new AbortController().signal,
  });

  assert.deepEqual(discovered, [{ apiKey: "crsr_test_secret", forceRefresh: true }]);
  assert.equal(provider.name, "Cursor");
  assert.equal(provider.baseUrl, CURSOR_BASE_URL);
  assert.equal(provider.auth.apiKey?.name, "Cursor API key");
  assert.equal(provider.getModels()[0]?.id, "composer-1.5");
  assert.equal(JSON.stringify(writes).includes("crsr_test_secret"), false);

  const models = registerAidenBuiltinProviders(createModels());
  assert.equal(models.getProvider("concentrate")?.name, "Concentrate");
  assert.equal(models.getProvider("cursor")?.name, "Cursor");
});

test("Cursor rejects empty catalogs and missing API keys", async () => {
  assert.throws(() => parseCursorModels([]), /no usable chat models/u);
  assert.throws(() => parseCursorModels({ data: [] }), /invalid model catalog/u);

  const provider = cursorProvider({
    discoverModels: async () => {
      throw new Error("should not discover without a key");
    },
  });
  assert.ok(provider.refreshModels);
  await assert.rejects(
    provider.refreshModels({
      allowNetwork: true,
      stored: undefined,
      publish: async (publication) => {
        publication.update?.();
        return true;
      },
      signal: new AbortController().signal,
    }),
    /needs an API key/u,
  );
});

test("Cursor streams bind the Aiden workspace and serialize overlapping turns", async (t) => {
  t.after(() => __testUtils.resetTurnQueue());
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const sessions: Array<string | undefined> = [];
  const provider = cursorProvider({
    discoverModels: async () => [],
    bindSession: async (binding) => {
      sessions.push(binding.cwd);
    },
    streamSimple: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const label = String(options?.headers?.["x-test"] ?? "turn");
      queueMicrotask(() => {
        void (async () => {
          order.push(`start:${label}`);
          if (label === "first") await firstGate;
          stream.end();
          order.push(`end:${label}`);
        })();
      });
      return stream;
    },
  });

  const model = {
    id: "auto",
    name: "Auto",
    api: "openai-completions" as const,
    provider: CURSOR_PROVIDER_ID,
    baseUrl: CURSOR_BASE_URL,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };

  const first = runWithCursorSession(
    {
      cwd: "/workspace/one",
      sessionId: "chat-1",
      sessionFile: "aiden:chat-1",
      projectTrusted: true,
    },
    () =>
      provider.streamSimple(model, { messages: [] }, { headers: { "x-test": "first" } }),
  );
  const second = runWithCursorSession(
    {
      cwd: "/workspace/two",
      sessionId: "chat-2",
      sessionFile: "aiden:chat-2",
      projectTrusted: true,
    },
    () =>
      provider.streamSimple(model, { messages: [] }, { headers: { "x-test": "second" } }),
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["start:first"]);
  assert.deepEqual(sessions, ["/workspace/one"]);
  releaseFirst?.();
  await Promise.all([drain(first), drain(second)]);
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  assert.deepEqual(sessions, ["/workspace/one", "/workspace/two"]);
  assert.equal(currentCursorSession(), undefined);
});

test("Cursor skips a queued turn that was aborted before it started", async (t) => {
  t.after(() => __testUtils.resetTurnQueue());
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const sessions: string[] = [];
  const provider = cursorProvider({
    discoverModels: async () => [],
    bindSession: async (binding) => {
      sessions.push(binding.cwd);
    },
    streamSimple: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const label = String(options?.headers?.["x-test"] ?? "turn");
      queueMicrotask(() => {
        void (async () => {
          order.push(`start:${label}`);
          if (label === "first") await firstGate;
          stream.end();
          order.push(`end:${label}`);
        })();
      });
      return stream;
    },
  });

  const model = {
    id: "auto",
    name: "Auto",
    api: "openai-completions" as const,
    provider: CURSOR_PROVIDER_ID,
    baseUrl: CURSOR_BASE_URL,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };

  const first = runWithCursorSession(
    {
      cwd: "/workspace/one",
      sessionId: "chat-1",
      sessionFile: "aiden:chat-1",
      projectTrusted: true,
    },
    () =>
      provider.streamSimple(model, { messages: [] }, { headers: { "x-test": "first" } }),
  );
  const aborted = new AbortController();
  const second = runWithCursorSession(
    {
      cwd: "/workspace/two",
      sessionId: "chat-2",
      sessionFile: "aiden:chat-2",
      projectTrusted: true,
    },
    () =>
      provider.streamSimple(model, { messages: [] }, {
        headers: { "x-test": "second" },
        signal: aborted.signal,
      }),
  );
  aborted.abort();
  releaseFirst?.();
  const secondEvents: unknown[] = [];
  await drain(first);
  for await (const event of second) {
    secondEvents.push(event);
  }
  assert.deepEqual(order, ["start:first", "end:first"]);
  assert.deepEqual(sessions, ["/workspace/one"]);
  assert.equal((secondEvents[0] as { type?: string; reason?: string })?.type, "error");
  assert.equal((secondEvents[0] as { reason?: string })?.reason, "aborted");
});

test("Cursor binds an untrusted unbound session when no chat wrapper is present", async (t) => {
  t.after(() => __testUtils.resetTurnQueue());
  const sessions: Array<{ cwd: string; sessionFile: string; projectTrusted: boolean }> = [];
  const provider = cursorProvider({
    discoverModels: async () => [],
    bindSession: async (binding) => {
      sessions.push({
        cwd: binding.cwd,
        sessionFile: binding.sessionFile,
        projectTrusted: binding.projectTrusted,
      });
    },
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    },
  });
  const model = {
    id: "auto",
    name: "Auto",
    api: "openai-completions" as const,
    provider: CURSOR_PROVIDER_ID,
    baseUrl: CURSOR_BASE_URL,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  await drain(provider.streamSimple(model, { messages: [] }));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.sessionFile, "aiden:unbound");
  assert.equal(sessions[0]?.projectTrusted, false);
});
