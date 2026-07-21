import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMutableProviderId,
  forwardCodexProviderStatusChanges,
  mergeCodexProvider,
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
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        api: "openai-codex-responses",
        reasoning: true,
        vision: true,
        contextWindow: 372_000,
        maxTokens: 128_000,
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
    defaultModel: "gpt-5.4",
    needsKey: true,
    isPreset: true,
    hasKey: true,
  });
});

test("filters reserved stored collisions and rejects generic credential management", () => {
  const collision = { ...legacy, id: "openai-codex", label: "Unsafe custom collision" };
  assert.deepEqual(mergeCodexProvider([collision, legacy], null), [legacy]);
  assert.throws(() => assertMutableProviderId("openai-codex"), /built-in sign-in/u);
  assert.doesNotThrow(() => assertMutableProviderId("custom-provider"));
});

test("forwards each main-process Codex status signal to the global renderer channel", () => {
  let listener = (_needsAttention: boolean): void => undefined;
  let unsubscribed = false;
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
  unsubscribe();
  assert.equal(unsubscribed, true);
});
