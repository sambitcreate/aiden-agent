import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOT_FULL_ACCESS_NOTICE_VERSION,
  type BotCapabilityCatalog,
  type BotCustomSelection,
} from "../../renderer/shared/bot-capabilities.js";
import {
  BotCapabilityNoticeRequiredError,
  BotCapabilityRevisionConflictError,
  BotCapabilityUnavailableError,
} from "./bot-capability-store-core.js";
import {
  bindBotCustomSelection,
  BotCapabilityBindingDriftError,
  createBotCapabilityOpaqueIdMint,
} from "./bot-capability-bindings.js";
import {
  buildBotCapabilityCatalogSnapshot,
  type BotCapabilityInventory,
} from "./bot-capability-catalog-core.js";
import { BotCapabilityLeaseRegistry } from "./bot-capability-lease.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";

const filename = "bot-capabilities.json";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const opaqueKey = Buffer.alloc(32, 9);

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
      }],
    }],
    fileScopes: [
      {
        sourceId: "private-full",
        label: "Full Mac",
        available: true,
        kind: "full_mac",
        scopeFingerprint: digest("full"),
      },
      {
        sourceId: "private-home",
        label: "Bot folder",
        available: true,
        kind: "bot_home",
        scopeFingerprint: digest("home"),
      },
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
    otherCapabilities: [{
      kind: "web",
      label: "Web",
      available: true,
      capabilityFingerprint: digest("capability-web"),
    }],
  };
}

function snapshotFor(source: BotCapabilityInventory = inventory()) {
  return buildBotCapabilityCatalogSnapshot({
    inventory: source,
    notice: { version: BOT_FULL_ACCESS_NOTICE_VERSION, requiresAcknowledgement: true },
    mintOpaqueId: createBotCapabilityOpaqueIdMint(opaqueKey),
  });
}

const snapshot = snapshotFor();
const catalogRevision = snapshot.catalog.revision;

function catalog(revision = catalogRevision): BotCapabilityCatalog {
  return { ...structuredClone(snapshot.catalog), revision };
}

function selection(overrides: Partial<BotCustomSelection> = {}): BotCustomSelection {
  return {
    providerId: snapshot.catalog.providers[0]!.id,
    modelId: snapshot.catalog.providers[0]!.models[0]!.id,
    fileScopeIds: [snapshot.catalog.fileScopes.find(({ kind }) => kind === "bot_home")!.id],
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

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiden-bot-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function storeAt(root: string, leases = new BotCapabilityLeaseRegistry()) {
  let timestamp = 10_000;
  let incarnation = 0;
  return {
    leases,
    store: createBotCapabilityStore({
      root: () => root,
      leases,
      now: () => ++timestamp,
      mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
      mintIncarnation: () => Buffer.alloc(32, ++incarnation).toString("base64url"),
    }),
  };
}

const acknowledgement = (decision: "continue_full" | "customize_first" = "continue_full") => ({
  version: BOT_FULL_ACCESS_NOTICE_VERSION,
  decision,
  confirmedForeground: true as const,
});

test("durable policy and per-device notice state survive restart with private 0600 semantics", async (t) => {
  const root = await temporaryRoot(t);
  const first = storeAt(root);
  await first.store.initialize();
  assert.equal((await stat(join(root, filename))).mode & 0o777, 0o600);

  const policy = await first.store.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  assert.equal(policy.accessMode, "full");
  await first.store.acknowledgeNotice("device:a", acknowledgement());
  assert.equal((await first.store.noticeStatus("device:a")).requiresAcknowledgement, false);
  assert.equal((await first.store.noticeStatus("device:b")).requiresAcknowledgement, true);

  await chmod(join(root, filename), 0o644);
  const restarted = storeAt(root);
  await restarted.store.initialize();
  assert.equal((await stat(join(root, filename))).mode & 0o777, 0o600);
  assert.equal((await restarted.store.getBotPolicy("bot:one")).accessMode, "full");
  assert.equal((await restarted.store.noticeStatus("device:a")).requiresAcknowledgement, false);
  assert.equal((await restarted.store.noticeStatus("device:b")).requiresAcknowledgement, true);
  await assert.rejects(
    restarted.store.admit({ audienceId: "device:b", botId: "bot:one" }),
    BotCapabilityNoticeRequiredError,
  );
  const admission = await restarted.store.admit({ audienceId: "device:a", botId: "bot:one" });
  admission.lease.assertCurrent();

  const disk = await readFile(join(root, filename), "utf8");
  assert.doesNotMatch(disk, /fingerprint|credential|\/Users\//u);
});

test("Custom bindings survive restart, stay out of public views, and gate drift before leasing", async (t) => {
  const root = await temporaryRoot(t);
  const first = storeAt(root);
  await first.store.initialize();
  await first.store.acknowledgeNotice("device:a", acknowledgement());
  const custom = selection();
  const view = await first.store.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom },
    binding: binding(custom),
  });
  assert.doesNotMatch(JSON.stringify(view), /binding|sourceId|fingerprint|private-/iu);
  const privateClone = await first.store.getBotBinding("bot:one");
  assert.ok(privateClone);
  privateClone.provider.sourceProviderId = "mutated-return-value";
  const privateCloneAgain = await first.store.getBotBinding("bot:one");
  assert.equal(privateCloneAgain?.provider.sourceProviderId, "private-provider");
  assert.notStrictEqual(privateClone, privateCloneAgain);

  const persisted = await readFile(join(root, filename), "utf8");
  assert.match(persisted, /"binding"/u);
  assert.match(persisted, /"sourceProviderId":\s*"private-provider"/u);
  assert.equal((await stat(join(root, filename))).mode & 0o777, 0o600);

  const restarted = storeAt(root);
  await restarted.store.initialize();
  assert.doesNotMatch(
    JSON.stringify(await restarted.store.getBotPolicy("bot:one")),
    /binding|sourceId|fingerprint|private-/iu,
  );
  await assert.rejects(
    restarted.store.admit({ audienceId: "device:a", botId: "bot:one" }),
    /bindings are required/u,
  );
  const admission = await restarted.store.admit({
    audienceId: "device:a",
    botId: "bot:one",
    snapshot,
  });
  admission.lease.assertCurrent();
  admission.lease.release();

  const changedInventory = inventory();
  changedInventory.skills[0]!.contentFingerprint = digest("changed-skill-content");
  const drifted = snapshotFor(changedInventory);
  await assert.rejects(
    restarted.store.admit({
      audienceId: "device:a",
      botId: "bot:one",
      snapshot: drifted,
    }),
    BotCapabilityBindingDriftError,
  );
  assert.equal(restarted.leases.activeCount("bot:one"), 0);
});

test("missing, future, or corrupt persisted Custom bindings are preserved and fail closed", async (t) => {
  type TestDocument = {
    policies: Array<{ binding?: Record<string, unknown> }>;
  };
  const cases: Array<{
    name: string;
    mutate(document: TestDocument): void;
  }> = [
    {
      name: "missing binding",
      mutate(document) {
        delete document.policies[0]!.binding;
      },
    },
    {
      name: "future binding",
      mutate(document) {
        document.policies[0]!.binding!.version = 99;
      },
    },
    {
      name: "corrupt binding fingerprint",
      mutate(document) {
        const provider = document.policies[0]!.binding!.provider as Record<string, unknown>;
        provider.connectionFingerprint = "0".repeat(64);
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (child) => {
      const root = await temporaryRoot(child);
      const first = storeAt(root);
      await first.store.initialize();
      const custom = selection();
      await first.store.createBotPolicy({
        botId: "bot:one",
        catalog: catalog(),
        access: { accessMode: "custom", catalogRevision, custom },
        binding: binding(custom),
      });
      const path = join(root, filename);
      const document = JSON.parse(await readFile(path, "utf8")) as TestDocument;
      fixture.mutate(document);
      const unsafeContents = JSON.stringify(document);
      await writeFile(path, unsafeContents, "utf8");

      const restarted = storeAt(root);
      await assert.rejects(restarted.store.initialize(), BotCapabilityUnavailableError);
      assert.equal(await readFile(path, "utf8"), unsafeContents);
    });
  }
});

test("corrupt, old, future, and sequence-rollback documents remain preserved and fail closed", async (t) => {
  const cases: Array<{ name: string; contents: string }> = [
    { name: "corrupt", contents: "{not-json" },
    {
      name: "old",
      contents: JSON.stringify({ version: 1, sequence: 0, policies: [], chats: [], notices: [] }),
    },
    {
      name: "future",
      contents: JSON.stringify({ version: 99, sequence: 0, policies: [], chats: [], notices: [] }),
    },
    {
      name: "rollback",
      contents: JSON.stringify({
        version: 3,
        sequence: 0,
        policies: [
          {
            botId: "bot:one",
            accessMode: "full",
            catalogRevision,
            policyEpoch: 1,
            revision: "revision:policy:1",
            revisionSequence: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        chats: [],
        notices: [],
      }),
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await temporaryRoot(t);
      const path = join(root, filename);
      await writeFile(path, fixture.contents, "utf8");
      const { store } = storeAt(root);
      await assert.rejects(store.initialize(), BotCapabilityUnavailableError);
      assert.equal(await readFile(path, "utf8"), fixture.contents);
    });
  }
});

test("optimistic revisions reject stale edits and narrowing fences active work immediately", async (t) => {
  const root = await temporaryRoot(t);
  const { store } = storeAt(root);
  await store.initialize();
  await store.acknowledgeNotice("device:a", acknowledgement());
  const full = await store.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  const inheritedChat = await store.createChatPolicy({
    chatId: "chat:one",
    botId: "bot:one",
    expectedBotPolicyRevision: full.revision,
    catalog: catalog(),
  });
  const running = await store.admit({
    audienceId: "device:a",
    botId: "bot:one",
    chatId: "chat:one",
  });

  const mailId = snapshot.catalog.connections[0]!.id;
  const customSelection = selection({ shellEnabled: false, connectionIds: [mailId] });
  const custom = await store.updateBotPolicy({
    botId: "bot:one",
    expectedRevision: full.revision,
    catalog: catalog(),
    access: {
      accessMode: "custom",
      catalogRevision,
      custom: customSelection,
    },
    binding: binding(customSelection),
  });
  assert.equal(running.lease.signal.aborted, true);
  assert.throws(() => running.lease.assertCurrent(), /access changed/u);
  assert.notEqual(custom.policyEpoch, full.policyEpoch);
  await assert.rejects(
    store.updateBotPolicy({
      botId: "bot:one",
      expectedRevision: full.revision,
      catalog: catalog(),
      access: { accessMode: "full", catalogRevision, confirmedForeground: true },
    }),
    BotCapabilityRevisionConflictError,
  );

  const beforeWiden = await store.admit({
    audienceId: "device:a",
    botId: "bot:one",
    chatId: "chat:one",
    snapshot,
  });
  assert.ok(beforeWiden.effectiveCustom);
  const widened = await store.updateBotPolicy({
    botId: "bot:one",
    expectedRevision: custom.revision,
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  assert.equal(widened.accessMode, "full");
  assert.equal(beforeWiden.lease.signal.aborted, false);
  beforeWiden.lease.assertCurrent();

  const reduced = selection({ shellEnabled: false, connectionIds: [] });
  const customChat = await store.updateChatPolicy({
    chatId: "chat:one",
    expectedRevision: inheritedChat.revision,
    catalog: catalog(),
    access: {
      mode: "custom",
      catalogRevision,
      expectedBotPolicyRevision: widened.revision,
      custom: selection(),
    },
  });
  const chatRunning = await store.admit({
    audienceId: "device:a",
    botId: "bot:one",
    chatId: "chat:one",
    snapshot,
  });
  await store.updateChatPolicy({
    chatId: "chat:one",
    expectedRevision: customChat.revision,
    catalog: catalog(),
    access: {
      mode: "custom",
      catalogRevision,
      expectedBotPolicyRevision: widened.revision,
      custom: reduced,
    },
  });
  assert.equal(chatRunning.lease.signal.aborted, true);
});

test("the public chat lifecycle fence invalidates an acquired lease synchronously", async (t) => {
  const root = await temporaryRoot(t);
  const { store } = storeAt(root);
  await store.initialize();
  await store.acknowledgeNotice("device:a", acknowledgement());
  const bot = await store.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  await store.createChatPolicy({
    chatId: "chat:one",
    botId: "bot:one",
    expectedBotPolicyRevision: bot.revision,
    catalog: catalog(),
  });
  const admission = await store.admit({
    audienceId: "device:a",
    botId: "bot:one",
    chatId: "chat:one",
  });

  store.invalidateChatAuthority("bot:one", "chat:one");
  assert.equal(admission.lease.signal.aborted, true);
  assert.throws(() => admission.lease.assertCurrent(), /access changed/u);
});

test("protected archive status blocks admission across restart until explicit restore", async (t) => {
  const root = await temporaryRoot(t);
  const first = storeAt(root);
  await first.store.initialize();
  await first.store.acknowledgeNotice("device:a", acknowledgement());
  await first.store.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  const running = await first.store.admit({ audienceId: "device:a", botId: "bot:one" });

  assert.equal(await first.store.archiveBotAuthority("bot:one"), true);
  assert.equal(running.lease.signal.aborted, true);
  assert.equal((await first.store.getBotPolicy("bot:one")).accessMode, "full");
  await assert.rejects(
    first.store.admit({ audienceId: "device:a", botId: "bot:one" }),
    /archived/u,
  );
  await first.store.assertBotAuthorityMatchesIdentity({ botId: "bot:one", archived: true });

  const restarted = storeAt(root);
  await restarted.store.initialize();
  assert.equal(await restarted.store.getBotAuthorityStatus("bot:one"), "archived");
  await assert.rejects(
    restarted.store.assertBotAuthorityMatchesIdentity({ botId: "bot:one", archived: false }),
    /do not match/u,
  );
  assert.equal(await restarted.store.restoreBotAuthority("bot:one"), true);
  await restarted.store.assertBotAuthorityMatchesIdentity({ botId: "bot:one", archived: false });
  const restored = await restarted.store.admit({ audienceId: "device:a", botId: "bot:one" });
  restored.lease.assertCurrent();
});

test("device notice revocation is isolated and survives restart", async (t) => {
  const root = await temporaryRoot(t);
  const { store } = storeAt(root);
  await store.initialize();
  const full = await store.createBotPolicy({
    botId: "bot:one",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  await store.acknowledgeNotice("device:a", acknowledgement());
  await store.acknowledgeNotice("device:b", acknowledgement("customize_first"));
  await assert.rejects(
    store.admit({ audienceId: "device:b", botId: "bot:one" }),
    BotCapabilityNoticeRequiredError,
  );
  const custom = selection({ shellEnabled: false });
  await store.updateBotPolicy({
    botId: "bot:one",
    expectedRevision: full.revision,
    catalog: catalog(),
    access: { accessMode: "custom", catalogRevision, custom },
    binding: binding(custom),
  });
  const phoneA = await store.admit({
    audienceId: "device:a",
    botId: "bot:one",
    snapshot,
  });
  const phoneB = await store.admit({
    audienceId: "device:b",
    botId: "bot:one",
    snapshot,
  });
  assert.equal(await store.revokeNoticeAudience("device:a"), true);
  assert.equal(phoneA.lease.signal.aborted, true);
  assert.equal(phoneB.lease.signal.aborted, false);
  assert.equal((await store.noticeStatus("device:a")).requiresAcknowledgement, true);
  assert.equal((await store.noticeStatus("device:b")).requiresAcknowledgement, false);

  const restarted = storeAt(root);
  await restarted.store.initialize();
  assert.equal((await restarted.store.noticeStatus("device:a")).requiresAcknowledgement, true);
  assert.equal((await restarted.store.noticeStatus("device:b")).requiresAcknowledgement, false);
});

test("create compensation refuses committed identity and cannot remove another Bot", async (t) => {
  const root = await temporaryRoot(t);
  const { store } = storeAt(root);
  await store.initialize();
  await store.acknowledgeNotice("device:a", acknowledgement());
  const first = await store.createBotPolicy({
    botId: "bot:first",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  await store.createChatPolicy({
    chatId: "chat:first",
    botId: "bot:first",
    expectedBotPolicyRevision: first.revision,
    catalog: catalog(),
  });
  await store.createBotPolicy({
    botId: "bot:second",
    catalog: catalog(),
    access: { accessMode: "full", catalogRevision, confirmedForeground: true },
  });
  const running = await store.admit({
    audienceId: "device:a",
    botId: "bot:first",
    chatId: "chat:first",
  });

  assert.equal(
    await store.rollbackUncommittedBotPolicy({
      botId: "bot:missing",
      identityCommitted: false,
    }),
    false,
  );
  await assert.rejects(
    store.rollbackUncommittedBotPolicy({
      botId: "bot:first",
      identityCommitted: true,
    } as unknown as { botId: string; identityCommitted: false }),
    /committed Bot identity/u,
  );
  assert.equal((await store.getBotPolicy("bot:first")).botId, "bot:first");
  assert.equal(
    await store.rollbackUncommittedBotPolicy({
      botId: "bot:first",
      identityCommitted: false,
    }),
    true,
  );
  assert.equal(running.lease.signal.aborted, true);
  await assert.rejects(store.getBotPolicy("bot:first"), BotCapabilityUnavailableError);
  assert.equal((await store.getBotPolicy("bot:second")).botId, "bot:second");
  await assert.rejects(store.getChatPolicy("chat:first"), BotCapabilityUnavailableError);
});
