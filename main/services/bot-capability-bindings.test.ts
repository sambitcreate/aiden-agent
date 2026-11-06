import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  validateSelectionAgainstCatalog,
  type BotCustomSelection,
} from "../../renderer/shared/bot-capabilities.js";
import {
  buildBotCapabilityCatalogSnapshot,
  type BotCapabilityInventory,
} from "./bot-capability-catalog-core.js";
import {
  BotCapabilityBindingDriftError,
  assertBoundBotCustomSelectionOpaqueIds,
  assertBoundBotCustomSelectionCurrent,
  bindBotCustomSelection,
  botProviderModelDrift,
  botCustomSelectionDrift,
  boundBotCustomSelectionFingerprint,
  createBotCapabilityOpaqueIdMint,
  mintLegacyBotCapabilityOpaqueId,
  parseBoundBotCustomSelection,
  parseBoundBotProviderModel,
  reconcileBoundBotCustomSelection,
  withBotCapabilityTombstones,
  type BoundBotCustomSelection,
} from "./bot-capability-bindings.js";
import {
  BotCapabilityCatalogMainService,
  type BotCapabilityInventoryPorts,
} from "./bot-capability-catalog-main.js";
import { COMPOSIO_SERVICE_ACCESS_IDENTITY } from "./bot-connection-capability-identity.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inventory(): BotCapabilityInventory {
  return {
    providers: [
      {
        sourceId: "private-provider-id",
        label: "Provider",
        available: true,
        connectionFingerprint: digest("provider-connection"),
        models: [
          {
            sourceId: "private-model-id",
            label: "Model",
            available: true,
            modelFingerprint: digest("model"),
          },
        ],
      },
    ],
    fileScopes: [
      {
        sourceId: "private-full-mac",
        label: "Full Mac",
        available: true,
        kind: "full_mac",
        scopeFingerprint: digest("full-mac"),
      },
      {
        sourceId: "private-bot-home",
        label: "Bot folder",
        available: true,
        kind: "bot_home",
        scopeFingerprint: digest("bot-home"),
      },
      {
        sourceId: "private-approved-root",
        label: "Documents",
        available: true,
        kind: "approved_location",
        scopeFingerprint: digest("approved-root"),
      },
    ],
    shell: { available: true, shellFingerprint: digest("shell") },
    connections: [
      {
        sourceId: "private-connection-id",
        label: "Calendar",
        available: true,
        connectionFingerprint: digest("connection-and-credential"),
        tools: [
          {
            name: "calendar_events",
            inputSchemaFingerprint: digest("input-schema"),
            outputSchemaFingerprint: digest("output-schema"),
            effect: "mutating",
            effectFingerprint: digest("unknown-means-mutating"),
          },
        ],
      },
    ],
    skills: [
      {
        sourceId: "private-skill-id",
        label: "Research",
        available: true,
        identityFingerprint: digest("skill-identity"),
        contentFingerprint: digest("skill-content"),
      },
    ],
    otherCapabilities: [
      {
        kind: "web",
        label: "Web",
        available: true,
        capabilityFingerprint: digest("web"),
      },
    ],
  };
}

const key = Buffer.alloc(32, 19);
const notice = {
  version: "bot-full-access-v1" as const,
  requiresAcknowledgement: true as const,
};

function snapshot(value = inventory(), selectionKey = key) {
  return buildBotCapabilityCatalogSnapshot({
    inventory: value,
    notice,
    mintOpaqueId: createBotCapabilityOpaqueIdMint(selectionKey),
  });
}

function fullSelection(current = snapshot()): BotCustomSelection {
  const provider = current.catalog.providers[0]!;
  const home = current.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!;
  const approved = current.catalog.fileScopes.find(({ kind }) => kind === "approved_location")!;
  return {
    providerId: provider.id,
    modelId: provider.models[0]!.id,
    fileScopeIds: [approved.id, home.id],
    shellEnabled: true,
    connectionIds: [current.catalog.connections[0]!.id],
    skillIds: [current.catalog.skills[0]!.id],
    otherCapabilityIds: [current.catalog.otherCapabilities[0]!.id],
  };
}

function binding(current = snapshot()): BoundBotCustomSelection {
  return bindBotCustomSelection({
    selection: fullSelection(current),
    catalogRevision: current.catalog.revision,
    snapshot: current,
  });
}

function composioInventory(service: boolean): BotCapabilityInventory {
  const value = inventory();
  const connection = value.connections[0]!;
  connection.sourceId = "preset-composio";
  connection.label = "Composio";
  connection.tools[0]!.name = service ? "composio" : "COMPOSIO_SEARCH_TOOLS";
  if (service) connection.accessIdentity = COMPOSIO_SERVICE_ACCESS_IDENTITY;
  return value;
}

function withLegacyConnectionId(bound: BoundBotCustomSelection): BoundBotCustomSelection {
  const legacy = structuredClone(bound);
  const connection = legacy.connections[0]!;
  connection.option.id = mintLegacyBotCapabilityOpaqueId(key, "connection", connection.sourceId, connection.exactFingerprint);
  legacy.selection.connectionIds = [connection.option.id];
  return parseBoundBotCustomSelection(legacy);
}

test("opaque ids stay stable across fingerprint churn and do not reveal source identity", () => {
  const first = createBotCapabilityOpaqueIdMint(key)("skill", "private-skill-id", digest("facts"));
  const restarted = createBotCapabilityOpaqueIdMint(Buffer.from(key))(
    "skill",
    "private-skill-id",
    digest("facts"),
  );
  const changedKey = createBotCapabilityOpaqueIdMint(Buffer.alloc(32, 20))(
    "skill",
    "private-skill-id",
    digest("facts"),
  );
  const changedFacts = createBotCapabilityOpaqueIdMint(key)(
    "skill",
    "private-skill-id",
    digest("changed-facts"),
  );
  const otherSource = createBotCapabilityOpaqueIdMint(key)(
    "skill",
    "other-private-skill-id",
    digest("facts"),
  );
  const legacy = mintLegacyBotCapabilityOpaqueId(
    key,
    "skill",
    "private-skill-id",
    digest("facts"),
  );
  assert.equal(restarted, first);
  assert.notEqual(changedKey, first);
  assert.equal(changedFacts, first);
  assert.notEqual(otherSource, first);
  assert.notEqual(legacy, first);
  assert.equal(first.includes("private-skill-id"), false);
  assert.match(first, /^bc_skill_[A-Za-z0-9_-]+$/u);
  assert.throws(() => createBotCapabilityOpaqueIdMint(Buffer.alloc(31)), /32-byte key/u);
});

test("Custom selection binds exact provider, file, shell, MCP tool, skill, and other facts", () => {
  const current = snapshot();
  const bound = binding(current);
  assert.equal(bound.version, 1);
  assert.deepEqual(bound.selection.fileScopeIds, [...bound.selection.fileScopeIds].sort());
  assert.equal(bound.provider.sourceProviderId, "private-provider-id");
  assert.equal(bound.provider.sourceModelId, "private-model-id");
  assert.equal(bound.connections[0]!.tools[0]!.name, "calendar_events");
  assert.equal(bound.connections[0]!.tools[0]!.effect, "mutating");
  assert.equal(bound.skills[0]!.sourceId, "private-skill-id");
  assert(bound.shell);
  assert.match(boundBotCustomSelectionFingerprint(bound), /^[a-f0-9]{64}$/u);
  assert.deepEqual(botCustomSelectionDrift(bound, current), []);
  assert.doesNotThrow(() => assertBoundBotCustomSelectionCurrent(bound, current));
});

test("a closed global Skills gate suppresses only skill drift validation", () => {
  const current = snapshot();
  const bound = binding(current);
  const withoutSkills = inventory();
  withoutSkills.skills = [];
  const disabledSnapshot = withBotCapabilityTombstones(
    buildBotCapabilityCatalogSnapshot({
      inventory: withoutSkills,
      notice,
      mintOpaqueId: createBotCapabilityOpaqueIdMint(key),
    }),
    [bound],
  );

  assert.throws(
    () => assertBoundBotCustomSelectionCurrent(bound, disabledSnapshot),
    BotCapabilityBindingDriftError,
  );
  assert.doesNotThrow(() =>
    assertBoundBotCustomSelectionCurrent(bound, disabledSnapshot, { skillsEnabled: false }),
  );
  assert.deepEqual(
    botCustomSelectionDrift(bound, disabledSnapshot, { skillsEnabled: false }),
    [],
  );
});

test("file choices enforce Full Mac exclusivity and approved-location Bot folder pairing", () => {
  const current = snapshot();
  const selection = fullSelection(current);
  const fullMac = current.catalog.fileScopes.find(({ kind }) => kind === "full_mac")!;
  const botHome = current.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!;
  const approved = current.catalog.fileScopes.find(({ kind }) => kind === "approved_location")!;

  assert.throws(
    () =>
      bindBotCustomSelection({
        selection: { ...selection, fileScopeIds: [fullMac.id, botHome.id] },
        catalogRevision: current.catalog.revision,
        snapshot: current,
      }),
    /Full Mac, Bot folder/u,
  );
  assert.throws(
    () =>
      bindBotCustomSelection({
        selection: { ...selection, fileScopeIds: [approved.id] },
        catalogRevision: current.catalog.revision,
        snapshot: current,
      }),
    /Full Mac, Bot folder/u,
  );
  assert.doesNotThrow(() =>
    bindBotCustomSelection({
      selection: { ...selection, fileScopeIds: [] },
      catalogRevision: current.catalog.revision,
      snapshot: current,
    }),
  );
  assert.doesNotThrow(() =>
    bindBotCustomSelection({
      selection: { ...selection, fileScopeIds: [fullMac.id] },
      catalogRevision: current.catalog.revision,
      snapshot: current,
    }),
  );
});

test("MCP schema/effect drift keeps the public id and fail-closes the stored grant", () => {
  const current = snapshot();
  const bound = binding(current);
  const changedInventory = inventory();
  changedInventory.connections[0]!.tools[0]!.inputSchemaFingerprint =
    digest("changed-input-schema");
  const changed = snapshot(changedInventory);
  assert.equal(changed.catalog.connections[0]!.id, current.catalog.connections[0]!.id);
  const result = reconcileBoundBotCustomSelection(bound, changed);
  assert.equal(result.state, "drifted");
  assert.deepEqual(result.issues, [
    {
      group: "connection",
      selectionId: bound.selection.connectionIds[0],
      reason: "changed_or_removed",
    },
  ]);
  const option = result.catalogSnapshot.catalog.connections.find(
    ({ id }) => id === bound.selection.connectionIds[0],
  );
  assert.equal(option?.available, true);
  assert.doesNotThrow(() =>
    bindBotCustomSelection({
      selection: bound.selection,
      catalogRevision: changed.catalog.revision,
      snapshot: changed,
    }),
  );
  assert.doesNotThrow(() =>
    validateSelectionAgainstCatalog(bound.selection, result.catalogSnapshot.catalog),
  );
  assert.throws(() => assertBoundBotCustomSelectionCurrent(bound, changed), BotCapabilityBindingDriftError);
  const publicJson = JSON.stringify(result.catalogSnapshot.catalog);
  assert.equal(publicJson.includes("private-connection-id"), false);
  assert.equal(publicJson.includes("calendar_events"), false);
  assert.equal(publicJson.includes("Fingerprint"), false);
});

test("Composio raw access stays an unavailable old choice until explicitly replaced by its service", async () => {
  const state = { inventory: composioInventory(false), keyLoads: 0, noticeLoads: [] as string[] };
  const service = new BotCapabilityCatalogMainService(mainPorts(state));
  const before = await service.snapshot({ audienceId: "device_a" });
  const old = await service.bindCustom({ audienceId: "device_a", selection: fullSelection(before), catalogRevision: before.catalog.revision });
  state.inventory = composioInventory(true);
  const result = await service.reconcile(old, { audienceId: "device_a", botId: "bot:one" });
  assert.equal(result.state, "drifted");
  const oldRow = result.catalogSnapshot.catalog.connections.find(({ id }) => id === old.selection.connectionIds[0]);
  const newRow = result.catalogSnapshot.catalog.connections.find(({ available }) => available);
  assert.equal(result.catalogSnapshot.catalog.connections.length, 2);
  assert.deepEqual(oldRow, { ...old.connections[0]!.option, available: false, label: "Previous Composio access" });
  assert.ok(newRow); assert.notEqual(newRow.id, oldRow!.id);
  assert.equal(newRow.label, "Composio");
  const unrelatedEdit = { ...old.selection, shellEnabled: false };
  await assert.rejects(service.bindCustom({ audienceId: "device_a", selection: unrelatedEdit, catalogRevision: result.catalogSnapshot.catalog.revision, retainedBindings: [old] }), /unavailable/u);
  const explicit = await service.bindCustom({ audienceId: "device_a", selection: { ...unrelatedEdit, connectionIds: [newRow.id] }, catalogRevision: result.catalogSnapshot.catalog.revision, retainedBindings: [old] });
  assert.equal(explicit.connections[0]!.accessIdentity, COMPOSIO_SERVICE_ACCESS_IDENTITY);
  assert.equal(explicit.connections[0]!.sourceId, "preset-composio", "runtime transport identity stays unchanged");
  assert.equal(explicit.connections[0]!.tools[0]!.name, "composio");
  assertBoundBotCustomSelectionOpaqueIds(parseBoundBotCustomSelection(JSON.parse(JSON.stringify(explicit))), createBotCapabilityOpaqueIdMint(key));
  await service.assertCurrent(explicit, { mode: "runtime", botId: "bot:one" });
  assert.equal(JSON.stringify(result.catalogSnapshot.catalog).includes("accessIdentity"), false);
});

test("Composio migration preserves distinct legacy ids and rejects collisions without consuming the service row", () => {
  const old = binding(snapshot(composioInventory(false)));
  const legacy = withLegacyConnectionId(old);
  assertBoundBotCustomSelectionOpaqueIds(legacy, createBotCapabilityOpaqueIdMint(key));
  const current = snapshot(composioInventory(true));
  const allowed = binding(current);
  for (const retained of [[old, legacy, allowed], [allowed, legacy, old]]) {
    const migrated = withBotCapabilityTombstones(current, retained);
    const rows = migrated.catalog.connections;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.filter(({ available }) => available).map(({ id }) => id), [allowed.selection.connectionIds[0]]);
    assert.deepEqual(new Set(rows.filter(({ available }) => !available).map(({ id }) => id)), new Set([old.selection.connectionIds[0], legacy.selection.connectionIds[0]]));
    assert.deepEqual(withBotCapabilityTombstones(migrated, retained).catalog, migrated.catalog, "repeated reconciliation retains all old choices without renaming them");
  }
  const collision = structuredClone(old);
  collision.connections[0]!.option.id = allowed.selection.connectionIds[0]!;
  collision.selection.connectionIds = [allowed.selection.connectionIds[0]!];
  assert.throws(() => withBotCapabilityTombstones(current, [collision]), /collision/u);
  assert.equal(current.catalog.connections[0]!.available, true, "failed migration does not mutate the input snapshot");
});

test("ordinary MCP retains legacy identity adoption while accepted Composio service grants stay stable", () => {
  const generic = withLegacyConnectionId(binding());
  const changedInventory = inventory();
  changedInventory.connections[0]!.tools[0]!.inputSchemaFingerprint = digest("updated generic schema");
  const genericCatalog = withBotCapabilityTombstones(snapshot(changedInventory), [generic]);
  assert.equal(genericCatalog.catalog.connections[0]!.id, generic.selection.connectionIds[0]);
  assert.equal(genericCatalog.catalog.connections[0]!.available, true);
  const rebound = bindBotCustomSelection({ selection: generic.selection, catalogRevision: genericCatalog.catalog.revision, snapshot: genericCatalog });
  assert.notEqual(rebound.connections[0]!.exactFingerprint, generic.connections[0]!.exactFingerprint);
  const serviceInventory = composioInventory(true);
  const accepted = binding(snapshot(serviceInventory));
  serviceInventory.connections[0]!.label = "Renamed apps";
  const refreshed = snapshot(serviceInventory);
  const reconciled = reconcileBoundBotCustomSelection(accepted, refreshed);
  assert.equal(reconciled.state, "ready");
  assert.equal(reconciled.catalogSnapshot.catalog.connections.length, 1);
  assert.equal(reconciled.catalogSnapshot.catalog.connections[0]!.id, accepted.selection.connectionIds[0]);
  assert.deepEqual(reconciled.catalogSnapshot.resources.connections[0]!.tools, accepted.connections[0]!.tools);
});

test("a raw tool copying the service descriptor cannot acquire its selection or exact grant identity", () => {
  const copied = composioInventory(true);
  delete copied.connections[0]!.accessIdentity;
  const raw = snapshot(copied);
  const service = snapshot(composioInventory(true));
  assert.deepEqual(raw.resources.connections[0]!.tools, service.resources.connections[0]!.tools);
  assert.notEqual(raw.catalog.connections[0]!.id, service.catalog.connections[0]!.id);
  assert.notEqual(raw.resources.connections[0]!.exactFingerprint, service.resources.connections[0]!.exactFingerprint);
  const retained = binding(raw);
  const reconciled = reconcileBoundBotCustomSelection(retained, service);
  assert.equal(reconciled.state, "drifted");
  assert.equal(reconciled.catalogSnapshot.catalog.connections.find(({ id }) => id === retained.selection.connectionIds[0])!.available, false);
  const invalidMarker = composioInventory(true);
  invalidMarker.connections[0]!.sourceId = "custom-composio";
  assert.throws(() => snapshot(invalidMarker), /host-owned/u);
});

test("provider recipient and skill-content drift keep public ids and fail closed until re-bind", () => {
  const current = snapshot();
  const bound = binding(current);
  const changedInventory = inventory();
  changedInventory.providers[0]!.connectionFingerprint = digest("changed-recipient");
  changedInventory.skills[0]!.contentFingerprint = digest("changed-skill-content");
  const changed = snapshot(changedInventory);
  assert.equal(changed.catalog.providers[0]!.id, current.catalog.providers[0]!.id);
  assert.equal(changed.catalog.skills[0]!.id, current.catalog.skills[0]!.id);
  const reconciled = reconcileBoundBotCustomSelection(bound, changed);
  assert.equal(reconciled.state, "drifted");
  assert.deepEqual(
    reconciled.issues.map(({ group }) => group),
    ["model", "provider", "skill"],
  );
  assert.equal(
    reconciled.catalogSnapshot.catalog.providers.find(
      ({ id }) => id === bound.provider.providerOption.id,
    )?.available,
    true,
  );
  assert.equal(
    reconciled.catalogSnapshot.catalog.skills.find(({ id }) => id === bound.skills[0]!.option.id)
      ?.available,
    true,
  );
  assert.doesNotThrow(() =>
    bindBotCustomSelection({
      selection: bound.selection,
      catalogRevision: changed.catalog.revision,
      snapshot: changed,
    }),
  );
  assert.throws(
    () => assertBoundBotCustomSelectionCurrent(bound, changed),
    BotCapabilityBindingDriftError,
  );
});

test("temporary unavailability preserves an opaque id but still fails closed", () => {
  const current = snapshot();
  const bound = binding(current);
  const unavailableInventory = inventory();
  unavailableInventory.connections[0]!.available = false;
  const unavailable = snapshot(unavailableInventory);
  assert.equal(unavailable.catalog.connections[0]!.id, current.catalog.connections[0]!.id);
  assert.deepEqual(botCustomSelectionDrift(bound, unavailable), [
    {
      group: "connection",
      selectionId: bound.selection.connectionIds[0],
      reason: "unavailable",
    },
  ]);
});

test("tampered bindings fail before tombstone projection or validation", () => {
  const current = snapshot();
  const tampered = structuredClone(binding(current));
  tampered.selection.skillIds = [];
  assert.throws(
    () => withBotCapabilityTombstones(current, [tampered]),
    /does not match its public selection/u,
  );

  const tamperedFingerprint = structuredClone(binding(current));
  tamperedFingerprint.skills[0]!.contentFingerprint = "not-a-digest";
  assert.throws(
    () => botCustomSelectionDrift(tamperedFingerprint, current),
    /exact SHA-256 digest/u,
  );

  assert.throws(
    () =>
      bindBotCustomSelection({
        selection: fullSelection(current),
        catalogRevision: "stale_catalog_revision",
        snapshot: current,
      }),
    /choices changed/u,
  );
});

test("strict private binding reload preserves identity-stable ids across fingerprint churn", () => {
  const beforeRestart = snapshot();
  const persistedJson = JSON.stringify(binding(beforeRestart));
  assert.equal(persistedJson.includes("/Users/"), false);
  const afterRestart = parseBoundBotCustomSelection(JSON.parse(persistedJson) as unknown);
  assert.deepEqual(afterRestart, binding(beforeRestart));
  assert.doesNotThrow(() =>
    assertBoundBotCustomSelectionOpaqueIds(
      afterRestart,
      createBotCapabilityOpaqueIdMint(Buffer.from(key)),
    ),
  );

  const driftedInventory = inventory();
  driftedInventory.skills[0]!.contentFingerprint = digest("skill-content-after-restart");
  const afterDrift = snapshot(driftedInventory);
  assert.equal(afterDrift.catalog.skills[0]!.id, afterRestart.selection.skillIds[0]);
  const reconciled = reconcileBoundBotCustomSelection(afterRestart, afterDrift);
  assert.equal(reconciled.state, "drifted");
  assert.equal(
    reconciled.catalogSnapshot.catalog.skills.find(
      ({ id }) => id === afterRestart.selection.skillIds[0],
    )?.available,
    true,
  );
  assert.throws(
    () => assertBoundBotCustomSelectionCurrent(afterRestart, afterDrift),
    BotCapabilityBindingDriftError,
  );
  assert.doesNotThrow(() =>
    bindBotCustomSelection({
      selection: afterRestart.selection,
      catalogRevision: afterDrift.catalog.revision,
      snapshot: afterDrift,
    }),
  );
});

test("legacy v1 opaque ids still verify after identity-stable minting", () => {
  const current = snapshot();
  const bound = binding(current);
  const skill = bound.skills[0]!;
  const legacySkillId = mintLegacyBotCapabilityOpaqueId(
    key,
    "skill",
    skill.sourceId,
    skill.exactFingerprint,
  );
  const stored = structuredClone(bound);
  stored.skills[0] = { ...skill, option: { ...skill.option, id: legacySkillId } };
  stored.selection = { ...bound.selection, skillIds: [legacySkillId] };
  const parsed = parseBoundBotCustomSelection(stored);
  assert.doesNotThrow(() =>
    assertBoundBotCustomSelectionOpaqueIds(parsed, createBotCapabilityOpaqueIdMint(key)),
  );
});

test("removed sources keep unavailable tombstones with the stored public id", () => {
  const current = snapshot();
  const bound = binding(current);
  const removedInventory = inventory();
  removedInventory.skills = [];
  const withoutSkill = snapshot(removedInventory);
  const withTombstones = withBotCapabilityTombstones(withoutSkill, [bound]);
  const option = withTombstones.catalog.skills.find(
    ({ id }) => id === bound.selection.skillIds[0],
  );
  assert.equal(option?.available, false);
  assert.deepEqual(botCustomSelectionDrift(bound, withoutSkill), [
    {
      group: "skill",
      selectionId: bound.selection.skillIds[0],
      reason: "changed_or_removed",
    },
  ]);
});

test("legacy provider bindings without image metadata do not drift after capability discovery", () => {
  const source = inventory();
  source.providers[0]!.models[0]!.supportsImages = true;
  const current = snapshot(source);
  const serialized = structuredClone(binding(current).provider) as ReturnType<
    typeof parseBoundBotProviderModel
  >;
  delete serialized.modelOption.supportsImages;

  const legacy = parseBoundBotProviderModel(serialized);
  assert.equal(legacy.modelOption.supportsImages, undefined);
  assert.deepEqual(botProviderModelDrift(legacy, current), []);
});

test("strict private binding parser rejects extras, derived-fact tampering, unsafe labels, and forged opaque ids", () => {
  const current = snapshot();
  const extra = structuredClone(binding(current)) as unknown as {
    provider: Record<string, unknown>;
  };
  extra.provider.path = "/Users/alice/private";
  assert.throws(() => parseBoundBotCustomSelection(extra), /unsafe or unexpected field/u);

  const effect = structuredClone(binding(current));
  effect.connections[0]!.tools[0]!.effect = "read";
  assert.throws(
    () => parseBoundBotCustomSelection(effect),
    /does not match its exact private facts/u,
  );

  const unsafeLabel = structuredClone(binding(current));
  unsafeLabel.skills[0]!.option.label = "/Users/alice/private/SKILL.md";
  assert.throws(() => parseBoundBotCustomSelection(unsafeLabel), /cannot be projected safely/u);

  const forgedId = structuredClone(binding(current));
  forgedId.skills[0]!.option.id = "bc_skill_forged";
  forgedId.selection.skillIds = ["bc_skill_forged"];
  const coherentlyForged = parseBoundBotCustomSelection(forgedId);
  assert.throws(
    () =>
      assertBoundBotCustomSelectionOpaqueIds(
        coherentlyForged,
        createBotCapabilityOpaqueIdMint(key),
      ),
    /opaque ids do not match/u,
  );

  const sparseSelection = structuredClone(binding(current));
  sparseSelection.selection.skillIds = new Array(1);
  assert.throws(() => parseBoundBotCustomSelection(sparseSelection), /sparse or unsafe entry/u);

  const undefinedShell = structuredClone(binding(current)) as BoundBotCustomSelection & {
    shell: undefined;
  };
  undefinedShell.shell = undefined;
  assert.throws(() => parseBoundBotCustomSelection(undefinedShell), /must be plain private data/u);
});

function mainPorts(state: {
  inventory: BotCapabilityInventory;
  keyLoads: number;
  noticeLoads: string[];
}): BotCapabilityInventoryPorts {
  return {
    async loadOpaqueSelectionKey() {
      state.keyLoads += 1;
      return Buffer.from(key);
    },
    async loadNoticeStatus(audienceId) {
      state.noticeLoads.push(audienceId);
      return audienceId === "device_b"
        ? {
            version: "bot-full-access-v1",
            requiresAcknowledgement: false,
            acceptedAt: "2026-08-23T15:00:00.000Z",
            acceptedDecision: "continue_full",
          }
        : notice;
    },
    async listProviders() {
      return state.inventory.providers;
    },
    async inspectMacFiles() {
      const fullMac = state.inventory.fileScopes.find(({ kind }) => kind === "full_mac")!;
      const botHome = state.inventory.fileScopes.find(({ kind }) => kind === "bot_home")!;
      return {
        fullMac: {
          available: fullMac.available,
          scopeFingerprint: fullMac.scopeFingerprint,
        },
        botHome: {
          available: botHome.available,
          scopeFingerprint: botHome.scopeFingerprint,
        },
        approvedLocations: state.inventory.fileScopes
          .filter(({ kind }) => kind === "approved_location")
          .map(({ sourceId, label, description, available, scopeFingerprint }) => ({
            sourceId,
            label,
            ...(description === undefined ? {} : { description }),
            available,
            scopeFingerprint,
          })),
      };
    },
    async inspectShell() {
      return state.inventory.shell;
    },
    async inspectConnections() {
      return state.inventory.connections;
    },
    async inspectSkills() {
      return state.inventory.skills;
    },
    async inspectOtherCapabilities() {
      return state.inventory.otherCapabilities;
    },
  };
}

test("main catalog service uses injected inventories, stable persisted key, and explicit Mac file modes", async () => {
  const state = { inventory: inventory(), keyLoads: 0, noticeLoads: [] as string[] };
  const service = new BotCapabilityCatalogMainService(mainPorts(state));
  const first = await service.snapshot({ audienceId: "device_a" });
  const second = await service.snapshot({ audienceId: "device_a" });
  assert.equal(state.keyLoads, 1);
  assert.deepEqual(state.noticeLoads, ["device_a", "device_a"]);
  assert.equal(second.catalog.revision, first.catalog.revision);
  assert.deepEqual(
    first.catalog.fileScopes.slice(0, 2).map(({ kind, label }) => ({ kind, label })),
    [
      { kind: "full_mac", label: "Full Mac" },
      { kind: "bot_home", label: "Bot folder" },
    ],
  );
  const bound = await service.bindCustom({
    audienceId: "device_a",
    selection: fullSelection(first),
    catalogRevision: first.catalog.revision,
  });
  await assert.doesNotReject(service.assertCurrent(bound, { mode: "runtime", botId: "bot:one" }));

  const forged = structuredClone(bound);
  forged.skills[0]!.option.id = "bc_skill_forged";
  forged.selection.skillIds = ["bc_skill_forged"];
  await assert.rejects(
    service.assertCurrent(parseBoundBotCustomSelection(forged), {
      mode: "runtime",
      botId: "bot:one",
    }),
    /opaque ids do not match/u,
  );

  const sourceCollision = structuredClone(first);
  sourceCollision.resources.skills[0]!.sourceId = "different-private-skill";
  assert.equal(botCustomSelectionDrift(bound, sourceCollision)[0]?.group, "skill");

  state.inventory.connections[0]!.tools[0]!.effectFingerprint = digest("changed-effect");
  const reconciled = await service.reconcile(bound, {
    audienceId: "device_a",
    botId: "bot:one",
  });
  assert.equal(reconciled.state, "drifted");
  assert.equal(reconciled.issues[0]?.group, "connection");
  assert.equal(reconciled.selection.connectionIds[0], bound.selection.connectionIds[0]);
  const refreshed = await service.snapshot({ audienceId: "device_a" });
  assert.equal(refreshed.catalog.connections[0]!.id, first.catalog.connections[0]!.id);
  await assert.doesNotReject(
    service.bindCustom({
      audienceId: "device_a",
      selection: bound.selection,
      catalogRevision: refreshed.catalog.revision,
    }),
  );
});

test("main catalog service honors cancellation without app globals", async () => {
  const state = { inventory: inventory(), keyLoads: 0, noticeLoads: [] as string[] };
  const service = new BotCapabilityCatalogMainService(mainPorts(state));
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(
    service.snapshot({ audienceId: "device_a", signal: controller.signal }),
    /cancelled by test/u,
  );
  assert.equal(state.keyLoads, 0);
  assert.deepEqual(state.noticeLoads, []);
});

test("main catalog service isolates notice state by paired audience", async () => {
  const state = { inventory: inventory(), keyLoads: 0, noticeLoads: [] as string[] };
  const service = new BotCapabilityCatalogMainService(mainPorts(state));
  const pending = await service.snapshot({ audienceId: "device_a" });
  const accepted = await service.snapshot({ audienceId: "device_b" });
  assert.deepEqual(pending.catalog.notice, notice);
  assert.deepEqual(accepted.catalog.notice, {
    version: "bot-full-access-v1",
    requiresAcknowledgement: false,
    acceptedAt: "2026-08-23T15:00:00.000Z",
    acceptedDecision: "continue_full",
  });
  assert.equal(pending.catalog.revision, accepted.catalog.revision);
  assert.deepEqual(state.noticeLoads, ["device_a", "device_b"]);

  const beforeRuntimeLoads = state.noticeLoads.length;
  const runtime = await service.snapshotForRuntime();
  assert.equal(runtime.catalog.revision, pending.catalog.revision);
  assert.equal(state.noticeLoads.length, beforeRuntimeLoads);

  await assert.rejects(
    service.snapshot({ audienceId: "../../another-device" }),
    /valid paired-device audience/u,
  );
  assert.deepEqual(state.noticeLoads, ["device_a", "device_b"]);
});
