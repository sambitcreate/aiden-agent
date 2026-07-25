import assert from "node:assert/strict";
import test from "node:test";
import { FEATURED_PI_PROVIDER_IDS, splitPiBuiltinProviders } from "./pi-provider-display.js";

test("keeps the selected Pi providers first in product order and puts every other provider under More", () => {
  const providers = [
    { id: "cloudflare-workers-ai" },
    { id: "opencode-go" },
    { id: "groq" },
    { id: "openai" },
    { id: "mistral" },
    { id: "zai-coding-cn" },
    { id: "amazon-bedrock" },
    { id: "opencode" },
    { id: "kimi-coding" },
    { id: "anthropic" },
  ];

  const { featured, more } = splitPiBuiltinProviders(providers);

  assert.deepEqual(
    featured.map((provider) => provider.id),
    ["openai", "anthropic", "opencode", "opencode-go", "zai-coding-cn", "kimi-coding"],
  );
  assert.deepEqual(
    more.map((provider) => provider.id),
    ["cloudflare-workers-ai", "groq", "mistral", "amazon-bedrock"],
  );
});

test("safely places a Pi provider added after this release under More", () => {
  const { featured, more } = splitPiBuiltinProviders([
    { id: FEATURED_PI_PROVIDER_IDS[0] },
    { id: "future-pi-provider" },
  ]);

  assert.deepEqual(
    featured.map((provider) => provider.id),
    ["openai"],
  );
  assert.deepEqual(
    more.map((provider) => provider.id),
    ["future-pi-provider"],
  );
});
