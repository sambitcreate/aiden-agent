import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { promptCacheTtlMs } from "./prompt-cache-lifetimes.js";

const require = createRequire(import.meta.url);
const catalogDir = join(dirname(require.resolve("@earendil-works/pi-ai/package.json")), "dist/providers/data");

function* catalogModels(value: unknown): Generator<Model<Api>> {
  if (!value || typeof value !== "object") return;
  if ("api" in value && "id" in value) { yield value as Model<Api>; return; }
  for (const child of Object.values(value)) yield* catalogModels(child);
}

/** The shipped Pi catalog entry, so the lifetimes follow the real model metadata. */
function catalogModel(provider: string, id: string): Model<Api> {
  const catalog = JSON.parse(readFileSync(join(catalogDir, `${provider}.json`), "utf8"));
  const model = [...catalogModels(catalog)].find((candidate) => candidate.id === id);
  assert.ok(model, `${provider}/${id} is in the catalog`);
  return model;
}

const MINUTE = 60_000;

test("Claude keeps Anthropic's five-minute cache wherever Aiden sends cache markers", () => {
  assert.equal(promptCacheTtlMs(catalogModel("anthropic", "claude-opus-5")), 5 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0")), 5 * MINUTE);
  // OpenRouter serves Claude over chat completions with Anthropic-style markers.
  const openRouterClaude = [...catalogModels(JSON.parse(readFileSync(join(catalogDir, "openrouter.json"), "utf8")))]
    .find((model) => model.id.includes("claude") && model.api === "openai-completions");
  assert.ok(openRouterClaude);
  assert.equal(promptCacheTtlMs(openRouterClaude), 5 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("cloudflare-ai-gateway", "claude-haiku-4-5")), 5 * MINUTE);
});

test("Bedrock times only the models it caches", () => {
  assert.equal(promptCacheTtlMs(catalogModel("amazon-bedrock", "amazon.nova-lite-v1:0")), 5 * MINUTE);
  const uncached = [...catalogModels(JSON.parse(readFileSync(join(catalogDir, "amazon-bedrock.json"), "utf8")))]
    .find((model) => !model.id.includes("claude") && !model.id.includes("nova"));
  assert.ok(uncached);
  assert.equal(promptCacheTtlMs(uncached), 0);
});

test("OpenAI's fixed 30-minute cache starts at GPT-5.6; earlier models only give a range", () => {
  assert.equal(promptCacheTtlMs(catalogModel("openai", "gpt-5.6-sol")), 30 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("azure", "gpt-6-sol")), 30 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("openai", "gpt-5.5")), 0);
  assert.equal(promptCacheTtlMs(catalogModel("azure", "gpt-5.4")), 0);
});

test("GitHub Copilot publishes its own idle lifetimes per model family", () => {
  assert.equal(promptCacheTtlMs(catalogModel("github-copilot", "claude-sonnet-5")), 60 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("github-copilot", "gpt-5.6-sol")), 24 * 60 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("github-copilot", "gemini-3.8-flash")), 0);
});

test("Kimi K3 and MiniMax M2 use five minutes; models and providers without a documented lifetime show none", () => {
  assert.equal(promptCacheTtlMs(catalogModel("moonshotai", "kimi-k3")), 5 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("moonshotai", "kimi-k2.6")), 0);
  assert.equal(promptCacheTtlMs(catalogModel("moonshotai-cn", "kimi-k2.7-code")), 0);
  assert.equal(promptCacheTtlMs(catalogModel("minimax", "MiniMax-M2.7")), 5 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("minimax-cn", "MiniMax-M2.7-highspeed")), 5 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("minimax", "MiniMax-M3")), 0);
  for (const provider of ["google", "xai", "deepseek", "zai", "mistral", "groq", "fireworks", "kimi-coding"]) {
    for (const model of catalogModels(JSON.parse(readFileSync(join(catalogDir, `${provider}.json`), "utf8")))) {
      assert.equal(promptCacheTtlMs(model), 0, `${provider}/${model.id}`);
    }
  }
});

test("a lifetime the catalog declares wins, and a broken one shows nothing", () => {
  const custom = { provider: "custom-proxy", id: "claude-opus-5", api: "anthropic-messages" as Api };
  assert.equal(promptCacheTtlMs({ ...custom, promptCache: { short: 120 } }), 2 * MINUTE);
  assert.equal(promptCacheTtlMs({ ...custom, promptCache: { short: Number.NaN } }), 0);
  assert.equal(promptCacheTtlMs(custom), 5 * MINUTE);
});

test("an hour-long retention is timed only where the provider keeps an hour, and no caching has no lifetime", () => {
  const anthropic = catalogModel("anthropic", "claude-opus-5");
  assert.equal(promptCacheTtlMs(anthropic, "long"), 60 * MINUTE);
  assert.equal(promptCacheTtlMs(anthropic, "none"), 0);
  assert.equal(promptCacheTtlMs({ ...anthropic, compat: { supportsLongCacheRetention: false } }, "long"), 5 * MINUTE, "an endpoint that refuses the hour keeps the default");
  assert.equal(promptCacheTtlMs(catalogModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "long"), 60 * MINUTE);
  assert.equal(promptCacheTtlMs(catalogModel("amazon-bedrock", "global.anthropic.claude-fable-5-1"), "long"), 60 * MINUTE);
  // Bedrock keeps an hour only for the 4.5 and later Claude models.
  assert.equal(promptCacheTtlMs(catalogModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0"), "long"), 0);
  assert.equal(promptCacheTtlMs(catalogModel("amazon-bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0"), "long"), 0);
  // Gateways and other providers are not on the allowlist, even for Claude.
  assert.equal(promptCacheTtlMs(catalogModel("cloudflare-ai-gateway", "claude-haiku-4-5"), "long"), 0);
  assert.equal(promptCacheTtlMs(catalogModel("openai", "gpt-5.6-sol"), "long"), 0);
  const custom = { provider: "custom-proxy", id: "claude-opus-5", api: "anthropic-messages" as Api };
  assert.equal(promptCacheTtlMs({ ...custom, promptCache: { short: 300, long: 1800 } }, "long"), 30 * MINUTE);
});
