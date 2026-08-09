import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  makeOnboardingProvider,
  OnboardingFlow,
  shouldShowOnboarding,
} from "./onboarding-flow.js";

const storageKey = "aiden:onboarding:v1:complete";

function withLocalStorage(run: (storage: Map<string, string>) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    run(values);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

function renderOnboarding(): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OnboardingFlow />
    </QueryClientProvider>,
  );
}

test("onboarding appears only until it is completed", () => {
  withLocalStorage((storage) => {
    assert.equal(shouldShowOnboarding(), true);

    const markup = renderOnboarding();
    assert.match(markup, /Step 1 of 3/u);
    assert.match(markup, /What should Aiden call you\?/u);
    assert.match(markup, /<button[^>]*disabled=""[^>]*>.*?Next/u);
    assert.match(markup, />Skip<\/button>/u);

    storage.set(storageKey, "true");
    assert.equal(shouldShowOnboarding(), false);
    assert.equal(renderOnboarding(), "");
  });
});

test("onboarding provider choices preserve local and hosted defaults", () => {
  assert.equal(makeOnboardingProvider("openai-signin", ""), null);
  assert.deepEqual(makeOnboardingProvider("openai-key", ""), {
    id: "custom:onboarding-openai",
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini"],
    defaultModel: "gpt-4.1-mini",
    needsKey: true,
    deployment: "hosted",
  });
  assert.deepEqual(makeOnboardingProvider("anthropic", "https://gateway.example/v1"), {
    id: "custom:onboarding-anthropic",
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "https://gateway.example/v1",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    defaultModel: "claude-sonnet-4-5",
    needsKey: true,
    deployment: "hosted",
  });
  assert.deepEqual(makeOnboardingProvider("lmstudio", ""), {
    id: "custom:onboarding-lmstudio",
    kind: "openai",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: [],
    needsKey: false,
    deployment: "local",
  });
  assert.deepEqual(makeOnboardingProvider("ollama", ""), {
    id: "custom:onboarding-ollama",
    kind: "openai",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [],
    needsKey: false,
    deployment: "local",
  });
  assert.deepEqual(makeOnboardingProvider("tailscale", "https://model.tailnet.ts.net/v1"), {
    id: "custom:onboarding-tailscale",
    kind: "openai",
    label: "Tailscale model",
    baseUrl: "https://model.tailnet.ts.net/v1",
    models: [],
    needsKey: false,
    deployment: "local",
  });
});
