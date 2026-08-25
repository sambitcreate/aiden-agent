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
  botCustomSelectionDrift,
  boundBotCustomSelectionFingerprint,
  createBotCapabilityOpaqueIdMint,
  parseBoundBotCustomSelection,
  reconcileBoundBotCustomSelection,
  withBotCapabilityTombstones,
  type BoundBotCustomSelection,
} from "./bot-capability-bindings.js";
import {
  BotCapabilityCatalogMainService,
  type BotCapabilityInventoryPorts,
} from "./bot-capability-catalog-main.js";

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

test("opaque ids are stable across restart keys and do not reveal source identity", () => {
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
  assert.equal(restarted, first);
  assert.notEqual(changedKey, first);
  assert.notEqual(changedFacts, first);
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

test("MCP schema/effect drift disables the old exact grant and creates an unavailable tombstone", () => {
  const current = snapshot();
  const bound = binding(current);
  const changedInventory = inventory();
  changedInventory.connections[0]!.tools[0]!.inputSchemaFingerprint =
    digest("changed-input-schema");
  const changed = snapshot(changedInventory);
  const result = reconcileBoundBotCustomSelection(bound, changed);
  assert.equal(result.state, "drifted");
  assert.deepEqual(result.issues, [
    {
      group: "connection",
      selectionId: bound.selection.connectionIds[0],
      reason: "changed_or_removed",
    },
  ]);
  const oldOption = result.catalogSnapshot.catalog.connections.find(
    ({ id }) => id === bound.selection.connectionIds[0],
  );
  const newOption = result.catalogSnapshot.catalog.connections.find(
    ({ id }) => id === changed.catalog.connections[0]!.id,
  );
  assert.equal(oldOption?.available, false);
  assert.equal(newOption?.available, true);
  assert.doesNotThrow(() =>
    validateSelectionAgainstCatalog(bound.selection, result.catalogSnapshot.catalog, {
      requireAvailable: false,
    }),
  );
  assert.throws(() =>
    validateSelectionAgainstCatalog(bound.selection, result.catalogSnapshot.catalog),
  );
  const publicJson = JSON.stringify(result.catalogSnapshot.catalog);
  assert.equal(publicJson.includes("private-connection-id"), false);
  assert.equal(publicJson.includes("calendar_events"), false);
  assert.equal(publicJson.includes("Fingerprint"), false);
});

test("provider recipient and skill-content drift both mint new ids and retain safe old tombstones", () => {
  const current = snapshot();
  const bound = binding(current);
  const changedInventory = inventory();
  changedInventory.providers[0]!.connectionFingerprint = digest("changed-recipient");
  changedInventory.skills[0]!.contentFingerprint = digest("changed-skill-content");
  const changed = snapshot(changedInventory);
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
    false,
  );
  assert.equal(
    reconciled.catalogSnapshot.catalog.skills.find(({ id }) => id === bound.skills[0]!.option.id)
      ?.available,
    false,
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

test("strict private binding reload preserves exact drift tombstones across restart", () => {
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
  const reconciled = reconcileBoundBotCustomSelection(afterRestart, afterDrift);
  assert.equal(reconciled.state, "drifted");
  assert.equal(
    reconciled.catalogSnapshot.catalog.skills.find(
      ({ id }) => id === afterRestart.selection.skillIds[0],
    )?.available,
    false,
  );
  assert.equal(
    reconciled.catalogSnapshot.catalog.skills.find(
      ({ id }) => id === afterDrift.catalog.skills[0]!.id,
    )?.available,
    true,
  );
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
