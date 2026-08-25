import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BOT_FULL_ACCESS_NOTICE_VERSION,
  BotCapabilityValidationError,
  parseBotCustomSelection,
  type BotCapabilityCatalog,
  type BotCustomSelection,
} from "../../renderer/shared/bot-capabilities.js";
import {
  buildBotCapabilityCatalogSnapshot,
  type BotCapabilityInventory,
} from "./bot-capability-catalog-core.js";
import {
  bindBotProviderModel,
  bindBotCustomSelection,
  BotCapabilityBindingDriftError,
  createBotCapabilityOpaqueIdMint,
} from "./bot-capability-bindings.js";
import {
  BotCapabilityCatalogConflictError,
  BotCapabilityNoticeRequiredError,
  BotCapabilityRevisionConflictError,
  BotCapabilityStateEditor,
  BotCapabilitySubsetError,
  BotCapabilityUnavailableError,
  emptyBotCapabilityState,
  parseBotCapabilityState,
  projectBotAccessView,
  projectBotChatAccessView,
  projectBotNoticeStatus,
  type BotCapabilityState,
} from "./bot-capability-store-core.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function inventory(): BotCapabilityInventory {
  return {
    providers: [{
      sourceId: "private-provider",
      label: "Provider",
      available: true,
      connectionFingerprint: digest("provider"),
      models: [{
        sourceId: "private-model",
        label: "Model",
        available: true,
        modelFingerprint: digest("model"),
      }, {
        sourceId: "private-model-next",
        label: "Model Next",
        available: true,
        supportsImages: true,
        modelFingerprint: digest("model-next"),
      }],
    }],
    fileScopes: [
      { sourceId: "private-full", label: "Full Mac", available: true, kind: "full_mac", scopeFingerprint: digest("full") },
      { sourceId: "private-home", label: "Bot folder", available: true, kind: "bot_home", scopeFingerprint: digest("home") },
      { sourceId: "private-chosen", label: "Chosen folder", available: true, kind: "approved_location", scopeFingerprint: digest("chosen") },
    ],
    shell: { available: true, shellFingerprint: digest("shell") },
    connections: ["Mail", "Calendar"].map((label) => ({
      sourceId: `private-${label.toLowerCase()}`,
      label,
      available: true,
      connectionFingerprint: digest(`connection-${label}`),
      tools: [{
        name: `${label.toLowerCase()}_tool`,
        inputSchemaFingerprint: digest(`input-${label}`),
        outputSchemaFingerprint: digest(`output-${label}`),
        effect: "mutating" as const,
        effectFingerprint: digest(`effect-${label}`),
      }],
    })),
    skills: ["Writing", "Review"].map((label) => ({
      sourceId: `private-${label.toLowerCase()}`,
      label,
      available: true,
      identityFingerprint: digest(`identity-${label}`),
      contentFingerprint: digest(`content-${label}`),
    })),
    otherCapabilities: ["web", "schedules"].map((kind) => ({
      kind: kind as "web" | "schedules",
      label: kind === "web" ? "Web" : "Schedules",
      available: true,
      capabilityFingerprint: digest(`capability-${kind}`),
    })),
  };
}

const opaqueKey = Buffer.alloc(32, 7);
const snapshot = buildBotCapabilityCatalogSnapshot({
  inventory: inventory(),
  notice: { version: BOT_FULL_ACCESS_NOTICE_VERSION, requiresAcknowledgement: true },
  mintOpaqueId: createBotCapabilityOpaqueIdMint(opaqueKey),
});
const catalogRevision = snapshot.catalog.revision;

function catalog(revision = catalogRevision): BotCapabilityCatalog {
  return { ...structuredClone(snapshot.catalog), revision };
}

function selection(overrides: Partial<BotCustomSelection> = {}): BotCustomSelection {
  const home = snapshot.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!;
  const chosen = snapshot.catalog.fileScopes.find(({ kind }) => kind === "approved_location")!;
  return {
    providerId: snapshot.catalog.providers[0]!.id,
    modelId: snapshot.catalog.providers[0]!.models[0]!.id,
    fileScopeIds: [home.id, chosen.id],
    shellEnabled: true,
    connectionIds: snapshot.catalog.connections.map(({ id }) => id),
    skillIds: snapshot.catalog.skills.map(({ id }) => id),
    otherCapabilityIds: snapshot.catalog.otherCapabilities.map(({ id }) => id),
    ...overrides,
  };
}

function binding(custom: BotCustomSelection) {
  return bindBotCustomSelection({ selection: custom, catalogRevision, snapshot });
}

function selectionForModel(index: number): BotCustomSelection {
  return selection({ modelId: snapshot.catalog.providers[0]!.models[index]!.id });
}

function modelBinding(index: number) {
  return binding(selectionForModel(index)).provider;
}

function fixture(state: BotCapabilityState = emptyBotCapabilityState()) {
  let timestamp = 1_000;
  let incarnation = 0;
  const editor = new BotCapabilityStateEditor(state, {
    now: () => ++timestamp,
    mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
    mintIncarnation: () => Buffer.alloc(32, ++incarnation).toString("base64url"),
  });
  return { state, editor };
}

test("strict Custom parsing rejects smuggled bindings, paths, duplicates, and malformed Unicode", () => {
  assert.throws(
    () => parseBotCustomSelection({ ...selection(), fingerprint: "secret" }),
    BotCapabilityValidationError,
  );
  assert.throws(
    () => parseBotCustomSelection({ ...selection(), connectionIds: ["../../secret"] }),
    BotCapabilityValidationError,
  );
  assert.throws(
    () => parseBotCustomSelection({ ...selection(), skillIds: ["skill:write", "skill:write"] }),
    BotCapabilityValidationError,
  );
  assert.throws(
    () => parseBotCustomSelection({ ...selection(), providerId: "bad\ud800" }),
    BotCapabilityValidationError,
  );
});

test("archived read inspection preserves exact policy and chat epochs without admitting action", () => {
  const { editor } = fixture();
  const bot = editor.createBotPolicy({
    botId: "bot:archived-reader",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  const chat = editor.createChatPolicy({
    chatId: "chat:archived-reader",
    botId: bot.botId,
    expectedBotPolicyRevision: bot.revision,
    catalog: catalog(),
  });
  assert.throws(
    () => editor.inspectArchivedReadAuthority(bot.botId, chat.chatId),
    BotCapabilityUnavailableError,
  );
  editor.archiveBotAuthority(bot.botId);
  const archived = editor.inspectArchivedReadAuthority(bot.botId, chat.chatId);
  assert.equal(archived.policy.authorityStatus, "archived");
  assert.equal(archived.policy.policyEpoch, 2);
  assert.equal(archived.chat.policyEpoch, 1);
  assert.equal(archived.effectiveCustom, undefined);
  assert.throws(
    () => editor.inspectArchivedReadAuthority(bot.botId, "chat:other"),
    BotCapabilityUnavailableError,
  );
});

test("Custom policy bindings are mandatory, private in projections, strict on disk, and drift-aware", () => {
  const { state, editor } = fixture();
  const custom = selection();
  assert.throws(
    () =>
      editor.createBotPolicy({
        botId: "bot:unbound",
        catalog: catalog(),
        access: { accessMode: "custom", catalogRevision, custom },
      }),
    /exact main-owned binding/u,
  );
  assert.equal(state.sequence, 0);

  const view = editor.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom },
    binding: binding(custom),
  });
  const publicJson = JSON.stringify(view);
  assert.doesNotMatch(publicJson, /binding|sourceId|fingerprint|private-/iu);
  assert.doesNotThrow(() =>
    editor.assertAuthorityBindingsCurrent({ botId: "bot:one", snapshot }),
  );

  const changedInventory = inventory();
  changedInventory.skills[0]!.contentFingerprint = digest("changed-skill-content");
  const drifted = buildBotCapabilityCatalogSnapshot({
    inventory: changedInventory,
    notice: { version: BOT_FULL_ACCESS_NOTICE_VERSION, requiresAcknowledgement: true },
    mintOpaqueId: createBotCapabilityOpaqueIdMint(opaqueKey),
  });
  assert.throws(
    () => editor.assertAuthorityBindingsCurrent({ botId: "bot:one", snapshot: drifted }),
    BotCapabilityBindingDriftError,
  );

  const futureBinding = structuredClone(state) as unknown as {
    policies: Array<{ binding: { version: number } }>;
  };
  futureBinding.policies[0]!.binding.version = 99;
  assert.throws(() => parseBotCapabilityState(futureBinding));

  const corruptBinding = structuredClone(state) as unknown as {
    policies: Array<{ binding: { provider: { connectionFingerprint: string } } }>;
  };
  corruptBinding.policies[0]!.binding.provider.connectionFingerprint = "0".repeat(64);
  assert.throws(() => parseBotCapabilityState(corruptBinding), /private facts/u);
});

test("legacy migration writes explicit Full records once and never repairs a later missing record as Full", () => {
  const { state, editor } = fixture();
  const migrated = editor.migrateLegacyBotsToFull({
    botIds: ["bot:legacy-a", "bot:legacy-b"],
    catalogRevision,
    confirmedExplicitFull: true,
  });
  assert.deepEqual(migrated.map(({ accessMode }) => accessMode), ["full", "full"]);
  assert.equal(state.policies.every(({ accessMode }) => accessMode === "full"), true);
  assert.ok(state.legacyMigration);
  assert.deepEqual(
    editor.migrateLegacyBotsToFull({
      botIds: ["bot:legacy-a", "bot:legacy-b"],
      catalogRevision,
      confirmedExplicitFull: true,
    }),
    migrated,
  );

  state.policies = state.policies.filter(({ botId }) => botId !== "bot:legacy-b");
  assert.throws(
    () =>
      editor.migrateLegacyBotsToFull({
        botIds: ["bot:legacy-a", "bot:legacy-b"],
        catalogRevision,
        confirmedExplicitFull: true,
      }),
    /already sealed/u,
  );
  assert.equal(editor.auditBotInventory(["bot:legacy-a", "bot:legacy-b"]).complete, false);
});

test("legacy migration atomically seals historical chat policies and never widens a lost reduction", () => {
  const { state, editor } = fixture();
  editor.migrateLegacyBotsToFull({
    botIds: ["bot:legacy"],
    chats: [{ botId: "bot:legacy", chatId: "chat:legacy" }],
    catalogRevision,
    confirmedExplicitFull: true,
  });
  assert.equal(state.policies[0]?.accessMode, "full");
  assert.equal(state.chats[0]?.mode, "inherit");
  assert.ok(state.legacyMigration);

  // Losing a chat policy after the one-time migration could erase a prior
  // Custom reduction, so restart repair must fail closed instead of inheriting.
  state.chats = [];
  assert.throws(
    () => editor.migrateLegacyBotsToFull({
      botIds: ["bot:legacy"],
      chats: [{ botId: "bot:legacy", chatId: "chat:legacy" }],
      catalogRevision,
      confirmedExplicitFull: true,
    }),
    /already sealed/u,
  );
});

test("missing, old, future, rolled-back, duplicate, and widening stored state fails closed", () => {
  assert.throws(() => parseBotCapabilityState(undefined), BotCapabilityUnavailableError);
  assert.throws(
    () => parseBotCapabilityState({ ...emptyBotCapabilityState(), version: 1 }),
    BotCapabilityUnavailableError,
  );
  assert.throws(
    () => parseBotCapabilityState({ ...emptyBotCapabilityState(), version: 99 }),
    BotCapabilityUnavailableError,
  );

  const { state, editor } = fixture();
  const botCustom = selection();
  const bot = editor.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom: botCustom },
    binding: binding(botCustom),
  });
  const mailId = snapshot.catalog.connections[0]!.id;
  const calendarId = snapshot.catalog.connections[1]!.id;
  const chat = editor.createChatPolicy({
    chatId: "chat:one",
    botId: "bot:one",
    expectedBotPolicyRevision: bot.revision,
    catalog: catalog(),
    custom: selection({ connectionIds: [mailId] }),
  });
  assert.ok(chat.revision);

  assert.throws(
    () => parseBotCapabilityState({ ...structuredClone(state), sequence: 0 }),
    /revision history/u,
  );
  const duplicate = structuredClone(state);
  duplicate.policies.push(structuredClone(duplicate.policies[0]!));
  assert.throws(() => parseBotCapabilityState(duplicate), /duplicate Bot/u);
  const widened = structuredClone(state);
  const child = widened.chats[0]!;
  if (child.mode !== "custom") assert.fail("expected custom chat");
  child.custom.connectionIds.push(calendarId);
  const narrowPolicyCustom = selection({ connectionIds: [mailId] });
  widened.policies[0] = {
    ...widened.policies[0]!,
    accessMode: "custom",
    custom: narrowPolicyCustom,
    binding: binding(narrowPolicyCustom),
  };
  assert.throws(() => parseBotCapabilityState(widened), /exceeds its stored/u);
});

test("catalog and optimistic revisions are exact and forged chat widening is rejected", () => {
  const { state, editor } = fixture();
  const botCustom = selection();
  const mailId = snapshot.catalog.connections[0]!.id;
  const bot = editor.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom: botCustom },
    binding: binding(botCustom),
  });
  assert.throws(
    () =>
      editor.updateBotPolicy({
        botId: "bot:one",
        expectedRevision: bot.revision,
        catalog: catalog("catalog:other"),
        access: { accessMode: "full", catalogRevision, confirmedForeground: true },
      }),
    BotCapabilityCatalogConflictError,
  );
  assert.throws(
    () =>
      editor.updateBotPolicy({
        botId: "bot:one",
        expectedRevision: "revision:stale",
        catalog: catalog(),
        access: { accessMode: "full", catalogRevision, confirmedForeground: true },
      }),
    BotCapabilityRevisionConflictError,
  );

  const chat = editor.createChatPolicy({
    chatId: "chat:one",
    botId: "bot:one",
    expectedBotPolicyRevision: bot.revision,
    catalog: catalog(),
    custom: selection({ shellEnabled: false, connectionIds: [mailId] }),
  });
  assert.throws(
    () =>
      editor.updateChatPolicy({
        chatId: "chat:one",
        expectedRevision: chat.revision,
        catalog: catalog(),
        access: {
          mode: "custom",
          catalogRevision,
          expectedBotPolicyRevision: bot.revision,
          custom: selection({ connectionIds: ["connection:unknown"] }),
        },
      }),
    /unavailable connection/u,
  );

  const narrowedBotCustom = selection({ shellEnabled: false, connectionIds: [] });
  const narrowBot = editor.updateBotPolicy({
    botId: "bot:one",
    expectedRevision: bot.revision,
    catalog: catalog(),
    access: {
      accessMode: "custom",
      catalogRevision,
      custom: narrowedBotCustom,
    },
    binding: binding(narrowedBotCustom),
  });
  assert.equal(narrowBot.narrowed, true);
  assert.deepEqual(narrowBot.narrowedChats.map(({ chatId }) => chatId), ["chat:one"]);
  const reduced = narrowBot.narrowedChats[0];
  assert.ok(reduced);
  const reducedView = projectBotChatAccessView(state, "chat:one");
  assert.equal(reducedView.mode, "custom");
  if (reducedView.mode !== "custom") assert.fail("expected reduced Custom chat");
  assert.deepEqual(reducedView.custom.connectionIds, []);
  assert.equal(reducedView.custom.shellEnabled, false);
});

test("Full model authority bumps revisions and rebases only the canonical reduced chat", () => {
  const { state, editor } = fixture();
  const initialSelection = selectionForModel(0);
  const initial = editor.createBotPolicy({
    botId: "bot:model-owner",
    catalog: catalog(),
    access: {
      accessMode: "full",
      catalogRevision,
      confirmedForeground: true,
      providerId: initialSelection.providerId,
      modelId: initialSelection.modelId,
    },
    modelBinding: modelBinding(0),
  });
  const mailId = snapshot.catalog.connections[0]!.id;
  const writingId = snapshot.catalog.skills[0]!.id;
  const reduced = selectionForModel(0);
  reduced.shellEnabled = false;
  reduced.connectionIds = [mailId];
  reduced.skillIds = [writingId];
  reduced.otherCapabilityIds = [];
  const canonical = editor.createChatPolicy({
    chatId: "chat:canonical",
    botId: initial.botId,
    expectedBotPolicyRevision: initial.revision,
    catalog: catalog(),
    custom: reduced,
  });
  const legacy = editor.createChatPolicy({
    chatId: "chat:legacy",
    botId: initial.botId,
    expectedBotPolicyRevision: initial.revision,
    catalog: catalog(),
    custom: reduced,
  });
  const legacyBefore = structuredClone(state.chats.find(({ chatId }) => chatId === legacy.chatId));
  const nextSelection = selectionForModel(1);

  const updated = editor.updateBotPolicy({
    botId: initial.botId,
    expectedRevision: initial.revision,
    catalog: catalog(),
    access: {
      accessMode: "full",
      catalogRevision,
      confirmedForeground: true,
      providerId: nextSelection.providerId,
      modelId: nextSelection.modelId,
    },
    modelBinding: modelBinding(1),
    canonicalChatId: canonical.chatId,
  });

  assert.equal(updated.authorityChanged, true);
  assert.notEqual(updated.view.revision, initial.revision);
  assert.notEqual(updated.view.policyEpoch, initial.policyEpoch);
  assert.deepEqual(updated.narrowedChats.map(({ chatId }) => chatId), [canonical.chatId]);
  assert.deepEqual(editor.getBotModelAuthority(initial.botId)?.selection, {
    providerId: nextSelection.providerId,
    modelId: nextSelection.modelId,
  });
  const canonicalAfter = projectBotChatAccessView(state, canonical.chatId);
  assert.equal(canonicalAfter.mode, "custom");
  if (canonicalAfter.mode !== "custom") assert.fail("expected canonical Custom chat");
  assert.equal(canonicalAfter.custom.providerId, nextSelection.providerId);
  assert.equal(canonicalAfter.custom.modelId, nextSelection.modelId);
  assert.equal(canonicalAfter.custom.shellEnabled, false);
  assert.deepEqual(canonicalAfter.custom.connectionIds, [mailId]);
  assert.deepEqual(canonicalAfter.custom.skillIds, [writingId]);
  assert.deepEqual(canonicalAfter.custom.otherCapabilityIds, []);
  assert.notEqual(canonicalAfter.revision, canonical.revision);
  assert.equal(
    state.chats.find(({ chatId }) => chatId === canonical.chatId)?.policyEpoch,
    2,
  );
  assert.deepEqual(
    state.chats.find(({ chatId }) => chatId === legacy.chatId),
    legacyBefore,
  );
  assert.doesNotThrow(() => editor.assertAuthorityBindingsCurrent({
    botId: initial.botId,
    chatId: canonical.chatId,
    snapshot,
  }));
  const changedSnapshot = buildBotCapabilityCatalogSnapshot({
    inventory: {
      ...inventory(),
      providers: inventory().providers.map((provider) => ({
        ...provider,
        connectionFingerprint: digest("provider-credentials-changed"),
      })),
    },
    notice: snapshot.catalog.notice,
    mintOpaqueId: createBotCapabilityOpaqueIdMint(Buffer.alloc(32, 7)),
  });
  assert.throws(
    () => editor.assertAuthorityBindingsCurrent({
      botId: initial.botId,
      chatId: canonical.chatId,
      snapshot: changedSnapshot,
    }),
    BotCapabilityBindingDriftError,
  );
  assert.doesNotThrow(() => parseBotCapabilityState(structuredClone(state)));
  assert.throws(
    () => editor.updateBotPolicy({
      botId: initial.botId,
      expectedRevision: initial.revision,
      catalog: catalog(),
      access: {
        accessMode: "full",
        catalogRevision,
        confirmedForeground: true,
        providerId: initialSelection.providerId,
        modelId: initialSelection.modelId,
      },
      modelBinding: modelBinding(0),
      canonicalChatId: canonical.chatId,
    }),
    BotCapabilityRevisionConflictError,
  );
});

test("companion vision authority is exact, revisioned, preserved when omitted, and explicitly clearable", () => {
  const { editor } = fixture();
  const provider = snapshot.catalog.providers[0]!;
  const textModel = provider.models.find((model) => model.supportsImages !== true)!;
  const visionModel = provider.models.find((model) => model.supportsImages === true)!;
  const primary = selection({ modelId: textModel.id });
  const vision = selection({ modelId: visionModel.id });
  assert.throws(
    () => bindBotProviderModel({
      providerId: primary.providerId,
      modelId: primary.modelId,
      catalogRevision,
      snapshot,
      requireImages: true,
    }),
    /must support image input/u,
  );
  const created = editor.createBotPolicy({
    botId: "bot:vision-companion",
    catalog: catalog(),
    access: {
      accessMode: "full",
      catalogRevision,
      confirmedForeground: true,
      providerId: primary.providerId,
      modelId: primary.modelId,
      visionModel: { providerId: vision.providerId, modelId: vision.modelId },
    },
    modelBinding: binding(primary).provider,
    visionModelBinding: bindBotProviderModel({
      providerId: vision.providerId,
      modelId: vision.modelId,
      catalogRevision,
      snapshot,
      requireImages: true,
    }),
  });
  assert.deepEqual(editor.getBotVisionModelAuthority(created.botId)?.selection, {
    providerId: vision.providerId,
    modelId: vision.modelId,
  });
  const lostVisionInventory = inventory();
  const sourceVision = lostVisionInventory.providers[0]!.models.find(
    (model) => model.supportsImages === true,
  )!;
  sourceVision.supportsImages = false;
  const lostVisionSnapshot = buildBotCapabilityCatalogSnapshot({
    inventory: lostVisionInventory,
    notice: snapshot.catalog.notice,
    mintOpaqueId: createBotCapabilityOpaqueIdMint(opaqueKey),
  });
  assert.throws(
    () => editor.assertAuthorityBindingsCurrent({
      botId: created.botId,
      snapshot: lostVisionSnapshot,
    }),
    BotCapabilityBindingDriftError,
  );

  const preserved = editor.updateBotPolicy({
    botId: created.botId,
    expectedRevision: created.revision,
    catalog: catalog(),
    access: {
      accessMode: "full",
      catalogRevision,
      confirmedForeground: true,
      providerId: primary.providerId,
      modelId: primary.modelId,
    },
    modelBinding: binding(primary).provider,
  });
  assert.equal(preserved.authorityChanged, false);
  assert.deepEqual(editor.getBotVisionModelAuthority(created.botId)?.selection, {
    providerId: vision.providerId,
    modelId: vision.modelId,
  });

  const cleared = editor.updateBotPolicy({
    botId: created.botId,
    expectedRevision: preserved.view.revision,
    catalog: catalog(),
    access: {
      accessMode: "full",
      catalogRevision,
      confirmedForeground: true,
      providerId: primary.providerId,
      modelId: primary.modelId,
      visionModel: null,
    },
    modelBinding: binding(primary).provider,
  });
  assert.equal(cleared.authorityChanged, true);
  assert.equal(editor.getBotVisionModelAuthority(created.botId), undefined);
});

test("create rollback removes only an uncommitted identity policy and its impossible chats", () => {
  const { state, editor } = fixture();
  const first = editor.createBotPolicy({
    botId: "bot:first",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  editor.createChatPolicy({
    chatId: "chat:first",
    botId: "bot:first",
    expectedBotPolicyRevision: first.revision,
    catalog: catalog(),
  });
  editor.createBotPolicy({
    botId: "bot:second",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });

  assert.equal(
    editor.rollbackUncommittedBotPolicy({ botId: "bot:missing", identityCommitted: false }),
    false,
  );
  assert.equal(state.policies.length, 2);
  assert.throws(
    () =>
      editor.rollbackUncommittedBotPolicy({
        botId: "bot:first",
        identityCommitted: true,
      } as unknown as { botId: string; identityCommitted: false }),
    /committed Bot identity/u,
  );
  assert.equal(state.policies.length, 2);
  assert.equal(
    editor.rollbackUncommittedBotPolicy({ botId: "bot:first", identityCommitted: false }),
    true,
  );
  assert.deepEqual(state.policies.map(({ botId }) => botId), ["bot:second"]);
  assert.deepEqual(state.chats, []);
});

test("a Custom chat cannot exceed its Bot even with otherwise valid catalog grants", () => {
  const { editor } = fixture();
  const mailId = snapshot.catalog.connections[0]!.id;
  const calendarId = snapshot.catalog.connections[1]!.id;
  const botCustom = selection({ connectionIds: [mailId] });
  const bot = editor.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: {
      accessMode: "custom",
      catalogRevision,
      custom: botCustom,
    },
    binding: binding(botCustom),
  });
  assert.throws(
    () =>
      editor.createChatPolicy({
        chatId: "chat:one",
        botId: "bot:one",
        expectedBotPolicyRevision: bot.revision,
        catalog: catalog(),
        custom: selection({ connectionIds: [mailId, calendarId] }),
      }),
    BotCapabilitySubsetError,
  );
});

test("a Full Mac Custom bot permits narrower home and chosen-location chats", () => {
  const { state, editor } = fixture();
  const fullMac = snapshot.catalog.fileScopes.find(({ kind }) => kind === "full_mac")!;
  const home = snapshot.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!;
  const fullMacCustom = selection({ fileScopeIds: [fullMac.id] });
  const bot = editor.createBotPolicy({
    botId: "bot:full-mac",
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom: fullMacCustom },
    binding: binding(fullMacCustom),
  });
  assert.doesNotThrow(() =>
    editor.createChatPolicy({
      chatId: "chat:narrow-files",
      botId: "bot:full-mac",
      expectedBotPolicyRevision: bot.revision,
      catalog: catalog(),
      custom: selection(),
    }),
  );
  assert.doesNotThrow(() => parseBotCapabilityState(structuredClone(state)));

  const narrowedBot = selection({ fileScopeIds: [home.id] });
  editor.updateBotPolicy({
    botId: "bot:full-mac",
    expectedRevision: bot.revision,
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom: narrowedBot },
    binding: binding(narrowedBot),
  });
  const chat = projectBotChatAccessView(state, "chat:narrow-files");
  assert.equal(chat.mode, "custom");
  assert.deepEqual(chat.custom.fileScopeIds, [home.id]);
});

test("notice acknowledgement is isolated by stable audience and action admission never shares it", () => {
  const { state, editor } = fixture();
  editor.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  assert.throws(
    () => editor.assertBotMayAct({ audienceId: "device:b", botId: "bot:one" }),
    BotCapabilityNoticeRequiredError,
  );
  const accepted = editor.acknowledgeNotice("device:a", {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: "continue_full",
    confirmedForeground: true,
  });
  assert.equal(accepted.requiresAcknowledgement, false);
  assert.equal(projectBotNoticeStatus(state, "device:b").requiresAcknowledgement, true);
  editor.assertBotMayAct({ audienceId: "device:a", botId: "bot:one" });
  assert.throws(
    () => editor.assertBotMayAct({ audienceId: "device:b", botId: "bot:one" }),
    BotCapabilityNoticeRequiredError,
  );
  editor.acknowledgeNotice("device:b", {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: "customize_first",
    confirmedForeground: true,
  });
  assert.throws(
    () => editor.assertBotMayAct({ audienceId: "device:b", botId: "bot:one" }),
    BotCapabilityNoticeRequiredError,
  );
  const current = projectBotAccessView(state, "bot:one");
  const custom = selection({ shellEnabled: false });
  editor.updateBotPolicy({
    botId: "bot:one",
    expectedRevision: current.revision,
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom },
    binding: binding(custom),
  });
  editor.assertBotMayAct({ audienceId: "device:b", botId: "bot:one" });
  editor.assertBotMayAct({ audienceId: "device:a", botId: "bot:one" });
  assert.equal(editor.revokeNoticeAudience("device:a"), true);
  assert.equal(projectBotNoticeStatus(state, "device:a").requiresAcknowledgement, true);
  assert.throws(
    () => editor.assertBotMayAct({ audienceId: "device:a", botId: "bot:one" }),
    BotCapabilityNoticeRequiredError,
  );
  editor.assertBotMayAct({ audienceId: "device:b", botId: "bot:one" });
});
