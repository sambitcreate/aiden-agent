import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { memoryScopeForChat } from "./memory-context.js";
import {
  canonicalWorkspacePath,
  legacyCliWorkspaceScopeId,
  sharedMemoryRoot,
  sharedWorkspaceScopeId,
} from "./memory-shared.js";
import { MemoryStore, type MemoryScope } from "./memory-store.js";
import type { Chat } from "./types.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-memory-shared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-a",
    title: "Chat",
    workspaceId: "workspace-a",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("shared workspace scope hashes the canonical folder path", async (t) => {
  const root = await fixture(t);
  const real = path.join(root, "project");
  const link = path.join(root, "project-link");
  await mkdir(real);
  await symlink(real, link);
  assert.equal(canonicalWorkspacePath(link), canonicalWorkspacePath(real));
  const scope = sharedWorkspaceScopeId(link);
  assert.equal(scope, sharedWorkspaceScopeId(real));
  assert.match(scope, /^ws-[0-9a-f]{24}$/u);
  // Deleted folders fall back to the resolved path instead of throwing.
  assert.match(sharedWorkspaceScopeId(path.join(root, "missing", "..", "missing")), /^ws-[0-9a-f]{24}$/u);
});

test("shared memory root follows the portable config dir and isolates custom agent dirs", async (t) => {
  const root = await fixture(t);
  assert.equal(
    sharedMemoryRoot(undefined, { AIDEN_CONFIG_DIR: path.join(root, "cfg") }),
    path.join(root, "cfg", "memory"),
  );
  const homeAgent = path.join(os.homedir(), ".aiden", "agent");
  assert.equal(sharedMemoryRoot(homeAgent, {}), path.join(os.homedir(), ".aiden", "memory"));
  const sandbox = path.join(root, "agent");
  assert.equal(sharedMemoryRoot(sandbox, {}), path.join(sandbox, "shared-memory"));
});

test("memory scope uses the shared folder hash when the desktop knows the folder", () => {
  assert.deepEqual(memoryScopeForChat(chat(), "/repo/project"), {
    kind: "workspace",
    id: sharedWorkspaceScopeId("/repo/project"),
  });
  // Unknown folder keeps the legacy workspace-id scope; bots are unchanged.
  assert.deepEqual(memoryScopeForChat(chat()), { kind: "workspace", id: "workspace-a" });
  assert.deepEqual(memoryScopeForChat(chat({ botId: "bot-a" }), "/repo/project"), {
    kind: "bot",
    id: "bot-a",
  });
});

test("memory store absorbs a legacy database once and remaps scope ids", async (t) => {
  const root = await fixture(t);
  const legacyDir = path.join(root, "legacy");
  const legacyScope: MemoryScope = { kind: "workspace", id: "workspace-uuid-1" };
  const legacy = new MemoryStore({ root: () => legacyDir, now: () => 1_000 });
  await legacy.put({ scope: legacyScope, text: "User likes dark mode", provenance: { kind: "user_edit", sourceId: "aiden" } });
  await legacy.put({ scope: { kind: "bot", id: "bot-1" }, text: "Bot memory stays", provenance: { kind: "user_edit", sourceId: "aiden" } });
  await legacy.close();

  const sharedDir = path.join(root, "shared");
  const mapped = sharedWorkspaceScopeId("/repo/project");
  const make = () => new MemoryStore({
    root: () => sharedDir,
    imports: async () => [{
      file: path.join(legacyDir, "memory-v1.sqlite"),
      scopeIds: { "workspace-uuid-1": mapped },
    }],
  });
  const shared = make();
  assert.equal((await shared.list({ kind: "workspace", id: mapped })).length, 1);
  assert.equal((await shared.list({ kind: "bot", id: "bot-1" })).length, 1);
  await shared.close();

  // Reopening does not duplicate, and the legacy file is left intact.
  const reopened = make();
  assert.equal((await reopened.list({ kind: "workspace", id: mapped })).length, 1);
  await reopened.close();
  const check = new MemoryStore({ root: () => legacyDir });
  assert.equal((await check.list(legacyScope)).length, 1);
  await check.close();
});

test("a changed legacy file is re-absorbed (downgrade writes flow forward)", async (t) => {
  const root = await fixture(t);
  const legacyDir = path.join(root, "legacy");
  const legacyFile = path.join(legacyDir, "memory-v1.sqlite");
  const legacy = new MemoryStore({ root: () => legacyDir, now: () => 1_000 });
  const scope: MemoryScope = { kind: "workspace", id: "ws" };
  await legacy.put({ scope, text: "first fact", provenance: { kind: "user_edit", sourceId: "aiden" } });
  await legacy.close();

  const sharedDir = path.join(root, "shared");
  const make = () => new MemoryStore({
    root: () => sharedDir,
    imports: async () => [{ file: legacyFile }],
  });
  const first = make();
  assert.equal((await first.list(scope)).length, 1);
  await first.close();

  const legacyAgain = new MemoryStore({ root: () => legacyDir, now: () => 2_000 });
  await legacyAgain.put({ scope, text: "second fact", provenance: { kind: "user_edit", sourceId: "aiden" } });
  await legacyAgain.close();
  await utimes(legacyFile, new Date(), new Date());

  const second = make();
  assert.equal((await second.list(scope)).length, 2);
  await second.close();
});

test("scope aliases copy rows into the shared scope without resurrecting deletions", async (t) => {
  const root = await fixture(t);
  const scope: MemoryScope = { kind: "workspace", id: "workspace-uuid-2" };
  const store = new MemoryStore({ root: () => root, now: () => 1_000 });
  const fact = await store.put({ scope, text: "Portable fact", provenance: { kind: "user_edit", sourceId: "aiden" } });
  await store.close();

  const mapped = sharedWorkspaceScopeId("/repo/other");
  const make = () => new MemoryStore({
    root: () => root,
    scopeAliases: async () => [{ from: scope, to: { kind: "workspace", id: mapped } }],
  });
  const migrated = make();
  const newScope = { kind: "workspace" as const, id: mapped };
  const copied = await migrated.list(newScope);
  assert.equal(copied.length, 1);
  // Copies carry derived ids — primary keys are never aliased across scopes.
  assert.notEqual(copied[0].id, fact.id);
  // The original scope keeps its rows for downgrade compatibility.
  assert.equal((await migrated.list(scope)).length, 1);

  // A deletion in the new scope must not be resurrected by the alias pass.
  await migrated.remove(newScope, copied[0].id);
  assert.equal((await migrated.list(newScope)).length, 0);
  await migrated.close();
  const reopened = make();
  assert.equal((await reopened.list(newScope)).length, 0);
  await reopened.close();
});

test("legacy CLI scope ids are absorbed into the shared folder-hash scope", async (t) => {
  const root = await fixture(t);
  const workspaceRoot = path.join(root, "ws");
  const legacyDir = path.join(root, "agent", "memory");
  const legacy = new MemoryStore({ root: () => legacyDir, now: () => 1_000 });
  const cliScope = { kind: "workspace" as const, id: legacyCliWorkspaceScopeId(workspaceRoot) };
  await legacy.put({ scope: cliScope, text: "Terminal fact", provenance: { kind: "user_edit", sourceId: "aiden-cli" } });
  await legacy.close();

  const shared = new MemoryStore({
    root: () => path.join(root, "agent", "shared-memory"),
    imports: async () => [{
      file: path.join(legacyDir, "memory-v1.sqlite"),
      scopeIds: {
        [cliScope.id]: sharedWorkspaceScopeId(workspaceRoot),
        [legacyCliWorkspaceScopeId(canonicalWorkspacePath(workspaceRoot))]: sharedWorkspaceScopeId(workspaceRoot),
      },
    }],
  });
  const newScope = { kind: "workspace" as const, id: sharedWorkspaceScopeId(workspaceRoot) };
  assert.deepEqual((await shared.list(newScope)).map(({ text }) => text), ["Terminal fact"]);
  await shared.close();
});

test("a legacy scope unmapped at first import still remaps once the workspace is known", async (t) => {
  const root = await fixture(t);
  const legacyDir = path.join(root, "legacy");
  const legacyFile = path.join(legacyDir, "memory-v1.sqlite");
  const folder = path.join(root, "ws-b");
  const cliScope = { kind: "workspace" as const, id: legacyCliWorkspaceScopeId(folder) };
  const legacy = new MemoryStore({ root: () => legacyDir, now: () => 1_000 });
  await legacy.put({ scope: cliScope, text: "Folder B fact", provenance: { kind: "user_edit", sourceId: "aiden-cli" } });
  await legacy.close();

  const sharedDir = path.join(root, "shared");
  // First open with NO remap: the cli-* rows are preserved under their own scope.
  const first = new MemoryStore({
    root: () => sharedDir,
    imports: async () => [{ file: legacyFile }],
  });
  assert.deepEqual((await first.list(cliScope)).map(({ text }) => text), ["Folder B fact"]);
  await first.close();

  // Reopening with the scope now mapped must re-import under the canonical
  // ws-* scope despite the earlier import markers.
  const wsScope = { kind: "workspace" as const, id: sharedWorkspaceScopeId(folder) };
  const second = new MemoryStore({
    root: () => sharedDir,
    imports: async () => [{ file: legacyFile, scopeIds: { [cliScope.id]: wsScope.id } }],
  });
  assert.deepEqual((await second.list(wsScope)).map(({ text }) => text), ["Folder B fact"]);
  await second.close();
});

test("a corrupt or invalid legacy row is skipped without poisoning the import", async (t) => {
  const root = await fixture(t);
  const legacyFile = path.join(root, "loose.sqlite");
  // Build a schema-divergent legacy file with rows no valid store would write.
  const { DatabaseSync } = await import("node:sqlite");
  const loose = new DatabaseSync(legacyFile);
  loose.exec(`
    CREATE TABLE memory_facts (
      id TEXT PRIMARY KEY, scope_kind TEXT, scope_id TEXT, normalized_text TEXT,
      provenance_kind TEXT, source_id TEXT, source_chat_id TEXT, source_message_id TEXT,
      created_at INTEGER, updated_at INTEGER, confidence REAL, expires_at INTEGER,
      review_state TEXT, state TEXT, supersedes_id TEXT, always_on INTEGER
    );
    INSERT INTO memory_facts VALUES (
      'good-1', 'workspace', 'ws-a', 'valid fact', 'user_edit', 'aiden', NULL, NULL,
      1, 1, 0.5, NULL, 'approved', 'active', NULL, 0
    );
    INSERT INTO memory_facts VALUES (
      'bad id with spaces', 'workspace', 'ws-a', 'unremovable id', 'user_edit', 'aiden', NULL, NULL,
      1, 1, 0.5, NULL, 'approved', 'active', NULL, 0
    );
    INSERT INTO memory_facts VALUES (
      'bad-2', 'workspace', 'ws-a', 'sk-ant-api03-AAAAAAAABBBBBBBBCCCCCCCC', 'user_edit', 'aiden', NULL, NULL,
      1, 1, 0.5, NULL, 'approved', 'active', NULL, 0
    );
    INSERT INTO memory_facts VALUES (
      'bad-3', 'workspace', 'ws-a', 'nine lives', 'nonsense_kind', NULL, NULL, NULL,
      1, 1, 9.9, NULL, 'approved', 'active', NULL, 0
    );
  `);
  loose.close();

  const shared = new MemoryStore({
    root: () => path.join(root, "shared"),
    imports: async () => [{ file: legacyFile }],
  });
  const scope: MemoryScope = { kind: "workspace", id: "ws-a" };
  // Only the valid row lands; the store stays usable afterwards.
  assert.deepEqual((await shared.list(scope)).map(({ text }) => text), ["valid fact"]);
  await shared.put({ scope, text: "post-import write works", provenance: { kind: "user_edit", sourceId: "aiden" } });
  assert.equal((await shared.list(scope)).length, 2);
  await shared.close();
});

test("a cross-kind scope alias is skipped instead of corrupting scoping", async (t) => {
  const root = await fixture(t);
  const scope: MemoryScope = { kind: "workspace", id: "workspace-x" };
  const store = new MemoryStore({ root: () => root, now: () => 1_000 });
  await store.put({ scope, text: "workspace fact", provenance: { kind: "user_edit", sourceId: "aiden" } });
  await store.close();

  const migrated = new MemoryStore({
    root: () => root,
    scopeAliases: async () => [{ from: scope, to: { kind: "bot", id: "bot-y" } }],
  });
  // No workspace rows may appear under a bot scope.
  assert.equal((await migrated.list({ kind: "bot", id: "bot-y" })).length, 0);
  await migrated.close();
});

test("two surfaces can write to the shared store concurrently", async (t) => {
  const root = await fixture(t);
  const scope: MemoryScope = { kind: "workspace", id: "ws-shared" };
  const a = new MemoryStore({ root: () => root, now: () => 1_000 });
  const b = new MemoryStore({ root: () => root, now: () => 2_000 });
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([
    a.put({ scope, text: "from surface A", provenance: { kind: "user_edit", sourceId: "aiden" } }),
    b.put({ scope, text: "from surface B", provenance: { kind: "user_edit", sourceId: "aiden-cli" } }),
  ]);
  assert.deepEqual(
    (await a.list(scope)).map(({ text }) => text).sort(),
    ["from surface A", "from surface B"],
  );
});
