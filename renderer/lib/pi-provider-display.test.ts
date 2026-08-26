import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  FEATURED_PI_PROVIDER_IDS,
  PROVIDER_ICON_SLUGS,
  canConfigureOnboardingBuiltinProvider,
  getOnboardingMoreProviders,
  isOnboardingBuiltinProviderReady,
  onboardingBuiltinProviderSetupLabel,
  resolveProviderIconSlug,
  splitPiBuiltinProviders,
} from "./pi-provider-display.js";

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

test("keeps the selected Pi providers first in product order and puts every other provider under More", () => {
  const providers = [
    { id: "cloudflare-workers-ai" },
    { id: "concentrate" },
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
    [
      "openai",
      "anthropic",
      "concentrate",
      "opencode",
      "opencode-go",
      "zai-coding-cn",
      "kimi-coding",
    ],
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

test("onboarding reveals every other Pi provider in stable product order", () => {
  const providers = [
    { id: "custom:ollama", isBuiltin: false },
    { id: "groq", isBuiltin: true },
    { id: "openai-codex", isBuiltin: true },
    { id: "google", isBuiltin: true },
    { id: "future-pi-provider", isBuiltin: true },
    { id: "anthropic", isBuiltin: true },
    { id: "openai", isBuiltin: true },
    { id: "deepseek", isBuiltin: true },
  ];

  assert.deepEqual(
    getOnboardingMoreProviders(providers).map((provider) => provider.id),
    ["google", "deepseek", "groq", "future-pi-provider"],
  );
});

test("onboarding can configure every provider with an interactive credential method", () => {
  const apiKeyProvider = {
    hasKey: false,
    models: ["chat-model"],
    authMethods: [{ type: "api_key" as const, canLogin: true }],
  };
  const oauthProvider = {
    ...apiKeyProvider,
    authMethods: [{ type: "oauth" as const, canLogin: true }],
  };
  const flexibleProvider = {
    ...apiKeyProvider,
    authMethods: [
      { type: "api_key" as const, canLogin: true },
      { type: "oauth" as const, canLogin: true },
    ],
  };

  assert.equal(canConfigureOnboardingBuiltinProvider(apiKeyProvider), true);
  assert.equal(onboardingBuiltinProviderSetupLabel(apiKeyProvider), "Add your API key");
  assert.equal(canConfigureOnboardingBuiltinProvider(oauthProvider), true);
  assert.equal(onboardingBuiltinProviderSetupLabel(oauthProvider), "Sign in to connect");
  assert.equal(canConfigureOnboardingBuiltinProvider(flexibleProvider), true);
  assert.equal(onboardingBuiltinProviderSetupLabel(flexibleProvider), "Add an API key or sign in");
});

test("onboarding distinguishes ready providers from unavailable setup methods", () => {
  const readyProvider = {
    hasKey: true,
    models: ["chat-model"],
    authMethods: [{ type: "api_key" as const, canLogin: false }],
  };
  const unavailableProvider = {
    hasKey: false,
    models: ["chat-model"],
    authMethods: [{ type: "api_key" as const, canLogin: false }],
  };

  assert.equal(isOnboardingBuiltinProviderReady(readyProvider), true);
  assert.equal(canConfigureOnboardingBuiltinProvider(readyProvider), true);
  assert.equal(onboardingBuiltinProviderSetupLabel(readyProvider), "Ready to use");
  assert.equal(isOnboardingBuiltinProviderReady(unavailableProvider), false);
  assert.equal(canConfigureOnboardingBuiltinProvider(unavailableProvider), false);
  assert.equal(
    onboardingBuiltinProviderSetupLabel(unavailableProvider),
    "Available in Settings after onboarding",
  );
});

test("resolves provider logos without branding unknown custom or future providers", () => {
  assert.equal(resolveProviderIconSlug("openai"), "openai");
  assert.equal(resolveProviderIconSlug("concentrate"), "concentrate");
  assert.equal(resolveProviderIconSlug("together"), "together");
  assert.equal(resolveProviderIconSlug("custom:lmstudio"), "lmstudio");
  assert.equal(resolveProviderIconSlug("custom:ollama"), "ollama");
  assert.equal(resolveProviderIconSlug("gemini"), "google");
  assert.equal(resolveProviderIconSlug("moonshot"), "moonshotai");
  assert.equal(resolveProviderIconSlug("radius"), undefined);
  assert.equal(resolveProviderIconSlug("custom:connection-abc"), undefined);
  assert.equal(resolveProviderIconSlug("future-pi-provider"), undefined);
});

test("numeric local-provider collision siblings retain their product logos", () => {
  assert.equal(resolveProviderIconSlug("custom:lmstudio-2"), "lmstudio");
  assert.equal(resolveProviderIconSlug("custom:lmstudio-10"), "lmstudio");
  assert.equal(resolveProviderIconSlug("custom:ollama-2"), "ollama");
  assert.equal(resolveProviderIconSlug("custom:ollama-42"), "ollama");

  assert.equal(resolveProviderIconSlug("custom:lmstudio-1"), undefined);
  assert.equal(resolveProviderIconSlug("custom:lmstudio-02"), undefined);
  assert.equal(resolveProviderIconSlug("custom:ollama-copy"), undefined);
});

test("uses product marks for Claude and Grok models while keeping provider marks elsewhere", () => {
  assert.equal(resolveProviderIconSlug("anthropic"), "anthropic");
  assert.equal(resolveProviderIconSlug("anthropic", "claude-sonnet-4"), "claude");
  assert.equal(resolveProviderIconSlug("xai"), "xai");
  assert.equal(resolveProviderIconSlug("xai", "grok-4-fast"), "grok");
  assert.equal(resolveProviderIconSlug("openrouter", "anthropic/claude-sonnet-4"), "openrouter");
  assert.equal(resolveProviderIconSlug("opencode", "anthropic/claude-sonnet-4"), "opencode");
  assert.equal(
    resolveProviderIconSlug("custom:connection-abc", "anthropic/claude-sonnet-4"),
    undefined,
  );
});

test("bundled provider icons stay compact, vector-only, and complete for mapped slugs", () => {
  const assetDirectory = new URL("../assets/provider-logos/", import.meta.url);
  const svgNames = readdirSync(assetDirectory).filter((name) => name.endsWith(".svg"));

  for (const slug of PROVIDER_ICON_SLUGS) {
    assert.equal(existsSync(new URL(`${slug}.svg`, assetDirectory)), true, `${slug} asset`);
  }

  for (const svgName of svgNames) {
    const source = readFileSync(new URL(svgName, assetDirectory), "utf8");
    assert.doesNotMatch(
      source,
      /<(?:foreignObject|image|script)\b|\bon\w+\s*=|data:image/iu,
      `${svgName} must remain an isolated vector asset`,
    );
    const viewBox = source
      .match(/\bviewBox=["']\s*([^"']+)/iu)?.[1]
      ?.trim()
      .split(/\s+/u)
      .map(Number);
    assert.equal(viewBox?.length, 4, `${svgName} needs a viewBox`);
    const [, , width = 0, height = 0] = viewBox ?? [];
    assert.ok(width > 0 && height > 0, `${svgName} needs positive dimensions`);
    assert.ok(
      Math.max(width / height, height / width) <= 2,
      `${svgName} must use a compact logomark viewBox`,
    );
  }
});

test("provider marks and icon wells remain theme-aware in both appearances", () => {
  const providerIconSource = readFileSync(
    new URL("../components/provider-icon.tsx", import.meta.url),
    "utf8",
  );
  const providersSettingsSource = readFileSync(
    new URL("../components/settings/providers-settings.tsx", import.meta.url),
    "utf8",
  );
  const codexProviderSettingsSource = readFileSync(
    new URL("../components/settings/codex-provider-settings.tsx", import.meta.url),
    "utf8",
  );
  const multicolorProviderSlugs = providerIconSource.match(
    /const MULTICOLOR_PROVIDER_ICON_SLUGS[\s\S]*?\]\);/u,
  )?.[0];

  assert.ok(multicolorProviderSlugs);
  assert.doesNotMatch(multicolorProviderSlugs, /"ant-ling"/u);
  assert.match(multicolorProviderSlugs, /"fireworks"/u);
  assert.match(providerIconSource, /backgroundColor: "currentColor"/u);
  assert.doesNotMatch(
    `${providersSettingsSource}\n${codexProviderSettingsSource}`,
    /bg-surface-subtle/u,
  );
  assert.equal(occurrences(providersSettingsSource, "rounded-control bg-well text-secondary"), 3);
  assert.equal(
    occurrences(codexProviderSettingsSource, "rounded-control bg-well text-secondary"),
    1,
  );
  assert.match(providersSettingsSource, />Built into Aiden</u);
  assert.doesNotMatch(providersSettingsSource, /Built into Pi|Pi model|Pi-native/u);
  assert.match(providersSettingsSource, /className="providers-settings flex flex-col gap-6"/u);
  assert.match(providersSettingsSource, /<ProviderInfo[\s\S]*About providers built into Aiden/u);
  assert.match(providersSettingsSource, /<details className="group border-t border-separator">/u);
  assert.match(providersSettingsSource, /Chat title generation/u);
  assert.match(providersSettingsSource, /customProviders\.length > 0/u);
  assert.equal(
    occurrences(providersSettingsSource, "group-data-[highlighted]:text-accent-foreground"),
    6,
  );
});
