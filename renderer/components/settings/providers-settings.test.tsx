import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { ProvidersSettings } from "./providers-settings";

afterEach(cleanup);

test("connecting an Anthropic key retries rejection, then updates the saved connection list", async () => {
  let accepted = false;
  const provider = () => ({
    id: "anthropic", label: "Anthropic", isBuiltin: true, needsKey: true, hasKey: accepted,
    models: ["fixture-model"], authMethods: [{ type: "api_key", canLogin: true, label: "API key" }],
  });
  const calls = installBotTestIpc({
    "providers:list": () => [provider()],
    "providers:auth:status": () => ({ configured: false }),
    "providers:catalogStatus": () => ({ source: "bundled" }),
    "settings:get": () => ({}),
    "providers:validateOnboardingApiKey": (id, key) => {
      assert.equal(id, "anthropic");
      if (key !== "accepted-fixture") throw new Error("Key rejected");
      accepted = true;
      return { provider: provider() };
    },
  });
  render(<QueryClientProvider client={createBotTestQueryClient()}><ProvidersSettings /></QueryClientProvider>);
  await screen.findByText("Give Aiden a way to reply");
  fireEvent.click(screen.getByRole("button", { name: "Connect AI" }));
  fireEvent.click(screen.getByRole("button", { name: /I have an API key/u }));
  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  const input = await screen.findByPlaceholderText("Paste your API key");
  assert.equal(calls.some(call => ["providers:auth:start", "providers:validateOnboardingApiKey", "providers:updateCatalogs"].includes(call.channel)), false);
  fireEvent.change(input, { target: { value: "bad-fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
  await screen.findByRole("alert");
  fireEvent.change(input, { target: { value: "accepted-fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
  await screen.findByRole("button", { name: "Manage" });
  await waitFor(() => assert.ok(!screen.queryByRole("dialog"), "setup dialog should close"));
  assert.ok(screen.getByText("fixture-model"));
});

test("checking an existing local server preserves overrides and manual entries, and retries an empty server", async () => {
  const provider = { id: "custom:lmstudio", kind: "openai", label: "Private Studio", baseUrl: "http://studio.test/v1",
    needsKey: false, hasKey: false, models: ["local", "manual"], defaultModel: "local",
    modelMetadata: { local: { source: "provider", overrides: { contextWindow: 16000 } }, manual: { source: "provider", manuallyAdded: true } } };
  let empty = true;
  const calls = installBotTestIpc({
    "providers:list": () => [provider],
    "providers:auth:status": () => ({ configured: false }),
    "providers:catalogStatus": () => ({ source: "bundled" }),
    "settings:get": () => ({}),
    "providers:test": () => ({ models: empty ? [] : ["local"], modelMetadata: { local: { source: "provider", reasoning: true } } }),
    "providers:save": draft => draft,
  });
  render(<QueryClientProvider client={createBotTestQueryClient()}><ProvidersSettings /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Connect another AI" }));
  fireEvent.click(screen.getByRole("button", { name: /I run a local model/u }));
  fireEvent.click(screen.getByRole("button", { name: "LM Studio" }));
  assert.equal(calls.some(c => c.channel === "providers:test"), false);
  fireEvent.click(screen.getByRole("button", { name: "Check for models" }));
  await screen.findByText(/Server reached, but no chat models were found/u);
  assert.equal(calls.some(c => c.channel === "providers:save"), false);
  empty = false;
  fireEvent.click(screen.getByRole("button", { name: "Check for models" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog"), "setup dialog should close"));
  const saved = calls.find(c => c.channel === "providers:save")?.args[0] as typeof provider;
  assert.equal(saved.baseUrl, "http://studio.test/v1");
  assert.deepEqual(saved.models, ["local", "manual"]);
  assert.deepEqual(saved.modelMetadata.local, { source: "provider", reasoning: true, overrides: { contextWindow: 16000 } });
  assert.equal(saved.modelMetadata.manual.manuallyAdded, true);
});
