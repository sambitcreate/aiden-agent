import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import type { BotCustomSelection } from "../../renderer/shared/bot-capabilities.js";
import { bindBotCustomSelection, type BoundBotCustomSelection } from "./bot-capability-bindings.js";
import {
  buildBotCapabilityCatalogSnapshot,
  type BotCapabilityCatalogSnapshot,
  type BotCapabilityInventory,
} from "./bot-capability-catalog-core.js";
import type { BotCapabilityAuthorityLease } from "./bot-capability-lease.js";
import { BotRuntimeInventoryLeaseRegistry } from "./bot-runtime-inventory-lease.js";
import type { BotCapabilityAdmission } from "./bot-capability-store.js";
import type {
  StoredBotCapabilityPolicy,
  StoredBotChatCapabilityPolicy,
} from "./bot-capability-store-core.js";
import { BotCapabilityNoticeRequiredError } from "./bot-capability-store-core.js";
import {
  BOT_RUNTIME_AUTHORITY_FAILURE_MESSAGES,
  assertBotRuntimeProviderSelection,
  BotRuntimeAuthorityError,
  createBotRuntimeAuthorityResolver,
  type BotRuntimeAuthorityDependencies,
} from "./bot-runtime-authority.js";
import type { BotManagedWorkspaceResolution } from "./bot-managed-workspace-core.js";
import type { Chat } from "./types.js";

const fp = (value: string) => createHash("sha256").update(value).digest("hex");
const mint = (namespace: string, source: string, exact: string) =>
  `bc_${namespace}_${fp(`${source}:${exact}`).slice(0, 32)}`;

test("provider selection must match the protected runtime pair exactly", () => {
  const authority = { sourceProviderId: "provider-a", sourceModelId: "model-a" };
  assert.doesNotThrow(() => assertBotRuntimeProviderSelection(authority, {
    providerId: "provider-a",
    model: "model-a",
  }));
  assert.throws(
    () => assertBotRuntimeProviderSelection(authority, {
      providerId: "provider-b",
      model: "model-a",
    }),
    (error: unknown) =>
      error instanceof BotRuntimeAuthorityError && error.classification === "provider_mismatch",
  );
  assert.throws(
    () => assertBotRuntimeProviderSelection(authority, {
      providerId: "provider-a",
      model: "model-b",
    }),
    (error: unknown) =>
      error instanceof BotRuntimeAuthorityError && error.classification === "provider_mismatch",
  );
});

function inventory(suffix = "v1"): BotCapabilityInventory {
  return {
    providers: [
      {
        sourceId: "provider-a",
        label: "Provider A",
        available: true,
        connectionFingerprint: fp(`provider:${suffix}`),
        models: [
          {
            sourceId: "model-a",
            label: "Model A",
            available: true,
            modelFingerprint: fp(`model:${suffix}`),
          },
        ],
      },
      {
        sourceId: "provider-off",
        label: "Provider Off",
        available: false,
        connectionFingerprint: fp("provider-off"),
        models: [
          {
            sourceId: "model-off",
            label: "Model Off",
            available: false,
            modelFingerprint: fp("model-off"),
          },
        ],
      },
    ],
    fileScopes: [
      {
        sourceId: "full-mac",
        label: "Full Mac",
        available: true,
        kind: "full_mac",
        scopeFingerprint: fp(`full:${suffix}`),
      },
      {
        sourceId: "bot-home",
        label: "Bot Home",
        available: true,
        kind: "bot_home",
        scopeFingerprint: fp(`home:${suffix}`),
      },
      {
        sourceId: "approved-a",
        label: "Approved A",
        available: true,
        kind: "approved_location",
        scopeFingerprint: fp(`approved:${suffix}`),
      },
    ],
    shell: { available: true, shellFingerprint: fp(`shell:${suffix}`) },
    connections: [
      {
        sourceId: "mcp-a",
        label: "MCP A",
        available: true,
        connectionFingerprint: fp(`mcp:${suffix}`),
        tools: [
          {
            name: "read_item",
            inputSchemaFingerprint: fp(`input:${suffix}`),
            outputSchemaFingerprint: fp(`output:${suffix}`),
            effect: "read",
            effectFingerprint: fp("read"),
          },
          {
            name: "write_item",
            inputSchemaFingerprint: fp(`input-write:${suffix}`),
            outputSchemaFingerprint: fp(`output-write:${suffix}`),
            effect: "mutating",
            effectFingerprint: fp("mutating"),
          },
        ],
      },
      {
        sourceId: "mcp-off",
        label: "MCP Off",
        available: false,
        connectionFingerprint: fp("mcp-off"),
        tools: [
          {
            name: "off_tool",
            inputSchemaFingerprint: fp("off-input"),
            outputSchemaFingerprint: fp("off-output"),
            effect: "mutating",
            effectFingerprint: fp("off-effect"),
          },
        ],
      },
    ],
    skills: [
      {
        sourceId: "skill-a",
        label: "Skill A",
        available: true,
        identityFingerprint: fp("skill-id"),
        contentFingerprint: fp(`skill-content:${suffix}`),
      },
      {
        sourceId: "skill-off",
        label: "Skill Off",
        available: false,
        identityFingerprint: fp("skill-off-id"),
        contentFingerprint: fp("skill-off-content"),
      },
    ],
    otherCapabilities: [
      {
        kind: "web",
        label: "Web",
        available: true,
        capabilityFingerprint: fp(`web:${suffix}`),
      },
      {
        kind: "browser",
        label: "Browser",
        available: false,
        capabilityFingerprint: fp("browser-off"),
      },
    ],
  };
}

function snapshot(suffix = "v1"): BotCapabilityCatalogSnapshot {
  return buildBotCapabilityCatalogSnapshot({
    inventory: inventory(suffix),
    notice: {
      version: "bot-full-access-v1",
      requiresAcknowledgement: false,
      acceptedAt: "2026-08-23T00:00:00.000Z",
      acceptedDecision: "continue_full",
    },
    mintOpaqueId: mint,
  });
}

function selection(current: BotCapabilityCatalogSnapshot, input: {
  connection?: boolean;
  skill?: boolean;
  other?: boolean;
  shell?: boolean;
  approved?: boolean;
  fullMac?: boolean;
} = {}): BotCustomSelection {
  const provider = current.catalog.providers.find(({ available }) => available)!;
  const home = current.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!;
  const approved = current.catalog.fileScopes.find(({ kind }) => kind === "approved_location")!;
  const fullMac = current.catalog.fileScopes.find(({ kind }) => kind === "full_mac")!;
  return {
    providerId: provider.id,
    modelId: provider.models.find(({ available }) => available)!.id,
    fileScopeIds: input.fullMac
      ? [fullMac.id]
      : [home.id, ...(input.approved ? [approved.id] : [])],
    shellEnabled: input.shell ?? false,
    connectionIds: input.connection
      ? [current.catalog.connections.find(({ available }) => available)!.id]
      : [],
    skillIds: input.skill
      ? [current.catalog.skills.find(({ available }) => available)!.id]
      : [],
    otherCapabilityIds: input.other
      ? [current.catalog.otherCapabilities.find(({ available }) => available)!.id]
      : [],
  };
}

function bot(archived = false): BotDefinition {
  return {
    id: "bot-a",
    revision: "bot-rev-1",
    name: "Bot A",
    instructions: "Help.",
    avatar: "spark",
    createdAt: 1,
    updatedAt: 1,
    ...(archived ? { archivedAt: 2 } : {}),
  };
}

function chat(providerId = "provider-a", model = "model-a"): Chat {
  return {
    id: "chat-a",
    title: "Chat",
    botId: "bot-a",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    providerId,
    model,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
}

function policy(binding?: BoundBotCustomSelection): StoredBotCapabilityPolicy {
  const base = {
    botId: "bot-a",
    authorityStatus: "active" as const,
    catalogRevision: binding?.catalogRevision ?? "full-catalog",
    policyEpoch: 1,
    revision: "bot-policy-1",
    revisionSequence: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  return binding
    ? { ...base, accessMode: "custom", custom: binding.selection, binding }
    : { ...base, accessMode: "full" };
}

function chatPolicy(custom?: BotCustomSelection): StoredBotChatCapabilityPolicy {
  const base = {
    chatId: "chat-a",
    botId: "bot-a",
    catalogRevision: "chat-catalog",
    policyEpoch: 1,
    revision: "chat-policy-1",
    revisionSequence: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  return custom ? { ...base, mode: "custom", custom } : { ...base, mode: "inherit" };
}

function workspace(): BotManagedWorkspaceResolution {
  return {
    botId: "bot-a",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    createdAt: 1,
    homePath: "/private/aiden/bots/home-a",
    incarnation: { device: "1", inode: "2" },
  };
}

function fixture(input: {
  customBot?: boolean;
  customFullMac?: boolean;
  chatCustom?: BotCustomSelection;
  currentSnapshot?: BotCapabilityCatalogSnapshot;
  chatWorkspaceId?: string;
} = {}) {
  const inventoryLeases = new BotRuntimeInventoryLeaseRegistry();
  let currentSnapshot = input.currentSnapshot ?? snapshot();
  const botBinding = input.customBot
    ? bindBotCustomSelection({
        selection: selection(currentSnapshot, {
          connection: true,
          skill: true,
          other: true,
          shell: true,
          approved: true,
          fullMac: input.customFullMac,
        }),
        catalogRevision: currentSnapshot.catalog.revision,
        snapshot: currentSnapshot,
      })
    : undefined;
  let currentBot = bot();
  let currentChat = {
    ...chat(),
    ...(input.chatWorkspaceId ? { workspaceId: input.chatWorkspaceId } : {}),
  };
  let currentPolicy = policy(botBinding);
  let currentChatPolicy = chatPolicy(input.chatCustom);
  let leaseValid = true;
  let revalidateHomeError: Error | undefined;
  let homeRevalidations = 0;
  let policyReadHook: (() => Promise<void>) | undefined;
  let admissionError: Error | undefined;
  const lease: BotCapabilityAuthorityLease = {
    audienceId: "device-a",
    botId: "bot-a",
    botPolicyEpoch: 1,
    chatId: "chat-a",
    chatPolicyEpoch: 1,
    signal: new AbortController().signal,
    assertCurrent() {
      if (!leaseValid) throw new Error("invalidated");
    },
    release() {
      leaseValid = false;
    },
  };
  const admission = (): BotCapabilityAdmission => ({
    policy: currentPolicy,
    chat: currentChatPolicy,
    ...(currentChatPolicy.mode === "custom"
      ? { effectiveCustom: currentChatPolicy.custom }
      : currentPolicy.accessMode === "custom"
        ? { effectiveCustom: currentPolicy.custom }
        : {}),
    lease,
  });
  const catalogInputs: Array<{
    retainedProviders?: readonly { sourceProviderId: string; sourceModelId: string }[];
  }> = [];
  const deps: BotRuntimeAuthorityDependencies = {
    botStore: { async get() { return currentBot; } },
    chatStore: { async get() { return currentChat; } },
    capabilityStore: {
      async getBotBinding() { return botBinding; },
      async admit() {
        if (admissionError) throw admissionError;
        return admission();
      },
      async getBotPolicy() {
        await policyReadHook?.();
        return {
          botId: currentPolicy.botId,
          revision: currentPolicy.revision,
          policyEpoch: `epoch:${currentPolicy.policyEpoch}`,
          summary: "summary",
          ...(currentPolicy.accessMode === "full"
            ? { accessMode: "full" as const }
            : { accessMode: "custom" as const, custom: currentPolicy.custom }),
        };
      },
      async getChatPolicy() {
        return {
          chatId: currentChatPolicy.chatId,
          botId: currentChatPolicy.botId,
          revision: currentChatPolicy.revision,
          botPolicyRevision: currentPolicy.revision,
          summary: "summary",
          ...(currentChatPolicy.mode === "inherit"
            ? { mode: "inherit" as const }
            : { mode: "custom" as const, custom: currentChatPolicy.custom }),
        };
      },
      async assertAuthorityBindingsCurrent() { return undefined; },
    },
    catalog: {
      async snapshotForRuntime(input) {
        catalogInputs.push(input ?? {});
        return currentSnapshot;
      },
    },
    managedWorkspace: {
      async resolve() { return workspace(); },
      async revalidate() {
        homeRevalidations += 1;
        if (revalidateHomeError) throw revalidateHomeError;
        return workspace();
      },
    },
    inventoryLeases,
  };
  return {
    resolver: createBotRuntimeAuthorityResolver(deps),
    setSnapshot(value: BotCapabilityCatalogSnapshot) { currentSnapshot = value; },
    invalidateLease() { leaseValid = false; },
    archive() { currentBot = bot(true); },
    replaceHome() { revalidateHomeError = new Error("home replaced"); },
    mismatchProvider() { currentChat = chat("provider-other", "model-other"); },
    narrowPolicy() {
      currentPolicy = { ...currentPolicy, revision: "bot-policy-2", policyEpoch: 2 };
      leaseValid = false;
    },
    setPolicyReadHook(value: () => Promise<void>) { policyReadHook = value; },
    requireNotice() { admissionError = new BotCapabilityNoticeRequiredError(); },
    invalidateInventory() { inventoryLeases.invalidate("settings"); },
    get activeInventoryLeases() { return inventoryLeases.activeCount(); },
    get homeRevalidations() { return homeRevalidations; },
    get catalogInputs() { return catalogInputs; },
  };
}

async function expectFailure(
  operation: Promise<unknown>,
  classification: BotRuntimeAuthorityError["classification"],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BotRuntimeAuthorityError);
    assert.equal(error.classification, classification);
    assert.equal(error.message, BOT_RUNTIME_AUTHORITY_FAILURE_MESSAGES[classification]);
    return true;
  });
}

test("Full authority contains only currently available exact resources", async () => {
  const app = fixture();
  const admitted = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  const { authority } = admitted;
  assert.equal(authority.accessMode, "full");
  assert.equal(authority.files.mode, "full_mac");
  assert.equal(authority.files.botHome, true);
  assert.equal(authority.shell.enabled, true);
  assert.deepEqual(authority.connections.map(({ sourceId }) => sourceId), ["mcp-a"]);
  assert.deepEqual(authority.connections[0]!.tools.map(({ effect }) => effect), ["read", "mutating"]);
  assert.deepEqual(authority.skills.map(({ sourceId }) => sourceId), ["skill-a"]);
  assert.deepEqual(authority.otherCapabilities.map(({ kind }) => kind), ["web"]);
  assert.ok(Object.isFrozen(authority));
  assert.ok(Object.isFrozen(authority.connections));
  assert.ok(Object.isFrozen(authority.connections[0]!.tools));
  assert.deepEqual(app.catalogInputs[0]?.retainedProviders, [{
    sourceProviderId: "provider-a",
    sourceModelId: "model-a",
  }]);
});

test("legacy chats retain visible workspace identity but receive the managed home", async () => {
  const app = fixture({ chatWorkspaceId: "legacy-visible-workspace" });
  const admission = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  const { authority } = admission;
  assert.equal(authority.managedHome.workspaceId, workspace().workspaceId);
  assert.equal(authority.workingDirectory, workspace().homePath);
  await admission.revalidateBeforeEffect();
  assert.deepEqual(app.catalogInputs[1]?.retainedProviders, [{
    sourceProviderId: "provider-a",
    sourceModelId: "model-a",
  }]);
});

test("a Custom chat reduction intersects the Bot ceiling and retains exact tool effects", async () => {
  const current = snapshot();
  const reduced = selection(current, { connection: true });
  const app = fixture({ customBot: true, chatCustom: reduced, currentSnapshot: current });
  const { authority } = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  assert.equal(authority.accessMode, "custom");
  assert.equal(authority.shell.enabled, false);
  assert.deepEqual(authority.skills, []);
  assert.deepEqual(authority.otherCapabilities, []);
  assert.equal(authority.connections.length, 1);
  assert.deepEqual(authority.connections[0]!.tools.map(({ effect }) => effect), ["read", "mutating"]);
  assert.equal(authority.files.mode, "scoped");
  assert.equal(authority.files.botHome, true);
});

test("Custom shell remains independently enabled when Files is narrower than Full Mac", async () => {
  const app = fixture({ customBot: true });
  const { authority } = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  assert.equal(authority.files.mode, "scoped");
  assert.equal(authority.shell.enabled, true);
  assert.equal("shellFingerprint" in authority.shell, true);
});

test("Custom Full Mac retains the managed home as its default file authority", async () => {
  const app = fixture({ customBot: true, customFullMac: true });
  const { authority } = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  assert.equal(authority.files.mode, "full_mac");
  assert.equal(authority.files.botHome, true);
  assert.equal(authority.workingDirectory, workspace().homePath);
});

test("provider/model binding never falls back", async () => {
  const app = fixture();
  app.mismatchProvider();
  await expectFailure(
    app.resolver.admit({ audienceId: "device-a", botId: "bot-a", chatId: "chat-a" }),
    "provider_mismatch",
  );
});

test("the sole store admission gate prevents Full authority before audience notice acceptance", async () => {
  const app = fixture();
  app.requireNotice();
  await expectFailure(
    app.resolver.admit({ audienceId: "device-a", botId: "bot-a", chatId: "chat-a" }),
    "access_unavailable",
  );
});

test("fresh inventory changes invalidate an admitted effect lease", async () => {
  const app = fixture();
  const admitted = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  app.setSnapshot(snapshot("v2"));
  await expectFailure(admitted.revalidateBeforeEffect(), "capability_changed");
});

test("a global capability mutation aborts an active admission and cleans up its inventory lease", async () => {
  const app = fixture();
  const admitted = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  assert.equal(app.activeInventoryLeases, 1);

  app.invalidateInventory();

  assert.equal(admitted.signal.aborted, true);
  assert.equal(app.activeInventoryLeases, 0);
  await expectFailure(admitted.revalidateBeforeEffect(), "capability_changed");
  admitted.release();
  assert.equal(app.activeInventoryLeases, 0);
});

test("failed runtime admission releases its inventory lease", async () => {
  const app = fixture();
  app.requireNotice();
  await expectFailure(
    app.resolver.admit({ audienceId: "device-a", botId: "bot-a", chatId: "chat-a" }),
    "access_unavailable",
  );
  assert.equal(app.activeInventoryLeases, 0);
});

test("Custom binding drift fails closed before an authority can be assembled", async () => {
  const app = fixture({ customBot: true });
  app.setSnapshot(snapshot("v2"));
  await expectFailure(
    app.resolver.admit({ audienceId: "device-a", botId: "bot-a", chatId: "chat-a" }),
    "capability_changed",
  );
});

test("active narrowing and archive fail closed before the next effect", async () => {
  const narrowed = fixture();
  const narrowingAdmission = await narrowed.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  narrowed.narrowPolicy();
  await expectFailure(narrowingAdmission.revalidateBeforeEffect(), "capability_changed");

  const archived = fixture();
  const archiveAdmission = await archived.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  archived.archive();
  await expectFailure(archiveAdmission.revalidateBeforeEffect(), "bot_unavailable");
});

test("a concurrent narrowing that races policy reads is caught by the final lease fence", async () => {
  const app = fixture();
  const admitted = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  let releaseRead!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
  let reachedRead!: () => void;
  const reached = new Promise<void>((resolve) => { reachedRead = resolve; });
  app.setPolicyReadHook(async () => {
    reachedRead();
    await blocked;
  });
  const revalidation = admitted.revalidateBeforeEffect();
  await reached;
  app.invalidateLease();
  releaseRead();
  await expectFailure(revalidation, "capability_changed");
});

test("managed-home replacement uses the immediate revalidation seam", async () => {
  const app = fixture();
  const admitted = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  app.replaceHome();
  await expectFailure(admitted.revalidateBeforeEffect(), "managed_home_changed");
  assert.equal(app.homeRevalidations, 1);
});

test("release is idempotent and permanently closes effect admission", async () => {
  const app = fixture();
  const admitted = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  admitted.release();
  admitted.release();
  await expectFailure(admitted.revalidateBeforeEffect(), "capability_changed");
});

test("the exact authority has no catalog, stored binding, notice, or display-label projection", async () => {
  const app = fixture({ customBot: true });
  const admitted = await app.resolver.admit({
    audienceId: "device-a",
    botId: "bot-a",
    chatId: "chat-a",
  });
  const serialized = JSON.stringify(admitted.authority);
  for (const forbidden of [
    "resources",
    "binding",
    "notice",
    "Provider A",
    "MCP A",
    "Skill A",
    "Full Mac",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
