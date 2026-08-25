import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AidenRemoteBotFileService } from "./aiden-remote-bot-files.js";
import {
  BotArchivedFileReadAuthorityError,
  createBotArchivedFileReadAuthority,
} from "./bot-archived-file-read-authority.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { AidenOpaqueHandleStore } from "./aiden-remote-opaque-handles.js";
import { AIDEN_REMOTE_BASE_PATH, type AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import {
  BotRuntimeAuthorityError,
  type BotRuntimeAuthorityAdmission,
  type BotRuntimeEffectiveAuthority,
} from "./bot-runtime-authority.js";
import type { Chat } from "./types.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import type { BotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import type { BotArchivedReadAuthoritySnapshot } from "./bot-capability-store-core.js";
import { BotMutationGate } from "./bot-mutation-gate.js";

function authorityFixture(input: {
  root: string;
  botId: string;
  chatId: string;
  workspaceId: string;
  epoch: string;
  botHome: boolean;
}): Readonly<BotRuntimeEffectiveAuthority> {
  return {
    audienceId: "device-1",
    botId: input.botId,
    chatId: input.chatId,
    accessMode: "custom",
    botPolicy: { revision: `policy-${input.epoch}`, epoch: `epoch:${input.epoch}` },
    chatPolicy: {
      mode: "inherit",
      revision: `chat-policy-${input.epoch}`,
      epoch: `epoch:${input.epoch}`,
    },
    catalogRevision: "catalog-1",
    provider: {
      sourceProviderId: "provider-1",
      sourceModelId: "model-1",
      connectionFingerprint: "provider-fingerprint",
      providerExactFingerprint: "provider-exact",
      modelFingerprint: "model-fingerprint",
      modelExactFingerprint: "model-exact",
    },
    files: {
      mode: input.botHome ? "scoped" : "off",
      botHome: input.botHome,
      approvedLocations: [],
    },
    shell: { enabled: false },
    connections: [],
    skills: [],
    otherCapabilities: [],
    managedHome: {
      botId: input.botId,
      workspaceId: input.workspaceId,
      createdAt: 1,
      incarnation: {
        device: "1",
        inode: "1",
      },
    },
    workingDirectory: input.root,
  };
}

test("remote Bot Files binds opaque handles to device, chat, policy epoch, and managed home", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-bot-files-"));
  const root = path.join(temporary, "managed-home");
  await fs.mkdir(path.join(root, "Notes"), { recursive: true });
  await fs.writeFile(path.join(root, "Notes", "plan.md"), "first\n", "utf8");
  const chats = new Map<string, Chat>([[
    "chat-1",
    {
      id: "chat-1",
      botId: "bot-1",
      workspaceId: "managed-workspace-1",
      title: "Plan",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ], [
    "chat-2",
    {
      id: "chat-2",
      botId: "bot-2",
      workspaceId: "managed-workspace-1",
      title: "Other Bot",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ]]);
  let epoch = "1";
  let botHome = true;
  let revoked = false;
  let releases = 0;
  const handles = new AidenOpaqueHandleStore();
  const service = new AidenRemoteBotFileService({
    instanceId: "instance-1",
    chats: { get: async (chatId) => chats.get(chatId) ?? null },
    handles,
    authority: {
      admit: async ({ botId, chatId }): Promise<BotRuntimeAuthorityAdmission> => ({
        authority: authorityFixture({
          root,
          botId,
          chatId,
          workspaceId: "managed-workspace-1",
          epoch,
          botHome,
        }),
        signal: new AbortController().signal,
        revalidateBeforeEffect: async () => {
          if (revoked) throw new BotRuntimeAuthorityError("capability_changed");
        },
        release: () => { releases += 1; },
      }),
    },
  });

  try {
    const index = await service.list("device-1", "chat-1");
    const file = index.entries.find(({ displayPath }) => displayPath === "Notes/plan.md");
    assert.ok(file);
    assert.match(file.id, /^file_[A-Za-z0-9_-]{43}$/u);
    assert.equal(file.language, "Markdown");
    assert.equal(JSON.stringify(index).includes(root), false);
    assert.equal(JSON.stringify(index).includes("managed-workspace-1"), false);
    assert.equal(handles.storedTokenMaterialForTesting().some((value) => value.includes("plan")), false);

    const first = await service.read("device-1", "chat-1", file.id);
    assert.equal(first.content, "first\n");
    const saved = await service.write("device-1", "chat-1", file.id, {
      content: "second\n",
      expectedVersion: first.version,
    });
    assert.equal(saved.content, "second\n");
    assert.equal(await fs.readFile(path.join(root, "Notes", "plan.md"), "utf8"), "second\n");

    await assert.rejects(
      () => service.read("device-2", "chat-1", file.id),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "handle_wrong_device",
    );
    await assert.rejects(
      () => service.read("device-1", "chat-2", file.id),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "root_policy_changed",
    );

    epoch = "2";
    await assert.rejects(
      () => service.read("device-1", "chat-1", file.id),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "root_policy_changed",
    );

    botHome = false;
    await assert.rejects(
      () => service.list("device-1", "chat-1"),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "capability_denied",
    );

    botHome = true;
    revoked = true;
    await assert.rejects(
      () => service.list("device-1", "chat-1"),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "operation_stale",
    );
    assert.ok(releases >= 6);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("remote Bot Files rejects ordinary and cross-Bot chats before managed-home access", async () => {
  let admissions = 0;
  const chats = new Map<string, Chat>([
    ["ordinary", {
      id: "ordinary",
      workspaceId: "workspace-1",
      title: "Ordinary",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  ]);
  const service = new AidenRemoteBotFileService({
    instanceId: "instance-1",
    chats: { get: async (chatId) => chats.get(chatId) ?? null },
    authority: {
      admit: async () => {
        admissions += 1;
        throw new Error("must not admit");
      },
    },
  });
  await assert.rejects(
    () => service.list("device-1", "ordinary"),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "not_found",
  );
  await assert.rejects(
    () => service.list("device-1", "missing"),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "not_found",
  );
  assert.equal(admissions, 0);
});

test("archived Bot file reads retain exact read authority while writes remain blocked", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-archived-bot-files-"));
  const root = path.join(temporary, "managed-home");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "history.txt"), "archived\n", "utf8");
  const bot: BotDefinition = {
    id: "bot-1",
    name: "Archivist",
    instructions: "Keep records.",
    avatar: "spark",
    revision: "bot-revision-1",
    createdAt: 1,
    updatedAt: 2,
    archivedAt: 3,
  };
  const chat: Chat = {
    id: "chat-1",
    botId: bot.id,
    workspaceId: "managed-workspace-1",
    title: "History",
    messages: [],
    createdAt: 1,
    updatedAt: 2,
  };
  let policyEpoch = 1;
  let botState: BotDefinition = bot;
  const archivedPolicy = (): BotArchivedReadAuthoritySnapshot => ({
    policy: {
      botId: bot.id,
      authorityStatus: "archived",
      accessMode: "full",
      catalogRevision: "catalog-1",
      policyEpoch,
      revision: "bot-policy-1",
      revisionSequence: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    chat: {
      chatId: chat.id,
      botId: bot.id,
      mode: "inherit",
      catalogRevision: "catalog-1",
      policyEpoch: 1,
      revision: "chat-policy-1",
      revisionSequence: 1,
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const homeOption = {
    id: "file-home",
    label: "Bot folder",
    available: true,
    kind: "bot_home" as const,
  };
  const snapshot: BotCapabilityCatalogSnapshot = {
    catalog: {
      revision: "catalog-1",
      providers: [],
      fileScopes: [homeOption],
      shellAvailable: false,
      connections: [],
      skills: [],
      otherCapabilities: [],
      notice: { version: "bot-full-access-v1", requiresAcknowledgement: true },
    },
    resources: {
      providers: [],
      fileScopes: [{
        option: homeOption,
        sourceId: "builtin.bot_home.v1",
        scopeFingerprint: "scope-fingerprint",
        exactFingerprint: "scope-exact",
      }],
      shell: {
        available: false,
        shellFingerprint: "shell-fingerprint",
        exactFingerprint: "shell-exact",
      },
      connections: [],
      skills: [],
      otherCapabilities: [],
    },
  };
  let releases = 0;
  const managedWorkspace = {
    botId: bot.id,
    workspaceId: "managed-workspace-1",
    createdAt: 1,
    homePath: root,
    incarnation: { device: "1", inode: "1" },
  };
  const archivedRead = createBotArchivedFileReadAuthority({
    bots: { get: async () => botState },
    chats: { get: async () => chat },
    capabilities: {
      inspectArchivedReadAuthority: async () => archivedPolicy(),
      assertAuthorityBindingsCurrent: async () => undefined,
    },
    catalog: { snapshotForRuntime: async () => snapshot },
    managedWorkspace: {
      resolve: async () => managedWorkspace,
      revalidate: async () => managedWorkspace,
    },
    mutationGate: new BotMutationGate(),
    inventoryLeases: {
      acquire: () => ({
        generation: 1,
        signal: new AbortController().signal,
        assertCurrent: () => undefined,
        release: () => { releases += 1; },
      }),
    },
  });
  const service = new AidenRemoteBotFileService({
    instanceId: "instance-1",
    chats: { get: async () => chat },
    authority: {
      admit: async () => { throw new BotRuntimeAuthorityError("bot_unavailable"); },
    },
    archivedRead,
  });
  try {
    const index = await service.list("device-1", chat.id);
    const file = index.entries.find(({ displayPath }) => displayPath === "history.txt");
    assert.ok(file);
    assert.equal((await service.read("device-1", chat.id, file.id)).content, "archived\n");
    await assert.rejects(
      () => service.write("device-1", chat.id, file.id, {
        content: "changed\n",
        expectedVersion: "1".repeat(64),
      }),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "bot_archived",
    );
    assert.equal(await fs.readFile(path.join(root, "history.txt"), "utf8"), "archived\n");

    await assert.rejects(
      () => archivedRead.run({ botId: bot.id, chatId: chat.id }, async (context) => {
        policyEpoch = 2;
        await context.revalidateBeforeEffect();
      }),
      (error: unknown) =>
        error instanceof BotArchivedFileReadAuthorityError && error.classification === "changed",
    );
    policyEpoch = 1;
    await assert.rejects(
      () => archivedRead.run({ botId: bot.id, chatId: chat.id }, async (context) => {
        botState = { ...bot, archivedAt: undefined };
        await context.revalidateBeforeEffect();
      }),
      (error: unknown) =>
        error instanceof BotArchivedFileReadAuthorityError && error.classification === "changed",
    );
    assert.ok(releases >= 5);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

async function httpFixture(options: {
  capabilities: readonly AidenRemoteCapability[];
  authorizationBlocked?: () => boolean;
}) {
  const calls: string[] = [];
  const fileId = `file_${"f".repeat(43)}`;
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Studio Mac",
    appVersion: "0.30.0",
    devices: {
      authenticate: async (credential) => credential === "a".repeat(43) ? {
        id: "device-authorized-12345678",
        revoked: false,
        acceptsBotCapabilities: true,
        capabilities: new Set(options.capabilities),
      } : null,
      acquireDeviceAuthorization: () => {
        if (options.authorizationBlocked?.()) {
          throw new AidenRemoteServiceError(
            "credential_revoked",
            "This device was revoked in Aiden Settings.",
            403,
          );
        }
        return () => undefined;
      },
    },
    pairing: { exchange: async () => { throw new Error("unused"); } },
    botFiles: {
      list: async (deviceId, chatId) => {
        calls.push(`list:${deviceId}:${chatId}`);
        return { snapshotId: "files-1", entries: [], truncated: false, maxEntries: 4_000, maxDepth: 20 };
      },
      read: async (deviceId, chatId, suppliedFileId) => {
        calls.push(`read:${deviceId}:${chatId}:${suppliedFileId}`);
        return {
          id: suppliedFileId,
          displayPath: "note.txt",
          content: "hello",
          version: "1".repeat(64),
          truncated: false,
        };
      },
      write: async (deviceId, chatId, suppliedFileId) => {
        calls.push(`write:${deviceId}:${chatId}:${suppliedFileId}`);
        return {
          id: suppliedFileId,
          displayPath: "note.txt",
          content: "saved",
          version: "2".repeat(64),
          truncated: false,
        };
      },
    },
    connectionMode: () => "lan",
    now: () => 1,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    base: `http://127.0.0.1:${address.port}${AIDEN_REMOTE_BASE_PATH}`,
    calls,
    fileId,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const authorizationHeaders = {
  authorization: `Bearer ${"a".repeat(43)}`,
  "aiden-protocol-version": "1",
};

test("Bot conversation file routes require conjunctive Bot and file grants", async () => {
  const app = await httpFixture({
    capabilities: ["bot:read", "bot:write", "files:read", "files:write"],
  });
  try {
    const listed = await fetch(`${app.base}/bot-conversations/chat-1/files`, {
      headers: authorizationHeaders,
    });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).snapshotId, "files-1");

    const read = await fetch(`${app.base}/bot-conversations/chat-1/files/${app.fileId}`, {
      headers: authorizationHeaders,
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).content, "hello");

    const written = await fetch(`${app.base}/bot-conversations/chat-1/files/${app.fileId}`, {
      method: "PUT",
      headers: { ...authorizationHeaders, "content-type": "application/json" },
      body: JSON.stringify({ content: "saved", expectedVersion: "1".repeat(64) }),
    });
    assert.equal(written.status, 200);
    assert.equal((await written.json()).content, "saved");
    assert.deepEqual(app.calls.map((call) => call.split(":", 1)[0]), ["list", "read", "write"]);
  } finally {
    await app.close();
  }

  const denied = await httpFixture({ capabilities: ["files:read", "files:write"] });
  try {
    const response = await fetch(`${denied.base}/bot-conversations/chat-1/files`, {
      headers: authorizationHeaders,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "capability_denied");
    assert.deepEqual(denied.calls, []);
  } finally {
    await denied.close();
  }
});

test("stalled Bot file PUT parses its body before device revocation admission", async () => {
  let blocked = false;
  const app = await httpFixture({
    capabilities: ["bot:read", "bot:write", "files:write"],
    authorizationBlocked: () => blocked,
  });
  try {
    const target = new URL(`${app.base}/bot-conversations/chat-1/files/${app.fileId}`);
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "PUT",
        headers: {
          ...authorizationHeaders,
          "content-type": "application/json",
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({
          status: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.once("error", reject);
      request.write("{");
      blocked = true;
      request.end(`"content":"saved","expectedVersion":"${"1".repeat(64)}"}`);
    });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.body).error.code, "credential_revoked");
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});
