import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMutableProviderId,
  forwardCodexProviderStatusChanges,
  mergeCodexProvider,
  providerDisplayLabel,
} from "./provider-list-core.js";
import type { CodexProviderSnapshot } from "./codex-provider.js";
import type { Provider } from "./types.js";

const legacy: Provider = {
  id: "openai",
  kind: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-4.1"],
  defaultModel: "gpt-4.1",
  needsKey: true,
  isPreset: true,
  hasKey: true,
};

function snapshot(configured: boolean): CodexProviderSnapshot {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    authName: "OpenAI (ChatGPT Plus/Pro)",
    configured,
    needsAttention: false,
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        reasoning: true,
        vision: true,
        contextWindow: 272_000,
        maxTokens: 128_000,
        thinkingLevels: ["low", "medium", "high", "xhigh"],
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        api: "openai-codex-responses",
        reasoning: true,
        vision: true,
        contextWindow: 372_000,
        maxTokens: 128_000,
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ],
  };
}

test("exposes the virtual Codex provider only for configured OAuth", () => {
  assert.deepEqual(mergeCodexProvider([legacy], snapshot(false)), [legacy]);
  assert.deepEqual(mergeCodexProvider([legacy], { ...snapshot(true), needsAttention: true }), [
    legacy,
  ]);

  const merged = mergeCodexProvider([legacy], snapshot(true));
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1], {
    id: "openai-codex",
    kind: "openai",
    label: "ChatGPT / Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    models: ["gpt-5.4", "gpt-5.6-sol"],
    modelMetadata: {
      "gpt-5.4": {
        source: "provider",
        name: "GPT-5.4",
        type: "llm",
        vision: true,
        toolCall: true,
        reasoning: true,
        thinkingLevels: ["low", "medium", "high", "xhigh"],
        contextLength: 272_000,
      },
      "gpt-5.6-sol": {
        source: "provider",
        name: "GPT-5.6 Sol",
        type: "llm",
        vision: true,
        toolCall: true,
        reasoning: true,
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        contextLength: 372_000,
      },
    },
    defaultModel: "gpt-5.4",
    needsKey: true,
    isPreset: true,
    isBuiltin: true,
    hasKey: true,
    canLogout: true,
  });
});

test("filters reserved stored collisions and rejects generic credential management", () => {
  const collision = {
    ...legacy,
    id: "openai-codex",
    label: "Unsafe custom collision",
  };
  assert.deepEqual(mergeCodexProvider([collision, legacy], null), [legacy]);
  assert.throws(() => assertMutableProviderId("openai-codex"), /built-in sign-in/u);
  assert.doesNotThrow(() => assertMutableProviderId("custom-provider"));
});

test("uses the concise OpenCode Zen product name", () => {
  assert.equal(providerDisplayLabel("opencode-go", "OpenCode Zen Go"), "OpenCode Zen");
  assert.equal(providerDisplayLabel("opencode", "OpenCode Zen"), "OpenCode Zen");
  assert.equal(providerDisplayLabel("openai", "OpenAI"), "OpenAI");
});

test("forwards each main-process Codex status signal to the global renderer channel", () => {
  let listener = (_needsAttention: boolean): void => undefined;
  let unsubscribed = false;
  let authorityChanges = 0;
  const events: Array<{ channel: string; event: unknown }> = [];
  const unsubscribe = forwardCodexProviderStatusChanges(
    {
      onStatusChange: (next) => {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
    },
    (channel, event) => events.push({ channel, event }),
    () => {
      authorityChanges += 1;
    },
  );

  listener(false);
  listener(true);

  assert.deepEqual(events, [
    {
      channel: "providers:auth:status-changed",
      event: { providerId: "openai-codex", needsAttention: false },
    },
    {
      channel: "providers:auth:status-changed",
      event: { providerId: "openai-codex", needsAttention: true },
    },
  ]);
  assert.equal(authorityChanges, 2);
  unsubscribe();
  assert.equal(unsubscribed, true);
});
