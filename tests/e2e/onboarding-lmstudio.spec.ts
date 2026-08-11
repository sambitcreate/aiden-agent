import path from "node:path";
import {
  assertNoPersistedProviderCredentials,
  E2E_MODEL_DISPLAY_NAME,
  E2E_MODEL_ID,
  E2E_PROFILE_NAME,
  expect,
  finishLmStudioOnboarding,
  LM_STUDIO_PROVIDER_ID,
  readJsonFile,
  test,
  type AidenE2e,
} from "./fixtures";

const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function persistedProviderState(aiden: AidenE2e) {
  const [portableValue, cacheValue, localValue] = await Promise.all([
    readJsonFile(path.join(aiden.configDir, "config.json")),
    readJsonFile(path.join(aiden.userDataDir, "provider-model-cache.json")),
    readJsonFile(path.join(aiden.userDataDir, "config.json")),
  ]);
  const portable = record(portableValue, "portable config");
  const providers = portable.providers;
  if (!Array.isArray(providers)) throw new Error("Portable providers were not an array.");
  const provider = providers.find(
    (value) => record(value, "portable provider").id === LM_STUDIO_PROVIDER_ID,
  );
  if (!provider) throw new Error("The canonical LM Studio provider was not persisted.");

  const cache = record(cacheValue, "provider model cache");
  const byProvider = record(cache.byProvider, "provider model cache entries");
  const providerCache = record(byProvider[LM_STUDIO_PROVIDER_ID], "LM Studio model cache");
  return {
    portable,
    provider: record(provider, "canonical LM Studio provider"),
    cache,
    byProvider,
    providerCache,
    local: record(localValue, "machine-local config"),
  };
}

test.describe("fresh portable config", () => {
  test.use({ portableConfigSeed: "empty" });

  test("onboarding creates the canonical LM Studio provider and survives relaunch", async ({
    aiden,
  }) => {
    const initialPortable = record(
      await readJsonFile(path.join(aiden.configDir, "config.json")),
      "initial portable config",
    );
    expect(initialPortable.providers).toEqual([]);
    expect(aiden.lmStudio.baseUrl).not.toBe(DEFAULT_LM_STUDIO_BASE_URL);

    await finishLmStudioOnboarding(aiden.page);

    const beforeRelaunch = await persistedProviderState(aiden);
    expect(Object.keys(beforeRelaunch.byProvider)).toEqual([LM_STUDIO_PROVIDER_ID]);
    expect(beforeRelaunch.provider).toMatchObject({
      id: LM_STUDIO_PROVIDER_ID,
      kind: "openai",
      label: "LM Studio (local)",
      baseUrl: DEFAULT_LM_STUDIO_BASE_URL,
      defaultModel: E2E_MODEL_ID,
      needsKey: false,
      deployment: "local",
    });
    expect(beforeRelaunch.provider).not.toHaveProperty("models");
    expect(beforeRelaunch.provider).not.toHaveProperty("modelMetadata");
    expect(beforeRelaunch.providerCache).toMatchObject({
      models: [E2E_MODEL_ID],
      modelMetadata: {
        [E2E_MODEL_ID]: {
          source: "lmstudio",
          name: E2E_MODEL_DISPLAY_NAME,
          type: "llm",
          vision: true,
        },
      },
    });
    expect(aiden.lmStudio.requests).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "GET", url: "/api/v1/models" })]),
    );
    await assertNoPersistedProviderCredentials(aiden);

    const page = await aiden.relaunch();
    await expect(page.locator('section[aria-label="Set up Aiden"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^Selected model: ${E2E_MODEL_DISPLAY_NAME}\\. Choose a model\\.$`, "u"),
      }),
    ).toBeVisible();
    const afterRelaunch = await persistedProviderState(aiden);
    expect(afterRelaunch.provider).toEqual(beforeRelaunch.provider);
    expect(afterRelaunch.providerCache).toEqual(beforeRelaunch.providerCache);
    await assertNoPersistedProviderCredentials(aiden);
  });
});

test("onboarding preserves an existing keyless LM Studio profile across a full relaunch", async ({
  aiden,
}) => {
  await finishLmStudioOnboarding(aiden.page);

  await expect
    .poll(() =>
      aiden.page.evaluate(() => ({
        providerId: localStorage.getItem("aiden-agent.providerId"),
        model: localStorage.getItem("aiden-agent.model"),
      })),
    )
    .toEqual({ providerId: LM_STUDIO_PROVIDER_ID, model: E2E_MODEL_ID });

  await expect
    .poll(async () => (await persistedProviderState(aiden)).provider.defaultModel)
    .toBe(E2E_MODEL_ID);
  const beforeRelaunch = await persistedProviderState(aiden);
  expect(beforeRelaunch.provider).toMatchObject({
    id: LM_STUDIO_PROVIDER_ID,
    kind: "openai",
    label: "LM Studio (local)",
    baseUrl: aiden.lmStudio.baseUrl,
    defaultModel: E2E_MODEL_ID,
    needsKey: false,
    deployment: "local",
  });
  expect(beforeRelaunch.provider).not.toHaveProperty("models");
  expect(beforeRelaunch.provider).not.toHaveProperty("modelMetadata");
  expect(Object.keys(beforeRelaunch.byProvider)).toEqual([LM_STUDIO_PROVIDER_ID]);
  expect(beforeRelaunch.providerCache).toMatchObject({
    models: [E2E_MODEL_ID],
    modelMetadata: {
      [E2E_MODEL_ID]: {
        source: "lmstudio",
        name: E2E_MODEL_DISPLAY_NAME,
        type: "llm",
        vision: true,
        toolCall: true,
        reasoning: false,
        contextLength: 32_768,
        parameterCount: "1B",
        format: "Q4_K_M",
      },
    },
  });
  expect(beforeRelaunch.local).toMatchObject({ seeded: true });
  expect(beforeRelaunch.local).toHaveProperty("workspaces");
  expect(beforeRelaunch.local).not.toHaveProperty("providers");
  await assertNoPersistedProviderCredentials(aiden);

  const page = await aiden.relaunch();
  await expect(page.locator('section[aria-label="Set up Aiden"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^Selected model: ${E2E_MODEL_DISPLAY_NAME}\\. Choose a model\\.$`, "u"),
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        providerId: localStorage.getItem("aiden-agent.providerId"),
        model: localStorage.getItem("aiden-agent.model"),
      })),
    )
    .toEqual({ providerId: LM_STUDIO_PROVIDER_ID, model: E2E_MODEL_ID });

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: E2E_PROFILE_NAME, exact: true }),
  ).toBeVisible();
  const afterRelaunch = await persistedProviderState(aiden);
  expect(afterRelaunch.provider).toEqual(beforeRelaunch.provider);
  expect(afterRelaunch.providerCache).toEqual(beforeRelaunch.providerCache);
  await assertNoPersistedProviderCredentials(aiden);
});
