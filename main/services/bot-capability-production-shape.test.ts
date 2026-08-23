import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../renderer/shared/bot-capabilities.js";
import { createBotCapabilityCatalogMainService } from "./bot-capability-catalog-main.js";
import { createBotProviderCredentialSignatureCore } from "./bot-capability-credential-signatures-core.js";
import { createBotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { createBotCapabilityInventoryPorts, type BotResolvedSkill } from "./bot-capability-inventory-ports.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("Bot provider signatures bind stored and custom authority while rejecting ambient-only auth", async () => {
  let stored: Credential | undefined;
  let custom: unknown;
  const sign = createBotProviderCredentialSignatureCore({
    readBuiltinCredential: async () => stored,
    readCustomCredential: async () => custom,
  });
  const key = Buffer.alloc(32, 7);
  const signal = new AbortController().signal;
  const builtin = {
    id: "builtin",
    kind: "openai" as const,
    label: "Builtin",
    baseUrl: "",
    models: ["chat"],
    needsKey: true,
    hasKey: true,
    isBuiltin: true,
  };
  const customProvider = {
    ...builtin,
    id: "custom:provider",
    label: "Custom",
    isBuiltin: false,
  };

  stored = { type: "api_key", key: "stored-secret-a" };
  const apiKeyA = await sign(builtin, key, signal);
  stored = { type: "api_key", key: "stored-secret-b" };
  const apiKeyB = await sign(builtin, key, signal);
  stored = { type: "oauth", access: "oauth-a", refresh: "refresh-a", expires: 1 };
  const oauth = await sign(builtin, key, signal);

  stored = undefined;
  assert.equal(await sign(builtin, key, signal), undefined);
  stored = { type: "api_key", env: { AWS_PROFILE: "ambient-profile" } };
  assert.equal(await sign(builtin, key, signal), undefined);
  stored = { type: "api_key", key: "   ", env: { GOOGLE_APPLICATION_CREDENTIALS: "/adc" } };
  assert.equal(await sign(builtin, key, signal), undefined);

  custom = "custom-secret-a";
  const customA = await sign(customProvider, key, signal);
  custom = "custom-secret-b";
  const customB = await sign(customProvider, key, signal);

  const signatures = [apiKeyA, apiKeyB, oauth, customA, customB];
  assert.equal(signatures.every((value) => value !== undefined), true);
  assert.equal(new Set(signatures).size, signatures.length);
  for (const value of signatures) assert.match(value!, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(signatures), /stored-secret|oauth-a|custom-secret/u);
});

test("production-shaped catalogs keep restart identity and rotate exact opaque grants", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-production-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let credential = hash("credential-a");
  let skills: BotResolvedSkill[] = [{
    sourceId: "skill:resolved",
    label: "Resolved",
    description: "A discovered skill",
    instructions: "Private instructions",
    available: true,
  }];
  let randomCounter = 0;
  const createService = async () => {
    const protectedStore = createBotCapabilityStore({
      root: () => root,
      mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
      mintIncarnation: () => Buffer.alloc(32, ++randomCounter).toString("base64url"),
    });
    await protectedStore.initialize();
    const incarnations = createBotCapabilityIncarnationStore(protectedStore);
    return createBotCapabilityCatalogMainService(createBotCapabilityInventoryPorts({
      loadOpaqueSelectionKey: async () => Buffer.alloc(32, 9),
      loadNoticeStatus: async () => ({ version: BOT_FULL_ACCESS_NOTICE_VERSION, requiresAcknowledgement: true }),
      listProviders: async () => [{
        id: "provider",
        kind: "openai",
        label: "Provider",
        baseUrl: "https://provider.invalid/v1",
        models: ["chat"],
        needsKey: true,
        hasKey: true,
      }],
      providerCredentialSignature: async () => credential,
      listMcpServers: async () => [],
      inspectMcpScopes: async () => [],
      listSkills: async () => skills,
      listApprovedLocations: async () => [],
      incarnations,
      getSettings: async () => ({}),
      hasWebCredential: async () => false,
      subagentsAvailable: () => false,
    }));
  };

  const first = await (await createService()).snapshot({ audienceId: "device_a" });
  const restarted = await (await createService()).snapshot({ audienceId: "device_a" });
  assert.equal(restarted.catalog.providers[0]?.id, first.catalog.providers[0]?.id);
  assert.equal(restarted.catalog.skills[0]?.id, first.catalog.skills[0]?.id);

  credential = hash("credential-b");
  const rotated = await (await createService()).snapshot({ audienceId: "device_a" });
  assert.notEqual(rotated.catalog.providers[0]?.id, first.catalog.providers[0]?.id);

  skills = [];
  await (await createService()).snapshot({ audienceId: "device_a" });
  skills = [{
    sourceId: "skill:resolved",
    label: "Resolved",
    description: "A discovered skill",
    instructions: "Private instructions",
    available: true,
  }];
  const readded = await (await createService()).snapshot({ audienceId: "device_a" });
  assert.notEqual(readded.catalog.skills[0]?.id, first.catalog.skills[0]?.id);
});

test("Bot-targeted catalogs isolate managed-home skills and stay stable across restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-targeted-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let randomCounter = 0;
  const privateSkill = (botId: string): BotResolvedSkill => ({
    sourceId: `skill:${botId}:private`,
    label: `Private ${botId}`,
    description: "Private managed-home skill",
    instructions: `Secret instructions for ${botId}`,
    available: true,
    incarnationPartition: `bot:${botId}`,
  });
  const globalSkill: BotResolvedSkill = {
    sourceId: "skill:global",
    label: "Global",
    description: "Global skill",
    instructions: "Global instructions",
    available: true,
    incarnationPartition: "global",
  };
  const createService = async () => {
    const protectedStore = createBotCapabilityStore({
      root: () => root,
      mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
      mintIncarnation: () => Buffer.alloc(32, ++randomCounter).toString("base64url"),
    });
    await protectedStore.initialize();
    return createBotCapabilityCatalogMainService(createBotCapabilityInventoryPorts({
      loadOpaqueSelectionKey: async () => Buffer.alloc(32, 17),
      loadNoticeStatus: async () => ({
        version: BOT_FULL_ACCESS_NOTICE_VERSION,
        requiresAcknowledgement: true,
      }),
      listProviders: async () => [{
        id: "provider",
        kind: "openai",
        label: "Provider",
        baseUrl: "https://provider.invalid/v1",
        models: ["chat"],
        needsKey: false,
        hasKey: false,
      }],
      providerCredentialSignature: async () => hash("absent"),
      listMcpServers: async () => [],
      inspectMcpScopes: async () => [],
      listSkills: async (target) => [
        globalSkill,
        ...(target ? [privateSkill(target.botId)] : []),
      ],
      listApprovedLocations: async () => [],
      incarnations: createBotCapabilityIncarnationStore(protectedStore),
      getSettings: async () => ({}),
      hasWebCredential: async () => false,
      subagentsAvailable: () => false,
    }));
  };

  const service = await createService();
  const botA = await service.snapshot({ audienceId: "device_a", botId: "bot:a" });
  const botB = await service.snapshot({ audienceId: "device_a", botId: "bot:b" });
  const createBot = await service.snapshot({ audienceId: "device_a" });
  assert.deepEqual(botA.catalog.skills.map(({ label }) => label).sort(), ["Global", "Private bot:a"]);
  assert.deepEqual(botB.catalog.skills.map(({ label }) => label).sort(), ["Global", "Private bot:b"]);
  assert.deepEqual(createBot.catalog.skills.map(({ label }) => label), ["Global"]);
  assert.doesNotMatch(JSON.stringify(botA.catalog), /bot:b|Secret instructions/u);

  const bPrivateId = botB.catalog.skills.find(({ label }) => label === "Private bot:b")!.id;
  const provider = botA.catalog.providers[0]!;
  const home = botA.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!;
  await assert.rejects(
    service.bindCustom({
      audienceId: "device_a",
      botId: "bot:a",
      catalogRevision: botA.catalog.revision,
      selection: {
        providerId: provider.id,
        modelId: provider.models[0]!.id,
        fileScopeIds: [home.id],
        shellEnabled: false,
        connectionIds: [],
        skillIds: [bPrivateId],
        otherCapabilityIds: [],
      },
    }),
    /unavailable skill/u,
  );

  const restartedA = await (await createService()).snapshot({ audienceId: "device_a", botId: "bot:a" });
  assert.deepEqual(
    restartedA.catalog.skills.map(({ id, label }) => ({ id, label })),
    botA.catalog.skills.map(({ id, label }) => ({ id, label })),
  );
});

test("shipping Bot inventory is wired to canonical Pi providers and model drift fences", async () => {
  const services = await fs.readFile(
    path.join(process.cwd(), "main/services/bot-capability-services-main.ts"),
    "utf8",
  );
  const models = await fs.readFile(
    path.join(process.cwd(), "main/services/provider-registry.ts"),
    "utf8",
  );

  assert.match(services, /import \{ listConfiguredProviders \} from "\.\/provider-list-main\.js";/u);
  assert.match(services, /listProviders: listConfiguredProviders/u);
  assert.doesNotMatch(services, /listProviders:\s*\(\)\s*=>\s*configStore\.listProviders\(\)/u);
  assert.match(
    models,
    /withBotProviderInventoryMutation\(async \(\) =>/u,
  );
  assert.match(
    models,
    /\}, invalidateBotRuntimeInventoryAuthority\)/u,
  );
});
