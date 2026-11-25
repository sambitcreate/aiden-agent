import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteModelService } from "./aiden-remote-models.js";
import { parseAidenRemoteAgentSlider, type AidenRemoteAgentSlider } from "./aiden-remote-protocol.js";
import type { Provider } from "./types.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { withPiRemoteCatalog } from "./pi-remote-catalog.js";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-1",
    kind: "openai",
    label: "Provider",
    baseUrl: "https://secret-endpoint.example/v1",
    models: ["chat-model", "embedding-model"],
    modelMetadata: {
      "chat-model": {
        source: "provider",
        name: "Chat Model",
        type: "llm",
        thinkingLevels: ["low", "high"],
        thinkingCanDisable: false,
      },
      "embedding-model": { source: "provider", type: "embedding" },
    },
    needsKey: true,
    hasKey: true,
    authMethods: [{ type: "api_key", label: "Secret", canLogin: true }],
    ...overrides,
  };
}

test("mobile catalogs omit legacy Google models and recover stale defaults", async () => {
  const google = builtinProviders().find((entry) => entry.id === "google");
  assert.ok(google);
  const models = withPiRemoteCatalog(google).getModels().map((model) => model.id);
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ id: "google", models, modelMetadata: {} })],
    getSettings: async () => ({ lastProviderId: "google", lastModel: "gemini-2.5-flash" }),
  });
  const catalog = await service.list();
  assert.ok(catalog.providers[0]?.models.length);
  assert.ok(catalog.providers[0]?.models.every((model) => !/^gemini-(?:2\.5|2\.0|1\.5)(?:-|$)/u.test(model.id)));
  assert.ok(catalog.defaults.modelId && models.includes(catalog.defaults.modelId));
  await assert.rejects(service.resolve("google", "gemini-2.5-flash"),
    (error: unknown) => (error as { code?: string }).code === "invalid_request");
});

test("model projection includes only configured chat models and no connection secrets", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider(), provider({ id: "missing-key", hasKey: false })],
    getSettings: async () => ({ lastProviderId: "provider-1", lastModel: "chat-model" }),
  });
  const projection = await service.list();
  assert.deepEqual(projection.defaults, { providerId: "provider-1", modelId: "chat-model" });
  assert.equal(projection.providers.length, 1);
  assert.deepEqual(projection.providers[0]?.models, [
    {
      id: "chat-model",
      label: "Chat Model",
      supportsImages: false,
      thinkingLevels: ["low", "high"],
      defaultThinkingLevel: "high",
      thinkingCanDisable: false,
    },
  ]);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("secret-endpoint"), false);
  assert.equal(serialized.includes("authMethods"), false);
});

test("custom provider artwork crosses the remote catalog only as bounded normalized PNG data", async () => {
  const artwork = {
    mimeType: "image/png" as const,
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  };
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ artwork })],
    getSettings: async () => ({}),
  });
  assert.deepEqual((await service.list()).providers[0]?.artwork, artwork);
});

test("model selection rejects missing providers and models", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider()],
    getSettings: async () => ({}),
  });
  assert.deepEqual(await service.resolve(), {
    providerId: "provider-1",
    modelId: "chat-model",
    thinkingLevels: ["low", "high"],
    supportsImages: false,
  });
  await assert.rejects(
    service.resolve("provider-1", "missing"),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
});

test("hidden models are projected for clients, skipped by defaults, and remain resolvable", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [
      provider({
        models: ["hidden-model", "visible-model"],
        defaultModel: "hidden-model",
        modelMetadata: {
          "hidden-model": { source: "provider", name: "Hidden Model", type: "llm" },
          "visible-model": { source: "provider", name: "Visible Model", type: "llm" },
        },
      }),
    ],
    getSettings: async () => ({
      lastProviderId: "provider-1",
      lastModel: "hidden-model",
      hiddenModelsByProvider: { "provider-1": ["hidden-model"] },
    }),
  });

  const projection = await service.list();
  assert.deepEqual(projection.defaults, {
    providerId: "provider-1",
    modelId: "visible-model",
  });
  assert.deepEqual(projection.providers[0]?.models, [
    { id: "hidden-model", label: "Hidden Model", supportsImages: false, hidden: true },
    { id: "visible-model", label: "Visible Model", supportsImages: false },
  ]);
  assert.deepEqual(await service.resolve("provider-1", "hidden-model"), {
    providerId: "provider-1",
    modelId: "hidden-model",
    thinkingLevels: [],
    supportsImages: false,
  });
});

test("a provider with every model hidden has no remote default", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ models: ["chat-model"] })],
    getSettings: async () => ({
      hiddenModelsByProvider: { "provider-1": ["chat-model"] },
    }),
  });

  assert.deepEqual((await service.list()).defaults, {});
});

test("transcription-only rejects new remote Google chat selection but allows a pinned chat", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [
      provider({ id: "google", models: ["gemini-chat"], defaultModel: "gemini-chat" }),
    ],
    getSettings: async () => ({
      geminiUsageScope: "transcription_only",
      hiddenModelsByProvider: { google: ["*"] },
    }),
  });

  await assert.rejects(
    service.resolve("google", "gemini-chat"),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  assert.equal(
    (await service.resolve("google", "gemini-chat", {
      allowExistingPinnedGemini: true,
    })).modelId,
    "gemini-chat",
  );
});

test("remote catalog omits oversized model identities instead of truncating or colliding", async () => {
  const prefix = "x".repeat(256);
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ models: [`${prefix}a`, `${prefix}b`, "safe"] })],
    getSettings: async () => ({}),
  });

  assert.deepEqual((await service.list()).providers[0]?.models.map((model) => model.id), ["safe"]);
});

test("remote model projection remains below the generic iOS response ceiling", async () => {
  const models = Array.from({ length: 20_000 }, (_, index) =>
    `model-${index.toString().padStart(5, "0")}-${"x".repeat(120)}`,
  );
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ models })],
    getSettings: async () => ({}),
  });

  const projection = await service.list();
  assert.ok(projection.providers[0]!.models.length < models.length);
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= 900 * 1024);
});

test("OpenCode Go projects remotely refreshed Ox Alpha metadata and thinking choices to iOS", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({
      id: "opencode-go",
      label: "OpenCode Go",
      models: ["ox-alpha-free"],
      defaultModel: "ox-alpha-free",
      modelMetadata: {
        "ox-alpha-free": {
          source: "provider",
          name: "Ox Alpha Free (Unlimited)",
          type: "llm",
          reasoning: true,
          thinkingLevels: ["low", "high", "max"],
          thinkingCanDisable: false,
        },
      },
    })],
    getSettings: async () => ({
      providerThinkingByModel: { "opencode-go": { "ox-alpha-free": "max" } },
    }),
  });
  assert.deepEqual((await service.list()).providers[0]?.models, [{
    id: "ox-alpha-free",
    label: "Ox Alpha Free (Unlimited)",
    supportsImages: false,
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "max",
    thinkingCanDisable: false,
  }]);
});

test("desktop local classifier opt-in does not alter the native chat catalog contract", async () => {
  const saved = provider({ id: "custom:llama", baseUrl: "http://localhost:8080/v1", deployment: "local", llamaCppClassifierEnabled: true });
  const service = new AidenRemoteModelService({ listProviders: async () => [saved], getSettings: async () => ({}) });
  const projection = await service.list();
  assert.deepEqual(Object.keys(projection.providers[0]).sort(), ["id", "label", "models"]);
  assert.deepEqual(projection.providers[0].models.map((model) => model.id), ["chat-model"]);
});

test("remote provider creation saves explicit image options and recovers a lost receipt without key rotation", async () => {
  const { AidenRemoteProviderService } = await import("./aiden-remote-providers.js");
  const { splitStoredProvider, composeStoredProvider } = await import("./portable-config-core.js");
  let saved: import("./types.js").StoredProvider | undefined;
  let writes = 0; let receivedKey: string | null = null;
  const dependencies = {
    get: async () => saved,
    save: async (value: import("./types.js").StoredProvider, key: string | null) => {
      writes++; receivedKey = key;
      const { intent, cache } = splitStoredProvider(value);
      saved = composeStoredProvider(JSON.parse(JSON.stringify(intent)), JSON.parse(JSON.stringify(cache)));
      return saved;
    },
    changed: () => {},
    recoverCredential: async () => receivedKey !== null,
  };
  const input = { label: "Private", baseUrl: "https://models.example.test/v1", kind: "openai", deployment: "hosted", needsKey: true, apiKey: "fixture-key", confirmedForeground: true, models: [{ id: "private-vision", vision: true, reasoning: false, toolCall: true }] };
  const service = new AidenRemoteProviderService(dependencies);
  const [first, repeated] = await Promise.all([service.create("device-one", "fixture-request-key", input), service.create("device-one", "fixture-request-key", input)]);
  assert.deepEqual(repeated, first);
  assert.equal(writes, 1); assert.equal(receivedKey, "fixture-key");
  assert.deepEqual(Object.keys(first).sort(), ["id", "label", "models"]);
  assert.equal(saved?.modelMetadata?.["private-vision"]?.overrides?.vision, true);
  const restarted = new AidenRemoteProviderService(dependencies);
  assert.deepEqual(await restarted.create("device-one", "fixture-request-key", input), first);
  assert.equal(writes, 1);
  await assert.rejects(restarted.create("device-one", "fixture-request-key", { ...input, baseUrl: "https://other.example.test/v1" }), (error: unknown) => (error as { code: string }).code === "idempotency_conflict");
  await assert.rejects(service.create("device-one", "fixture-other-request", input, () => false), (error: unknown) => (error as { code: string }).code === "credential_revoked");
  assert.equal(writes, 1);
  const catalog = new AidenRemoteModelService({listProviders: async () => [{ ...saved!, hasKey: true }], getSettings: async () => ({})});
  assert.equal((await catalog.list()).providers[0]?.models[0]?.supportsImages, true);
});

test("remote provider creation rejects malformed credentials, endpoint redirects, and ambiguous model declarations", async () => {
  const { parseRemoteProviderCreation } = await import("./aiden-remote-providers.js");
  const input = {label: "Local", baseUrl: "http://localhost:1234/v1", kind: "openai", deployment: "local", needsKey: false, confirmedForeground: true, models: [{id: "local", vision: false, reasoning: false, toolCall: true}]};
  assert.equal(parseRemoteProviderCreation(input).baseUrl, "http://localhost:1234/v1");
  for (const invalid of [
    {...input, confirmedForeground: false}, {...input, needsKey: true}, {...input, apiKey: "unneeded-secret"},
    {...input, baseUrl: "https://user:password@example.test/v1"}, {...input, baseUrl: "http://169.254.169.254/"},
    {...input, models: []}, {...input, models: [input.models[0], input.models[0]]},
    {...input, models: [{...input.models[0], vision: "true"}]}, {...input, isBuiltin: true},
    {...input, kind: { toString: null }}, {...input, deployment: ["local"]},
    {...input, models: [{...input.models[0], contextLength: 100, outputLimit: 101}]},
  ]) assert.throws(() => parseRemoteProviderCreation(invalid), (error: unknown) => (error as {code: string}).code === "invalid_request");
});

test("provider replay waits for the originally journaled credential after partial publication", async () => {
  const { AidenRemoteProviderService } = await import("./aiden-remote-providers.js");
  const { splitStoredProvider, composeStoredProvider } = await import("./portable-config-core.js");
  const { credentialAfterProviderRotation, providerConnectionSnapshot } = await import("./provider-credential-rotation-core.js");
  let saved: import("./types.js").StoredProvider | undefined;
  let pending: import("./provider-credential-rotation-core.js").PendingProviderCredentialRotationV1 | undefined;
  let boundKey: string | null = null;
  let backendAvailable = false;
  let writes = 0;
  const dependencies = {
    get: async () => saved,
    save: async (value: import("./types.js").StoredProvider, key: string | null) => {
      writes++;
      pending = { version: 1, providerId: value.id, previous: null, target: providerConnectionSnapshot(value), previousKey: null, targetKey: key };
      const { intent, cache } = splitStoredProvider(value);
      saved = composeStoredProvider(JSON.parse(JSON.stringify(intent)), JSON.parse(JSON.stringify(cache)));
      throw new Error("Credential backend is unavailable after configuration publication");
    },
    recoverCredential: async () => {
      if (!backendAvailable) throw new Error("Credential backend is still unavailable");
      if (pending) {
        const resolution = credentialAfterProviderRotation(pending, saved);
        assert.equal(resolution.resolved, true);
        boundKey = resolution.key ?? null;
        pending = undefined;
      }
      return boundKey !== null;
    },
    changed: () => {},
  };
  const input = { label: "Private", baseUrl: "https://models.example.test/v1", kind: "openai", deployment: "hosted", needsKey: true, apiKey: "original-journaled-key", confirmedForeground: true, models: [{ id: "vision", vision: true, reasoning: false, toolCall: true }] };
  const first = new AidenRemoteProviderService(dependencies);
  await assert.rejects(first.create("device", "partial-request-key", input), /after configuration publication/u);
  const catalog = new AidenRemoteModelService({ listProviders: async () => [{ ...saved!, hasKey: boundKey !== null }], getSettings: async () => ({}) });
  assert.equal((await catalog.list()).providers.length, 0);
  const restarted = new AidenRemoteProviderService(dependencies);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(restarted.create("device", "partial-request-key", input), /still unavailable/u);
    assert.equal(boundKey, null);
    assert.equal((await catalog.list()).providers.length, 0);
  }
  backendAvailable = true;
  const receipt = await restarted.create("device", "partial-request-key", { ...input, apiKey: "must-not-rotate-on-replay" });
  assert.equal(receipt.id, saved!.id);
  assert.equal(boundKey, "original-journaled-key");
  assert.equal(writes, 1);
  assert.equal((await catalog.list()).providers.length, 1);
  boundKey = null;
  await assert.rejects(restarted.create("device", "partial-request-key", input), (error: unknown) => (error as { code: string }).code === "internal_error");
  assert.equal(writes, 1, "missing credentials cannot be replaced from a replay request");
});

test("keyless provider replay does not require a credential backend", async () => {
  const { AidenRemoteProviderService } = await import("./aiden-remote-providers.js");
  const { splitStoredProvider, composeStoredProvider } = await import("./portable-config-core.js");
  let saved: import("./types.js").StoredProvider | undefined;
  let writes = 0;
  const service = new AidenRemoteProviderService({
    get: async () => saved,
    save: async (provider, key) => {
      assert.equal(key, null);
      writes++;
      const { intent, cache } = splitStoredProvider(provider);
      saved = composeStoredProvider(intent, cache);
      return saved;
    },
    recoverCredential: async () => { throw new Error("No system credential backend is available"); },
    changed: () => {},
  });
  const input = { label: "Local", baseUrl: "http://localhost:1234/v1", kind: "openai", deployment: "local", needsKey: false, confirmedForeground: true, models: [{ id: "local", vision: false, reasoning: false, toolCall: true }] };
  const receipt = await service.create("device", "keyless-request-key", input);
  assert.deepEqual(await service.create("device", "keyless-request-key", input), receipt);
  assert.equal(writes, 1);
});

test("phones never see agent-backed providers and cannot start turns on them", async () => {
  const service = new AidenRemoteModelService({
    listProviders: async () => [provider({ id: "antigravity", label: "Google Antigravity" }), provider()],
    getSettings: async () => ({ lastProviderId: "antigravity", lastModel: "chat-model" }),
  });
  const catalog = await service.list();
  assert.deepEqual(catalog.providers.map((entry) => entry.id), ["provider-1"]);
  assert.notEqual(catalog.defaults.providerId, "antigravity");
  await assert.rejects(service.resolve("antigravity", "chat-model"), /runs only in chats you have open on this computer/u);
});

test("the Agent Slider reaches phones with each stop's availability and a level its model offers", async () => {
  const longModel = "x".repeat(300);
  const stops = [
    { id: "ready", label: "Deep", providerId: "provider-1", model: "chat-model", thinkingLevel: "high" as const },
    { id: "fitted", label: "Middle", providerId: "provider-1", model: "chat-model", thinkingLevel: "medium" as const },
    { id: "unassigned", label: "Choose a model" },
    { id: "gone", label: "Gone", providerId: "removed", model: "chat-model" },
    { id: "signed-out", label: "Signed out", providerId: "no-key", model: "chat-model", thinkingLevel: "low" as const },
    { id: "signed-out-unnamed", label: "Signed out, unnamed", providerId: "no-key", model: "unnamed-model" },
    { id: "missing", label: "Missing", providerId: "provider-1", model: "retired-model" },
    { id: "embedding", label: "Embedding", providerId: "provider-1", model: "embedding-model" },
    { id: "long", label: "Long", providerId: "provider-1", model: longModel, thinkingLevel: "high" as const },
  ];
  const settings = {
    lastProviderId: "provider-1",
    lastModel: "chat-model",
    agentSlider: { version: 1 as const, stops, homeStopId: "ready" },
  };
  const service = new AidenRemoteModelService({
    listProviders: async () => [
      provider({ models: ["chat-model", "embedding-model", longModel] }),
      provider({ id: "no-key", label: "Keyless Co", hasKey: false, models: ["chat-model", "unnamed-model"] }),
    ],
    getSettings: async () => settings,
  });
  const projection = await service.list();
  const slider = projection.agentSlider;
  assert.ok(slider);
  assert.equal(slider.homeStopId, "ready");
  assert.deepEqual(slider.stops.map((stop) => stop.id), stops.map((stop) => stop.id), "order and every stop survive");
  const byId = new Map(slider.stops.map((stop) => [stop.id, stop]));
  assert.deepEqual(byId.get("ready"), {
    id: "ready",
    label: "Deep",
    providerId: "provider-1",
    modelId: "chat-model",
    providerLabel: "Provider",
    modelLabel: "Chat Model",
    thinkingLevel: "high",
    availability: "ready",
  });
  // The model offers low and high only, so a phone is told a level it can actually send.
  const offered = projection.providers[0]?.models.find((model) => model.id === "chat-model")?.thinkingLevels ?? [];
  const fitted = byId.get("fitted");
  assert.equal(fitted?.availability, "ready");
  assert.ok(fitted?.thinkingLevel && offered.includes(fitted.thinkingLevel), `fitted level ${fitted?.thinkingLevel} is offered`);
  assert.deepEqual(byId.get("unassigned"), { id: "unassigned", label: "Choose a model", availability: "unassigned" });
  // Unavailable stops name what to fix in words, never by id, and carry no level.
  assert.deepEqual(byId.get("gone"), { id: "gone", label: "Gone", availability: "provider-missing" });
  assert.deepEqual(byId.get("signed-out"), {
    id: "signed-out", label: "Signed out", providerLabel: "Keyless Co", modelLabel: "Chat Model", availability: "not-signed-in",
  });
  assert.deepEqual(byId.get("signed-out-unnamed"), {
    id: "signed-out-unnamed", label: "Signed out, unnamed", providerLabel: "Keyless Co", availability: "not-signed-in",
  }, "a model known only by its id gets no label");
  assert.deepEqual(byId.get("missing"), { id: "missing", label: "Missing", providerLabel: "Provider", availability: "model-missing" });
  // Runs on the computer, but the phone catalog leaves the model out: nothing about it is sent.
  assert.deepEqual(byId.get("embedding"), { id: "embedding", label: "Embedding", availability: "computer-only" });
  assert.deepEqual(byId.get("long"), { id: "long", label: "Long", availability: "computer-only" });
  // Every stop the host sends meets the published contract (in slider-sized groups of three).
  for (let at = 0; at < slider.stops.length; at += 3) {
    const group: AidenRemoteAgentSlider = { stops: slider.stops.slice(at, at + 3), homeStopId: slider.stops[at]!.id };
    assert.deepEqual(parseAidenRemoteAgentSlider(group), group);
  }
  for (const stop of slider.stops) {
    const source = stops.find((candidate) => candidate.id === stop.id)!;
    assert.equal(stop.providerId !== undefined, stop.availability === "ready", `${stop.id}: ids only when ready`);
    assert.equal(stop.thinkingLevel === undefined || stop.availability === "ready", true, `${stop.id}: level only when ready`);
    if (source.model) assert.notEqual(stop.modelLabel, source.model, `${stop.id}: model label is never the id`);
    if (source.providerId) assert.notEqual(stop.providerLabel, source.providerId, `${stop.id}: provider label is never the id`);
  }

  const hidden = new AidenRemoteModelService({
    listProviders: async () => [provider()],
    getSettings: async () => ({ ...settings, hiddenModelsByProvider: { "provider-1": ["chat-model"] } }),
  });
  assert.deepEqual((await hidden.list()).agentSlider?.stops[0], {
    id: "ready", label: "Deep", providerLabel: "Provider", modelLabel: "Chat Model", availability: "hidden",
  });

  const harness = new AidenRemoteModelService({
    listProviders: async () => [provider({ id: "antigravity", label: "Google Antigravity" }), provider()],
    getSettings: async () => ({
      ...settings,
      agentSlider: { ...settings.agentSlider, stops: [{ ...stops[0], providerId: "antigravity" }, ...stops.slice(1)] },
    }),
  });
  assert.deepEqual((await harness.list()).agentSlider?.stops[0], {
    id: "ready", label: "Deep", availability: "computer-only",
  }, "agent harness stops stay on the computer and phones never learn the provider");

  for (const without of [{ lastProviderId: "provider-1" }, { ...settings, agentSliderUnreadable: true as const }]) {
    const service = new AidenRemoteModelService({ listProviders: async () => [provider()], getSettings: async () => without });
    assert.equal("agentSlider" in (await service.list()), false);
  }
});

test("with a slider, new chats default to the computer's last stop level, fitted, only when the default is that last model", async () => {
  const agentSlider = {
    version: 1 as const,
    stops: [{ id: "deep", label: "Deep", providerId: "provider-1", model: "chat-model", thinkingLevel: "high" as const }],
    homeStopId: "deep",
  };
  const list = async (settings: Record<string, unknown>, providers = [provider()]) =>
    (await new AidenRemoteModelService({ listProviders: async () => providers, getSettings: async () => settings }).list()).defaults;

  assert.deepEqual(
    await list({ lastProviderId: "provider-1", lastModel: "chat-model", lastThinkingLevel: "high", agentSlider }),
    { providerId: "provider-1", modelId: "chat-model", thinkingLevel: "high" },
  );
  // The model offers low and high only: an xhigh last level runs, and starts, at a level it offers.
  const fitted = await list({ lastProviderId: "provider-1", lastModel: "chat-model", lastThinkingLevel: "xhigh", agentSlider });
  assert.ok(["low", "high"].includes(fitted.thinkingLevel ?? ""), `fitted ${fitted.thinkingLevel}`);
  // The last model is gone, so the default falls back to another model: no level from the old one.
  assert.deepEqual(
    await list({ lastProviderId: "provider-1", lastModel: "retired-model", lastThinkingLevel: "high", agentSlider }),
    { providerId: "provider-1", modelId: "chat-model" },
  );
  // A model with no levels takes no level.
  assert.deepEqual(
    await list(
      { lastProviderId: "provider-1", lastModel: "chat-model", lastThinkingLevel: "high", agentSlider },
      [provider({ modelMetadata: { "chat-model": { source: "provider", name: "Chat Model", type: "llm" } } })],
    ),
    { providerId: "provider-1", modelId: "chat-model" },
  );
  for (const withoutSlider of [
    { lastProviderId: "provider-1", lastModel: "chat-model", lastThinkingLevel: "high" },
    { lastProviderId: "provider-1", lastModel: "chat-model", lastThinkingLevel: "high", agentSlider, agentSliderUnreadable: true },
  ]) {
    assert.deepEqual(await list(withoutSlider), { providerId: "provider-1", modelId: "chat-model" }, "no slider, no level");
  }
});
