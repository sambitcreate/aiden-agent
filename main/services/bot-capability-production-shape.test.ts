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
import {
  createBotCapabilityInventoryPorts,
  type BotResolvedSkill,
} from "./bot-capability-inventory-ports.js";
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
  assert.equal(
    signatures.every((value) => value !== undefined),
    true,
  );
  assert.equal(new Set(signatures).size, signatures.length);
  for (const value of signatures) assert.match(value!, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(signatures), /stored-secret|oauth-a|custom-secret/u);
});

test("production-shaped catalogs keep restart identity and public ids across exact-grant rotation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-production-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let credential = hash("credential-a");
  let skills: BotResolvedSkill[] = [
    {
      sourceId: "skill:resolved",
      label: "Resolved",
      description: "A discovered skill",
      instructions: "Private instructions",
      available: true,
    },
  ];
  let randomCounter = 0;
  const createService = async () => {
    const protectedStore = createBotCapabilityStore({
      root: () => root,
      mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
      mintIncarnation: () => Buffer.alloc(32, ++randomCounter).toString("base64url"),
    });
    await protectedStore.initialize();
    const incarnations = createBotCapabilityIncarnationStore(protectedStore);
    return createBotCapabilityCatalogMainService(
      createBotCapabilityInventoryPorts({
        loadOpaqueSelectionKey: async () => Buffer.alloc(32, 9),
        loadNoticeStatus: async () => ({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          requiresAcknowledgement: true,
        }),
        listProviders: async () => [
          {
            id: "provider",
            kind: "openai",
            label: "Provider",
            baseUrl: "https://provider.invalid/v1",
            models: ["chat"],
            needsKey: true,
            hasKey: true,
          },
        ],
        providerCredentialSignature: async () => credential,
        listMcpServers: async () => [],
        inspectMcpScopes: async () => [],
        listSkills: async () => skills,
        listApprovedLocations: async () => [],
        incarnations,
        getSettings: async () => ({}),
        webSearchAvailability: async () => ({ ready: false }),
        subagentsAvailable: () => false,
      }),
    );
  };

  const first = await (await createService()).snapshot({ audienceId: "device_a" });
  const restarted = await (await createService()).snapshot({ audienceId: "device_a" });
  assert.equal(restarted.catalog.providers[0]?.id, first.catalog.providers[0]?.id);
  assert.equal(restarted.catalog.skills[0]?.id, first.catalog.skills[0]?.id);

  credential = hash("credential-b");
  const rotated = await (await createService()).snapshot({ audienceId: "device_a" });
  assert.equal(rotated.catalog.providers[0]?.id, first.catalog.providers[0]?.id);
  assert.notEqual(
    rotated.resources.providers[0]?.connectionFingerprint,
    first.resources.providers[0]?.connectionFingerprint,
  );

  skills = [];
  await (await createService()).snapshot({ audienceId: "device_a" });
  skills = [
    {
      sourceId: "skill:resolved",
      label: "Resolved",
      description: "A discovered skill",
      instructions: "Private instructions",
      available: true,
    },
  ];
  const readded = await (await createService()).snapshot({ audienceId: "device_a" });
  assert.equal(readded.catalog.skills[0]?.id, first.catalog.skills[0]?.id);
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
    return createBotCapabilityCatalogMainService(
      createBotCapabilityInventoryPorts({
        loadOpaqueSelectionKey: async () => Buffer.alloc(32, 17),
        loadNoticeStatus: async () => ({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          requiresAcknowledgement: true,
        }),
        listProviders: async () => [
          {
            id: "provider",
            kind: "openai",
            label: "Provider",
            baseUrl: "https://provider.invalid/v1",
            models: ["chat"],
            needsKey: false,
            hasKey: false,
          },
        ],
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
        webSearchAvailability: async () => ({ ready: false }),
        subagentsAvailable: () => false,
      }),
    );
  };

  const service = await createService();
  const botA = await service.snapshot({ audienceId: "device_a", botId: "bot:a" });
  const botB = await service.snapshot({ audienceId: "device_a", botId: "bot:b" });
  const createBot = await service.snapshot({ audienceId: "device_a" });
  assert.deepEqual(botA.catalog.skills.map(({ label }) => label).sort(), [
    "Global",
    "Private bot:a",
  ]);
  assert.deepEqual(botB.catalog.skills.map(({ label }) => label).sort(), [
    "Global",
    "Private bot:b",
  ]);
  assert.deepEqual(
    createBot.catalog.skills.map(({ label }) => label),
    ["Global"],
  );
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

  const restartedA = await (
    await createService()
  ).snapshot({ audienceId: "device_a", botId: "bot:a" });
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

  assert.match(
    services,
    /import \{ listConfiguredProviders \} from "\.\/provider-list-main\.js";/u,
  );
  assert.match(services, /listProviders: listConfiguredProviders/u);
  assert.doesNotMatch(services, /listProviders:\s*\(\)\s*=>\s*configStore\.listProviders\(\)/u);
  assert.match(models, /withBotProviderInventoryMutation\(async \(\) =>/u);
  assert.match(models, /\}, invalidateBotRuntimeInventoryAuthority\)/u);
});

test("global Skills pause preserves real incarnations and exact saved Bot grants across catalog reads, edits, and restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-paused-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let skillsEnabled = true;
  let instruction = "Private unchanged instructions";
  let discoveries = 0;
  let randomCounter = 0;
  const createServices = async () => {
    const store = createBotCapabilityStore({
      root: () => root,
      mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
      mintIncarnation: () => Buffer.alloc(32, ++randomCounter).toString("base64url"),
    });
    await store.initialize();
    const catalog = createBotCapabilityCatalogMainService(createBotCapabilityInventoryPorts({
      loadOpaqueSelectionKey: async () => Buffer.alloc(32, 21),
      loadNoticeStatus: (audience) => store.noticeStatus(audience),
      listProviders: async () => [{ id: "provider", kind: "openai", label: "Provider", baseUrl: "", models: ["chat"], needsKey: false, hasKey: false }],
      providerCredentialSignature: async () => hash("credential"),
      listMcpServers: async () => [],
      inspectMcpScopes: async () => [],
      listSkills: async (target) => {
        discoveries += 1;
        return [
          { sourceId: "global-skill", label: "Global", description: "Global skill", instructions: instruction, available: true },
          ...(target ? [{ sourceId: `private-${target.botId}`, label: "Private", description: "Bot skill", instructions: instruction, available: true, incarnationPartition: `bot:${target.botId}` }] : []),
        ];
      },
      listApprovedLocations: async () => [],
      incarnations: createBotCapabilityIncarnationStore(store),
      getSettings: async () => ({ skillsEnabled }),
      webSearchAvailability: async () => ({ ready: false }),
      subagentsAvailable: () => false,
    }));
    return { store, catalog };
  };
  let { store, catalog } = await createServices();
  const audienceId = "device_a";
  const botId = "bot:paused";
  await store.acknowledgeNotice(audienceId, {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: "customize_first",
    confirmedForeground: true,
  });
  const enabled = await catalog.snapshot({ audienceId, botId });
  const custom = {
    providerId: enabled.catalog.providers[0]!.id,
    modelId: enabled.catalog.providers[0]!.models[0]!.id,
    fileScopeIds: [enabled.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!.id],
    shellEnabled: false,
    connectionIds: [],
    skillIds: enabled.catalog.skills.map(({ id }) => id),
    otherCapabilityIds: [],
  };
  const saved = await catalog.bindCustom({ audienceId, botId, selection: custom, catalogRevision: enabled.catalog.revision, snapshot: enabled });
  const policy = await store.createBotPolicy({ botId, catalog: enabled.catalog, access: { accessMode: "custom", custom, catalogRevision: enabled.catalog.revision }, binding: saved });
  const chat = await store.createChatPolicy({ botId, chatId: "chat:paused", expectedBotPolicyRevision: policy.revision, catalog: enabled.catalog });
  const discoveryCount = discoveries;
  skillsEnabled = false;
  const paused = await catalog.snapshot({ audienceId, botId, retainedBindings: [saved] });
  assert.equal(paused.catalog.skillsEnabled, false);
  assert.ok(paused.catalog.skills.every(({ available }) => !available));
  assert.equal(discoveries, discoveryCount, "off must not read skill instructions");
  assert.deepEqual((await catalog.snapshot({ audienceId })).catalog.skills, []);
  // Audience preflight, archived reads, and admission all consume the same
  // main-owned suppression bit instead of requiring each caller to guess it.
  await store.assertAuthorityBindingsCurrent({ botId, chatId: chat.chatId, snapshot: paused });
  const admitted = await store.admit({ audienceId, botId, chatId: chat.chatId, snapshot: paused });
  admitted.lease.release();
  const edited = { ...custom, shellEnabled: true };
  const retained = await catalog.bindCustom({ audienceId, botId, selection: edited, catalogRevision: paused.catalog.revision, snapshot: paused, retainedBindings: [saved] });
  assert.deepEqual(retained.skills, saved.skills, "unrelated edit retains exact fingerprints");
  const updated = await store.updateBotPolicy({ botId, expectedRevision: policy.revision, catalog: paused.catalog, access: { accessMode: "custom", custom: edited, catalogRevision: paused.catalog.revision }, binding: retained });
  await store.updateChatPolicy({ chatId: chat.chatId, expectedRevision: chat.revision, catalog: paused.catalog, access: { mode: "custom", custom, expectedBotPolicyRevision: updated.revision, catalogRevision: paused.catalog.revision } });
  await assert.rejects(catalog.bindCustom({ audienceId, botId, selection: edited, catalogRevision: paused.catalog.revision, snapshot: paused }), /disabled/u);
  await assert.rejects(catalog.bindCustom({ audienceId, botId, selection: { ...edited, skillIds: [...edited.skillIds, "skill:unknown"] }, catalogRevision: paused.catalog.revision, snapshot: paused, retainedBindings: [saved] }), /disabled/u);
  await store.archiveBotAuthority(botId);
  await store.assertAuthorityBindingsCurrent({ botId, chatId: chat.chatId, snapshot: paused });
  assert.equal((await store.inspectArchivedReadAuthority(botId, chat.chatId)).policy.authorityStatus, "archived");
  await store.restoreBotAuthority(botId);
  ({ store, catalog } = await createServices());
  skillsEnabled = true;
  const resumed = await catalog.snapshot({ audienceId, botId, retainedBindings: [retained] });
  assert.deepEqual(resumed.resources.skills, enabled.resources.skills, "disable/read/restart/enable must not churn incarnations");
  const resumedAdmission = await store.admit({ audienceId, botId, chatId: chat.chatId, snapshot: resumed });
  resumedAdmission.lease.release();
  skillsEnabled = false;
  await catalog.snapshot({ audienceId, botId, retainedBindings: [retained] });
  instruction = "Changed while paused";
  skillsEnabled = true;
  const changed = await catalog.snapshot({ audienceId, botId, retainedBindings: [retained] });
  await assert.rejects(store.admit({ audienceId, botId, chatId: chat.chatId, snapshot: changed }), /changed|current|capabilit/iu);
});
