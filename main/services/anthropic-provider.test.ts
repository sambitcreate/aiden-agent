import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichAnthropicProviders,
  migrateLegacyAnthropicPreset,
  parseAnthropicThinkingSelection,
} from "./anthropic-provider.js";
import type { Provider } from "./types.js";

const provider: Provider = {
  id: "anthropic",
  kind: "anthropic",
  label: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  models: ["claude-opus-4-8", "unknown-model"],
  needsKey: true,
  hasKey: true,
};

test("projects pinned Claude effort capabilities onto configured models", () => {
  const [enriched] = enrichAnthropicProviders([provider]);
  assert.deepEqual(
    enriched.modelMetadata?.["claude-opus-4-8"]?.thinkingLevels,
    ["off", "low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(
    enriched.modelMetadata?.["unknown-model"],
    undefined,
  );
});

test("refreshes only the untouched legacy Anthropic preset", () => {
  const config = {
    providers: [
      {
        ...provider,
        models: [
          "claude-sonnet-4-20250514",
          "claude-3-7-sonnet-latest",
          "claude-3-5-haiku-latest",
        ],
        defaultModel: "claude-sonnet-4-20250514",
        isPreset: true,
      },
    ],
    settings: {
      lastProviderId: "anthropic",
      lastModel: "claude-sonnet-4-20250514",
    },
  };
  assert.equal(migrateLegacyAnthropicPreset(config), true);
  assert.deepEqual(config.providers[0]?.models, [
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
  ]);
  assert.equal(config.settings.lastModel, "claude-sonnet-5");

  config.providers[0]!.models = ["custom-claude"];
  assert.equal(migrateLegacyAnthropicPreset(config), false);
  assert.deepEqual(config.providers[0]?.models, ["custom-claude"]);
});

test("accepts only exact model-supported Claude effort selections", () => {
  assert.deepEqual(
    parseAnthropicThinkingSelection("claude-opus-4-8", "max"),
    { modelId: "claude-opus-4-8", level: "max" },
  );
  assert.throws(
    () => parseAnthropicThinkingSelection("claude-opus-4-6", "xhigh"),
    /not supported/u,
  );
  assert.throws(
    () => parseAnthropicThinkingSelection("unknown-model", "high"),
    /does not support/u,
  );
});
