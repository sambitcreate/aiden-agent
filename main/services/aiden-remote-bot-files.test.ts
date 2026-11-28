import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { listWorkspaceFiles } from "./workspace-files.js";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AidenRemoteBotFileService } from "./aiden-remote-bot-files.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { AidenOpaqueHandleStore, inspectAidenFilesystemIdentity } from "./aiden-remote-opaque-handles.js";
import { AIDEN_REMOTE_BASE_PATH, type AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import {
  BotRuntimeAuthorityError,
  type BotRuntimeAuthorityAdmission,
  type BotRuntimeEffectiveAuthority,
} from "./bot-runtime-authority.js";
import type { Chat } from "./types.js";

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
    botAudienceId: "desktop:local",
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
    // A save installs a new inode. Clients validate the response id against the
    // one they sent and keep using it, so it must still read and save the file.
    assert.equal(saved.id, file.id);
    const reread = await service.read("device-1", "chat-1", saved.id);
    assert.equal(reread.content, "second\n");
    const resaved = await service.write("device-1", "chat-1", saved.id, {
      content: "third\n",
      expectedVersion: reread.version,
    });
    assert.equal(resaved.content, "third\n");
    assert.equal(await fs.readFile(path.join(root, "Notes", "plan.md"), "utf8"), "third\n");

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

test("a device paired without its own Full Access notice opens Bot Files under the Mac owner's authority", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-bot-files-"));
  const root = path.join(temporary, "managed-home");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "brief.md"), "agenda\n", "utf8");
  const chat: Chat = {
    id: "chat-1",
    botId: "bot-1",
    workspaceId: "managed-workspace-1",
    title: "Chief of Staff",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  // Only the Mac owner accepted Full Access. The runtime resolver folds the
  // store's missing-notice rejection for any other audience into
  // access_unavailable, which Bot Files reports as a stale-access 409.
  const acceptedAudiences = new Set(["desktop:local"]);
  const service = new AidenRemoteBotFileService({
    instanceId: "instance-1",
    botAudienceId: "desktop:local",
    chats: { get: async (chatId) => chatId === chat.id ? chat : null },
    authority: {
      admit: async ({ audienceId, botId, chatId }): Promise<BotRuntimeAuthorityAdmission> => {
        if (!acceptedAudiences.has(audienceId)) {
          throw new BotRuntimeAuthorityError("access_unavailable");
        }
        return {
          authority: authorityFixture({
            root,
            botId,
            chatId,
            workspaceId: "managed-workspace-1",
            epoch: "1",
            botHome: true,
          }),
          signal: new AbortController().signal,
          revalidateBeforeEffect: async () => undefined,
          release: () => undefined,
        };
      },
    },
  });

  try {
    const index = await service.list("device-new-iphone", "chat-1");
    assert.deepEqual(index.entries.map(({ displayPath }) => displayPath), ["brief.md"]);
    const file = index.entries[0]!;
    const document = await service.read("device-new-iphone", "chat-1", file.id);
    assert.equal(document.content, "agenda\n");
    const saved = await service.write("device-new-iphone", "chat-1", file.id, {
      content: "agenda v2\n",
      expectedVersion: document.version,
    });
    assert.equal(saved.content, "agenda v2\n");
    assert.equal(await fs.readFile(path.join(root, "brief.md"), "utf8"), "agenda v2\n");
    // Admitting as the Mac owner must not let another paired device use this one's handle.
    await assert.rejects(
      () => service.read("device-other", "chat-1", file.id),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "handle_wrong_device",
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("re-listing Bot Files reclaims superseded unopened handles instead of answering 429", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-bot-files-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "managed-home");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "a.md"), "a\n", "utf8");
  await fs.writeFile(path.join(root, "b.md"), "b\n", "utf8");
  const chat: Chat = {
    id: "chat-1", botId: "bot-1", workspaceId: "managed-workspace-1", title: "Plan", messages: [], createdAt: 1, updatedAt: 1,
  };
  const service = new AidenRemoteBotFileService({
    instanceId: "instance-1",
    botAudienceId: "desktop:local",
    chats: { get: async (chatId) => chatId === chat.id ? chat : null },
    handles: new AidenOpaqueHandleStore({ maxEntries: 3 }),
    authority: {
      admit: async ({ botId, chatId }): Promise<BotRuntimeAuthorityAdmission> => ({
        authority: authorityFixture({ root, botId, chatId, workspaceId: "managed-workspace-1", epoch: "1", botHome: true }),
        signal: new AbortController().signal,
        revalidateBeforeEffect: async () => undefined,
        release: () => undefined,
      }),
    },
  });
  const first = await service.list("device-1", "chat-1");
  const opened = first.entries.find(({ displayPath }) => displayPath === "a.md")!;
  const unopened = first.entries.find(({ displayPath }) => displayPath === "b.md")!;
  await service.read("device-1", "chat-1", opened.id);
  for (let refresh = 0; refresh < 3; refresh++) {
    assert.equal((await service.list("device-1", "chat-1")).entries.length, 2);
  }
  assert.equal((await service.read("device-1", "chat-1", opened.id)).content, "a\n");
  await assert.rejects(
    () => service.read("device-1", "chat-1", unopened.id),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "handle_invalid",
  );
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
    botAudienceId: "desktop:local",
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

async function httpFixture(options: {
  capabilities: readonly AidenRemoteCapability[];
  authorizationBlocked?: (deviceId: string) => boolean;
  /** Holds a Bot Files read after the service is called and before it returns. */
  holdRead?: () => Promise<void>;
}) {
  const calls: string[] = [];
  const fileId = `file_${"f".repeat(43)}`;
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Studio Mac",
    appVersion: "0.30.0",
    devices: {
      authenticate: async (credential) => {
        const id = credential === "a".repeat(43)
          ? "device-authorized-12345678"
          : credential === "b".repeat(43)
            ? "device-other-87654321"
            : undefined;
        return id ? {
          id,
          revoked: false,
          acceptsBotCapabilities: true,
          capabilities: new Set(options.capabilities),
        } : null;
      },
      acquireDeviceAuthorization: (deviceId) => {
        if (options.authorizationBlocked?.(deviceId)) {
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
        await options.holdRead?.();
        return { snapshotId: "files-1", entries: [], truncated: false, maxEntries: 4_000, maxDepth: 20 };
      },
      read: async (deviceId, chatId, suppliedFileId) => {
        calls.push(`read:${deviceId}:${chatId}:${suppliedFileId}`);
        await options.holdRead?.();
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

test("a Bot Files read held across device revocation publishes nothing, and other devices keep reading", async () => {
  const revoked = new Set<string>();
  let release: (() => void) | undefined;
  let held: (() => void) | undefined;
  const app = await httpFixture({
    capabilities: ["bot:read", "files:read"],
    authorizationBlocked: (deviceId) => revoked.has(deviceId),
    holdRead: async () => {
      if (revoked.size > 0 || !release) return;
      held?.();
      await new Promise<void>((resolve) => { release = resolve; });
    },
  });
  try {
    for (const path of ["/bot-conversations/chat-1/files", `/bot-conversations/chat-1/files/${app.fileId}`]) {
      release = () => undefined;
      const reached = new Promise<void>((resolve) => { held = resolve; });
      const pending = fetch(`${app.base}${path}`, { headers: authorizationHeaders });
      await reached;
      // Revocation completes while the Mac-owner Bot authority is still reading.
      revoked.add("device-authorized-12345678");
      release();
      const response = await pending;
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error.code, "credential_revoked");
      assert.equal(JSON.stringify(body).includes("hello"), false);
      revoked.clear();
    }
    release = undefined;
    revoked.add("device-authorized-12345678");
    const other = await fetch(`${app.base}/bot-conversations/chat-1/files/${app.fileId}`, {
      headers: { ...authorizationHeaders, authorization: `Bearer ${"b".repeat(43)}` },
    });
    assert.equal(other.status, 200);
    assert.equal((await other.json()).content, "hello");
  } finally {
    await app.close();
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

async function budgetBotFixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 24; i += 1) await fs.writeFile(path.join(root, `file${i}.txt`), "fixture");
  const controller = new AbortController();
  const handles = new AidenOpaqueHandleStore();
  let releases = 0;
  const service = new AidenRemoteBotFileService({
    instanceId: "instance", botAudienceId: "desktop:local", handles,
    chats: { get: async id => ({ id, botId: "bot", workspaceId: "home", title: "Bot", messages: [], createdAt: 1, updatedAt: 1 }) },
    authority: { admit: async ({ botId, chatId }) => ({
      authority: authorityFixture({ root, botId, chatId, workspaceId: "home", epoch: "1", botHome: true }),
      signal: controller.signal,
      revalidateBeforeEffect: async () => {
        if (controller.signal.aborted) throw new BotRuntimeAuthorityError("capability_changed");
      },
      release: () => { releases += 1; },
    }) },
  });
  return { root, service, handles, controller, releases: () => releases };
}

test("Bot and workspace listings share the aggregate metadata budget with ordered fresh handles", async (t) => {
  const { service, releases } = await budgetBotFixture(t);
  const desktopRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-desktop-metadata-"));
  t.after(() => fs.rm(desktopRoot, { recursive: true, force: true }));
  for (let i = 0; i < 96; i += 1) await fs.writeFile(path.join(desktopRoot, `file${i}.txt`), "fixture");
  const original = fsPromises.stat;
  let active = 0;
  let peak = 0;
  let calls = 0;
  fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (!String(args[0]).endsWith(".txt")) return original(...args);
    calls += 1;
    peak = Math.max(peak, ++active);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      return await original(...args);
    } finally { active -= 1; }
  }) as typeof fsPromises.stat;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.stat = original; syncBuiltinESMExports(); });
  const [first, second, desktop] = await Promise.all([
    service.list("device-1", "chat-one"), service.list("device-1", "chat-two"), listWorkspaceFiles(desktopRoot),
  ]);
  const paths = Array.from({ length: 24 }, (_, i) => `file${i}.txt`);
  assert.deepEqual(first.entries.map(entry => entry.displayPath), paths);
  assert.deepEqual(second.entries.map(entry => entry.displayPath), paths);
  assert.deepEqual(desktop.entries.map(entry => entry.path), Array.from({ length: 96 }, (_, i) => `file${i}.txt`));
  assert.equal(calls, 192);
  assert.ok(peak > 1 && peak <= 4, `aggregate Bot/workspace metadata concurrency: ${peak}`);
  assert.equal(active, 0);
  assert.equal(releases(), 2);
  await assert.rejects(service.read("device-1", "chat-two", first.entries[0]!.id),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "root_policy_changed");
});

test("Bot revocation during identity inspection drains work before releasing authority and issues no handles", async (t) => {
  const { service, handles, controller, releases } = await budgetBotFixture(t);
  const original = fsPromises.stat;
  const visits = new Map<string, number>();
  let active = 0;
  fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
    const name = String(args[0]);
    if (!name.endsWith(".txt")) return original(...args);
    const visit = (visits.get(name) ?? 0) + 1;
    visits.set(name, visit);
    active += 1;
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (visit === 2) controller.abort(new BotRuntimeAuthorityError("capability_changed"));
      return await original(...args);
    } finally { active -= 1; }
  }) as typeof fsPromises.stat;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.stat = original; syncBuiltinESMExports(); });
  await assert.rejects(service.list("device-1", "chat-one"),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "operation_stale");
  assert.equal(active, 0);
  assert.equal(releases(), 1);
  assert.equal(handles.storedTokenMaterialForTesting().length, 0);
});

test("remote Bot Files HTTP routes omit .git entries and reject protected config and .git writes", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-bot-guard-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "secret-bot-home");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.mkdir(path.join(root, ".aiden"), { recursive: true });
  await fs.mkdir(path.join(root, ".codex"), { recursive: true });

  const gitPointer = "gitdir: /Users/owner/bot-repo/.git/worktrees/bot-home\n";
  const initialClaude = "{\"permissions\":{\"allow\":[]}}\n";
  const initialHooks = "{\"hooks\":[]}\n";
  const initialCodex = "sandbox_mode = \"workspace-write\"\n";

  await fs.writeFile(path.join(root, ".git"), gitPointer, "utf8");
  await fs.writeFile(path.join(root, "sub", ".GIT"), gitPointer, "utf8");
  await fs.writeFile(path.join(root, ".gitignore"), ".DS_Store\n", "utf8");
  await fs.writeFile(path.join(root, ".gitattributes"), "* text=auto\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "# Bot Home\n", "utf8");
  await fs.writeFile(path.join(root, ".claude", "settings.json"), initialClaude, "utf8");
  await fs.writeFile(path.join(root, ".aiden", "hooks.json"), initialHooks, "utf8");
  await fs.writeFile(path.join(root, ".codex", "config.toml"), initialCodex, "utf8");
  await fs.symlink(path.join(root, ".aiden", "hooks.json"), path.join(root, "linked-hooks.json"));

  const realRoot = await fs.realpath(root);
  const chat: Chat = {
    id: "chat-bot-guard",
    botId: "bot-guard",
    workspaceId: "managed-bot-ws",
    title: "Assistant",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const handles = new AidenOpaqueHandleStore();
  const botFiles = new AidenRemoteBotFileService({
    instanceId: "instance-bot-guard",
    botAudienceId: "desktop:local",
    chats: { get: async (chatId) => (chatId === chat.id ? chat : null) },
    handles,
    authority: {
      admit: async ({ botId, chatId }): Promise<BotRuntimeAuthorityAdmission> => ({
        authority: authorityFixture({
          root: realRoot,
          botId,
          chatId,
          workspaceId: chat.workspaceId!,
          epoch: "1",
          botHome: true,
        }),
        signal: new AbortController().signal,
        revalidateBeforeEffect: async () => undefined,
        release: () => undefined,
      }),
    },
  });

  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-bot-guard",
    displayName: () => "Studio Mac",
    appVersion: "0.70.0",
    devices: {
      authenticate: async (credential) => credential === "a".repeat(43)
        ? {
            id: "device-authorized-12345678",
            revoked: false,
            acceptsBotCapabilities: true,
            capabilities: new Set<AidenRemoteCapability>(["bot:read", "bot:write", "files:read", "files:write"]),
          }
        : null,
      acquireDeviceAuthorization: () => () => undefined,
    },
    pairing: { exchange: async () => { throw new Error("unused"); } },
    botFiles,
    connectionMode: () => "lan",
    now: () => 1_000,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  const baseUrl = `http://127.0.0.1:${address.port}${AIDEN_REMOTE_BASE_PATH}`;
  const writeHeaders = { ...authorizationHeaders, "content-type": "application/json" };

  const listRes = await fetch(`${baseUrl}/bot-conversations/${chat.id}/files`, {
    headers: authorizationHeaders,
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as { entries: Array<{ id: string; displayPath: string }> };
  assert.equal(listBody.entries.find((entry) => entry.displayPath === ".git"), undefined);
  assert.equal(listBody.entries.find((entry) => entry.displayPath === "sub/.GIT"), undefined);
  assert.ok(listBody.entries.find((entry) => entry.displayPath === ".gitignore"));
  assert.ok(listBody.entries.find((entry) => entry.displayPath === ".gitattributes"));
  assert.equal(JSON.stringify(listBody).includes("secret-bot-home"), false);

  const gitignoreEntry = listBody.entries.find((entry) => entry.displayPath === ".gitignore")!;
  const gitignoreDoc = await (await fetch(
    `${baseUrl}/bot-conversations/${chat.id}/files/${gitignoreEntry.id}`,
    { headers: authorizationHeaders },
  )).json() as { version: string };
  const gitignorePut = await fetch(`${baseUrl}/bot-conversations/${chat.id}/files/${gitignoreEntry.id}`, {
    method: "PUT",
    headers: writeHeaders,
    body: JSON.stringify({ content: ".DS_Store\ntmp/\n", expectedVersion: gitignoreDoc.version }),
  });
  assert.equal(gitignorePut.status, 200);
  assert.equal(await fs.readFile(path.join(root, ".gitignore"), "utf8"), ".DS_Store\ntmp/\n");

  const canary = "{\"pwned\":true}\n";
  for (const [displayPath, diskPath, original] of [
    [".claude/settings.json", path.join(root, ".claude", "settings.json"), initialClaude],
    [".aiden/hooks.json", path.join(root, ".aiden", "hooks.json"), initialHooks],
    [".codex/config.toml", path.join(root, ".codex", "config.toml"), initialCodex],
    ["linked-hooks.json", path.join(root, ".aiden", "hooks.json"), initialHooks],
  ] as const) {
    const entry = listBody.entries.find((candidate) => candidate.displayPath === displayPath);
    assert.ok(entry, `expected ${displayPath} in Bot file listing`);
    const docRes = await fetch(`${baseUrl}/bot-conversations/${chat.id}/files/${entry.id}`, {
      headers: authorizationHeaders,
    });
    assert.equal(docRes.status, 200);
    const doc = await docRes.json() as { version: string };
    const putRes = await fetch(`${baseUrl}/bot-conversations/${chat.id}/files/${entry.id}`, {
      method: "PUT",
      headers: writeHeaders,
      body: JSON.stringify({ content: canary, expectedVersion: doc.version }),
    });
    assert.equal(putRes.status, 403, `expected 403 for ${displayPath}`);
    const errorBody = await putRes.json() as { error: { code: string; message: string } };
    assert.equal(errorBody.error.code, "capability_denied");
    assert.equal(JSON.stringify(errorBody).includes("secret-bot-home"), false);
    assert.equal(JSON.stringify(errorBody).includes(realRoot), false);
    assert.equal(await fs.readFile(diskPath, "utf8"), original);
  }

  // Verify pre-issued .git handle also fails closed on write without touching disk.
  const gitIdentity = await inspectAidenFilesystemIdentity(realRoot, path.join(realRoot, ".git"));
  const rootId = `botfiles_${createHash("sha256").update(`${chat.botId}\u0000${chat.id}`, "utf8").digest("base64url")}`;
  const policyRevision = `botfiles_${createHash("sha256").update(JSON.stringify({
    botId: chat.botId,
    chatId: chat.id,
    workspaceId: chat.workspaceId,
    botPolicy: { revision: "policy-1", epoch: "epoch:1" },
    chatPolicy: { mode: "inherit", revision: "chat-policy-1", epoch: "epoch:1" },
  }), "utf8").digest("base64url")}`;
  const staleGitHandle = handles.issue("file", {
    instanceId: "instance-bot-guard",
    deviceId: "device-authorized-12345678",
    workspaceId: chat.workspaceId!,
    rootId,
    policyRevision,
    ...gitIdentity,
    displayPath: ".git",
    snapshotId: "files_bot_synthetic",
    expiresAt: Date.now() + 60_000,
  });
  const gitPutRes = await fetch(`${baseUrl}/bot-conversations/${chat.id}/files/${staleGitHandle}`, {
    method: "PUT",
    headers: writeHeaders,
    body: JSON.stringify({
      content: "gitdir: /tmp/hijack\n",
      expectedVersion: createHash("sha256").update(gitPointer, "utf8").digest("hex"),
    }),
  });
  assert.equal(gitPutRes.status, 403);
  assert.equal((await gitPutRes.json()).error.code, "capability_denied");
  assert.equal(await fs.readFile(path.join(root, ".git"), "utf8"), gitPointer);
});
