import assert from "node:assert/strict";
import test from "node:test";

import {
  migratePiProviderConfig,
  type ProviderConfigMigrationShape,
} from "./provider-config-migration-core.js";
import type { StoredProvider } from "./types.js";
import { MAX_CONFIG_ID_LENGTH } from "./types.js";

function provider(
  id: string,
  baseUrl: string,
  overrides: Partial<StoredProvider> = {},
): StoredProvider {
  return {
    id,
    kind: "openai",
    label: id,
    baseUrl,
    models: [],
    needsKey: true,
    isPreset: true,
    deployment: "hosted",
    ...overrides,
  };
}

function openAiPreset(): StoredProvider {
  return provider("openai", "https://api.openai.com/v1", {
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
    defaultModel: "gpt-4o",
  });
}

function moonshotPreset(): StoredProvider {
  return provider("moonshot", "https://api.moonshot.ai/v1", {
    label: "Moonshot (Kimi)",
    models: ["kimi-k2-0711-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
    defaultModel: "kimi-k2-0711-preview",
  });
}

test("removes only untouched cloud presets and namespaces legacy local connections", () => {
  const config: ProviderConfigMigrationShape = {
    providers: [
      openAiPreset(),
      moonshotPreset(),
      provider("lmstudio", "http://localhost:1234/v1", {
        label: "LM Studio (local)",
        needsKey: false,
        deployment: "local",
      }),
      provider("ollama", "http://localhost:11434/v1", {
        label: "Ollama (local)",
        needsKey: false,
        deployment: "local",
      }),
    ],
    settings: { lastProviderId: "moonshot" },
  };

  assert.equal(migratePiProviderConfig(config), true);
  assert.equal(config.settings.lastProviderId, "moonshotai");
  assert.deepEqual(config.providerIdAliases, {
    lmstudio: "custom:lmstudio",
    ollama: "custom:ollama",
  });
  assert.deepEqual(
    config.providers.map((item) => item.id),
    ["custom:lmstudio", "custom:ollama"],
  );
  assert.equal(migratePiProviderConfig(config), false);
});

test("keeps every edited preset custom and never lets a future Pi ID claim it", () => {
  const config: ProviderConfigMigrationShape = {
    providers: [
      provider("openai", "https://gateway.example.test/v1", {
        label: "Work gateway",
        defaultModel: "my-fine-tune",
        models: ["my-fine-tune"],
        modelMetadata: { "my-fine-tune": { source: "provider", reasoning: true } },
      }),
      provider("custom:openai-legacy", "https://already-used.example.test/v1", {
        isPreset: false,
      }),
    ],
    settings: { lastProviderId: "openai" },
  };

  assert.equal(migratePiProviderConfig(config), true);
  assert.equal(config.settings.lastProviderId, "custom:openai-legacy-2");
  assert.deepEqual(config.providerIdAliases, { openai: "custom:openai-legacy-2" });
  assert.deepEqual(config.providers[0], {
    ...provider("custom:openai-legacy-2", "https://gateway.example.test/v1", {
      label: "Work gateway (custom)",
      defaultModel: "my-fine-tune",
      models: ["my-fine-tune"],
      modelMetadata: { "my-fine-tune": { source: "provider", reasoning: true } },
      isPreset: false,
      isBuiltin: false,
    }),
  });
});

test("generated IDs avoid alias sources and remembered providers resolve to the terminal alias", () => {
  const config: ProviderConfigMigrationShape = {
    providers: [
      provider("foo", "http://localhost:1234/v1", {
        needsKey: false,
        deployment: "local",
      }),
    ],
    providerIdAliases: {
      "custom:foo": "foo",
    },
    settings: { lastProviderId: "custom:foo" },
  };

  assert.equal(migratePiProviderConfig(config), true);
  assert.deepEqual(
    config.providers.map(({ id }) => id),
    ["custom:foo-2"],
  );
  assert.deepEqual(config.providerIdAliases, {
    "custom:foo": "custom:foo-2",
    foo: "custom:foo-2",
  });
  assert.equal(config.settings.lastProviderId, "custom:foo-2");
  assert.equal(migratePiProviderConfig(config), false);
});

test("generated custom IDs stay inside the portable schema budget", () => {
  const sourceId = "x".repeat(MAX_CONFIG_ID_LENGTH);
  const config: ProviderConfigMigrationShape = {
    providers: [
      provider(sourceId, "http://localhost:1234/v1", {
        needsKey: false,
        deployment: "local",
      }),
    ],
    settings: { lastProviderId: sourceId },
  };

  assert.equal(migratePiProviderConfig(config), true);
  const [migrated] = config.providers;
  assert.ok(migrated);
  assert.equal(migrated.id.length, MAX_CONFIG_ID_LENGTH);
  assert.equal(config.providerIdAliases?.[sourceId], migrated.id);
  assert.equal(config.settings.lastProviderId, migrated.id);
  assert.equal(migratePiProviderConfig(config), false);
});
