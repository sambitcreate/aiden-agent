import assert from "node:assert/strict";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { MCP_PRESETS, presetServerId } from "../mcp-presets.js";
import type { StoredProvider } from "../types.js";
import {
  reportChatMessageSent,
  reportConnectorAdded,
  reportCustomProviderConnected,
} from "./analytics-feature-reports.js";
import { analyticsModelId, analyticsProviderId, analyticsRunTrigger, analyticsWorkspaceKind } from "./analytics-ids.js";
import { analyticsSettled, captureAnalyticsEvents } from "./test-support.js";

test("a built-in provider and its catalog model are sent, folded to the registry's lowercase", () => {
  assert.equal(analyticsProviderId("anthropic"), "anthropic");
  assert.equal(analyticsModelId("anthropic", "not-a-listed-model"), "custom");
  const listed = builtinProviders()
    .flatMap((provider) => provider.getModels().map((model) => ({ provider: provider.id, id: model.id })))
    .find((model) => /^[A-Z]/u.test(model.id) && model.id.length < 80);
  assert.ok(listed, "the bundled catalog carries a mixed-case model id");
  assert.equal(analyticsModelId(listed.provider, listed.id), listed.id.toLowerCase());
});

test("names and addresses a person chose never leave as an id", () => {
  for (const value of ["my-private-gateway", "https://llm.example.test/v1", "/Users/person/model", "", undefined]) {
    assert.equal(analyticsProviderId(value as string), "custom");
    assert.equal(analyticsModelId("anthropic", value as string), "custom");
    assert.equal(analyticsModelId(value as string, "gpt-5.4"), "custom");
  }
});

test("a workspace is named by its kind, and a hidden No workspace folder is not a workspace", () => {
  assert.equal(analyticsWorkspaceKind({}), "folder");
  assert.equal(analyticsWorkspaceKind({ scratch: true }), "scratch");
  assert.equal(analyticsWorkspaceKind({ noWorkspace: true, scratch: true }), "none");
  assert.equal(analyticsWorkspaceKind(undefined), "none");
});

test("an event-started run is named by its source", () => {
  assert.equal(analyticsRunTrigger({ kind: "manual", key: "k" }), "manual");
  assert.equal(analyticsRunTrigger({ kind: "automatic", fireTime: 1 }), "automatic");
});

test("a sent message reports registry-valid properties and never waits on the workspace lookup", async (t) => {
  const sent = captureAnalyticsEvents(t);
  let finishLookup!: (inWorkspace: boolean) => void;
  reportChatMessageSent({
    providerId: "my-private-gateway",
    model: "secret-model",
    thinkingLevel: "high",
    origin: "desktop",
    inWorkspace: () => new Promise((resolve) => { finishLookup = resolve; }),
  });
  await analyticsSettled();
  assert.deepEqual(sent, [], "the send has already returned; the report follows the lookup");
  finishLookup(true);
  await analyticsSettled();
  assert.deepEqual(sent, [{
    event: "chat_message_sent",
    props: { provider_id: "custom", model_id: "custom", in_workspace: true, thinking: "high", origin: "desktop" },
  }]);
});

test("a workspace lookup that fails still counts the message, as outside a workspace", async (t) => {
  const sent = captureAnalyticsEvents(t);
  reportChatMessageSent({
    providerId: "anthropic",
    model: "unlisted",
    origin: "phone",
    inWorkspace: async () => {
      throw new Error("config unreadable");
    },
  });
  await analyticsSettled();
  assert.deepEqual(sent, [{
    event: "chat_message_sent",
    props: { provider_id: "anthropic", model_id: "custom", in_workspace: false, thinking: "other", origin: "phone" },
  }]);
});

test("a person's own provider is only ever custom, and a loopback or keyless one is local", (t) => {
  const sent = captureAnalyticsEvents(t);
  const provider = (fields: Partial<StoredProvider>) =>
    ({ id: "p", kind: "openai", label: "Office gateway", baseUrl: "https://llm.example.test/v1", models: [], needsKey: true, ...fields }) as StoredProvider;
  reportCustomProviderConnected(provider({}));
  reportCustomProviderConnected(provider({ baseUrl: "http://127.0.0.1:11434/v1" }));
  reportCustomProviderConnected(provider({ needsKey: false }));
  assert.deepEqual(sent.map((entry) => entry.props), [
    { provider_id: "custom", auth: "key" },
    { provider_id: "custom", auth: "local" },
    { provider_id: "custom", auth: "local" },
  ]);
  assert.doesNotMatch(JSON.stringify(sent), /Office gateway|example\.test/u);
});

test("a connector from the catalog sends its preset id, and a person's own sends custom", (t) => {
  const sent = captureAnalyticsEvents(t);
  const preset = MCP_PRESETS[0]!;
  reportConnectorAdded({ id: presetServerId(preset.id), transport: "http" });
  reportConnectorAdded({ id: "my-own-server", transport: "stdio" });
  assert.deepEqual(sent, [
    { event: "connector_added", props: { preset_id: preset.id.toLowerCase(), transport: "http" } },
    { event: "connector_added", props: { preset_id: "custom", transport: "stdio" } },
  ]);
});
