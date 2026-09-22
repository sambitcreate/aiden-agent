// Durable chat ↔ pull request store: dedupe, bounds, atomic persistence,
// restart restore, corrupt-file preservation, and deleteChat cleanup.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DataStore } from "./data-store.js";
import { MAX_CHAT_PULL_REQUEST_LINKS } from "../../renderer/shared/chat-pull-requests.js";
import { ChatPullRequestStore } from "./chat-pull-request-store.js";

const REF = { host: "github.com", repository: "owner/repo", number: 12 };

function link(number: number, overrides: Record<string, unknown> = {}) {
  return {
    host: "github.com",
    repository: "owner/repo",
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    source: "manual" as const,
    linkedAt: 1_000 + number,
    ...overrides,
  };
}

test("links deduplicate by (host, repository, number) and keep first linkedAt", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);

  await store.link("chat-1", link(12));
  const relinked = await store.link("chat-1", {
    ...link(12, { linkedAt: 9_999, source: "created" }),
    snapshot: {
      title: "Fresh",
      state: "open",
      headBranch: "b",
      baseBranch: "main",
      syncedAt: 5,
    },
  });
  assert.equal(relinked.linkedAt, 1_012);
  const links = await store.list("chat-1");
  assert.equal(links.length, 1);
  assert.equal(links[0]?.snapshot?.title, "Fresh");
});

test("malformed link input is rejected", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);

  // A bad display URL falls back to the canonical URL; a bad ref rejects.
  await assert.rejects(
    store.link("chat-1", {
      host: "github.com",
      repository: "bad",
      number: 0,
    } as never),
  );
  await assert.rejects(store.link("chat 1/../escape", link(1)));
});

test("link capacity is enforced", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);
  for (let i = 1; i <= MAX_CHAT_PULL_REQUEST_LINKS; i += 1) {
    await store.link("chat-1", link(i));
  }
  await assert.rejects(
    store.link("chat-1", link(MAX_CHAT_PULL_REQUEST_LINKS + 1)),
    /maximum number/u,
  );
});

test("links persist atomically and survive a store restart", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = new ChatPullRequestStore(() => directory);
  await first.link("chat-1", link(12));
  const filePath = path.join(directory, "chat-1.json");
  const contents = JSON.parse(await fs.readFile(filePath, "utf8")) as {
    schemaVersion: number;
    chatId: string;
    links: unknown[];
    pendingCreates: unknown[];
  };
  assert.equal(contents.schemaVersion, 1);
  assert.equal(contents.chatId, "chat-1");
  assert.equal(contents.links.length, 1);
  // No staging leftovers.
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const restarted = new ChatPullRequestStore(() => directory);
  assert.equal((await restarted.list("chat-1")).length, 1);
});

test("a corrupt file reads as empty and is preserved on the next write", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "chat-1.json"), "{ not json", "utf8");

  const store = new ChatPullRequestStore(() => directory);
  assert.deepEqual(await store.list("chat-1"), []);

  await store.link("chat-1", link(3));
  const names = await fs.readdir(directory);
  assert.ok(
    names.some((name) => name.startsWith("chat-1.json.invalid-")),
    "corrupt file was preserved",
  );
  assert.equal((await store.list("chat-1")).length, 1);
});

test("unlink removes only the matching ref and reports missing", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);

  await store.link("chat-1", link(1));
  await store.link("chat-1", link(2));
  assert.equal(await store.unlink("chat-1", REF), false);
  assert.equal(await store.unlink("chat-1", { ...REF, number: 1 }), true);
  assert.deepEqual(
    (await store.list("chat-1")).map((entry) => entry.number),
    [2],
  );
});

test("create intents persist, cap, and clear", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);

  const intent = {
    operationId: "op-1",
    host: "github.com",
    repository: "owner/repo",
    headBranch: "feature/x",
    baseBranch: "main",
    expectedHeadSha: "a".repeat(40),
    title: "Add x",
    requestedAt: 1_700,
  };
  await store.recordCreateIntent("chat-1", intent);
  assert.deepEqual(await store.listCreateIntents("chat-1"), [intent]);

  await store.clearCreateIntent("chat-1", "op-1");
  assert.deepEqual(await store.listCreateIntents("chat-1"), []);

  await assert.rejects(
    store.recordCreateIntent("chat-1", { ...intent, operationId: "bad id" }),
  );
});

test("pending intents are never evicted — capacity rejects the new intent", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);
  const intent = {
    operationId: "op-0",
    host: "github.com",
    repository: "owner/repo",
    headBranch: "feature/x",
    baseBranch: "main",
    title: "Add x",
    requestedAt: 1_700,
  };
  for (let index = 0; index < 16; index += 1) {
    await store.recordCreateIntent("chat-1", {
      ...intent,
      operationId: `op-${index}`,
      headBranch: `feature/${index}`,
    });
  }
  await assert.rejects(
    store.recordCreateIntent("chat-1", { ...intent, operationId: "op-16" }),
    /unresolved pull request creations/u,
  );
  assert.equal((await store.listCreateIntents("chat-1")).length, 16);
});

test("deleteChat removes the file and never requires GitHub", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);

  await store.link("chat-1", link(1));
  await store.deleteChat("chat-1");
  assert.deepEqual(await fs.readdir(directory), []);
  await store.deleteChat("chat-1"); // idempotent
});

test("a file with foreign chatId or wrong schema is not adopted", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "chat-1.json"),
    JSON.stringify({ schemaVersion: 1, chatId: "other", links: [link(1)] }),
    "utf8",
  );
  const store = new ChatPullRequestStore(() => directory);
  assert.deepEqual(await store.list("chat-1"), []);
});

test("created link and settled intent publish together and cannot reappear after unlink", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);
  await store.recordCreateIntent("chat-1", {
    operationId: "op",
    host: "github.com",
    repository: "owner/repo",
    headBranch: "feature/x",
    baseBranch: "main",
    title: "Title",
    requestedAt: 1700,
  });
  await store.link("chat-1", link(12), "op");
  const restarted = new ChatPullRequestStore(() => directory);
  assert.equal((await restarted.list("chat-1")).length, 1);
  assert.deepEqual(await restarted.listCreateIntents("chat-1"), []);
  await restarted.unlink("chat-1", link(12));
  const again = new ChatPullRequestStore(() => directory);
  assert.deepEqual(await again.list("chat-1"), []);
  assert.equal((await again.listDismissed("chat-1")).length, 1);
});

test("stale create completion cannot resurrect an explicitly unlinked PR", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);
  await store.recordCreateIntent("chat-1", {
    operationId: "op",
    host: "github.com",
    repository: "owner/repo",
    headBranch: "feature/x",
    baseBranch: "main",
    title: "Title",
    requestedAt: 1700,
  });
  await store.link("chat-1", link(12), "op");
  await store.unlink("chat-1", link(12));
  await assert.rejects(
    store.link("chat-1", link(12), "op"),
    /no longer pending/,
  );
  assert.deepEqual(await store.list("chat-1"), []);
  assert.equal(
    (await new ChatPullRequestStore(() => directory).listDismissed("chat-1"))
      .length,
    1,
  );
});

test("future schema and malformed pending expectations stay write-protected", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const payload of [
    {
      schemaVersion: 2,
      chatId: "chat-1",
      links: [link(1)],
      pendingCreates: [],
    },
    {
      schemaVersion: 1,
      chatId: "chat-1",
      links: [],
      pendingCreates: [
        {
          operationId: "op",
          host: "github.com",
          repository: "owner/repo",
          headBranch: "feature/x",
          baseBranch: "main",
          title: "Title",
          requestedAt: 1700,
          expectedHeadSha: "invalid",
        },
      ],
    },
  ]) {
    const bytes = JSON.stringify(payload);
    const file = path.join(directory, "chat-1.json");
    await fs.writeFile(file, bytes);
    const store = new ChatPullRequestStore(() => directory);
    assert.deepEqual(await store.list("chat-1"), []);
    await assert.rejects(store.link("chat-1", link(2)));
    assert.equal(await fs.readFile(file, "utf8"), bytes);
  }
});

test("oversized or duplicate pending intent inventories preserve every byte", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intent = {
    operationId: "op",
    host: "github.com",
    repository: "owner/repo",
    headBranch: "feature/x",
    baseBranch: "main",
    title: "Title",
    requestedAt: 1700,
  };
  for (const pendingCreates of [
    Array.from({ length: 17 }, (_, i) => ({
      ...intent,
      operationId: `op-${i}`,
    })),
    [intent, { ...intent, headBranch: "other" }],
  ]) {
    const file = path.join(directory, "chat-1.json");
    const bytes = JSON.stringify({
      schemaVersion: 1,
      chatId: "chat-1",
      links: [],
      pendingCreates,
    });
    await fs.writeFile(file, bytes);
    const store = new ChatPullRequestStore(() => directory);
    await assert.rejects(store.link("chat-1", link(1)));
    assert.equal(await fs.readFile(file, "utf8"), bytes);
  }
});

test("deletion drains admitted writes and rejects every later write", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatPullRequestStore(() => directory);
  const linking = store.link("chat-1", link(1));
  const rejected = assert.rejects(linking);
  await store.deleteChat("chat-1");
  await rejected;
  await assert.rejects(store.link("chat-1", link(2)), /deleted/);
  await assert.rejects(store.clearCreateIntent("chat-1", "op"), /deleted/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("deletion waits for a read that is recovering a held PR file", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-chat-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, ".chat-1.json.recovery.held"),
    JSON.stringify({
      schemaVersion: 1,
      chatId: "chat-1",
      links: [link(12)],
      pendingCreates: [],
    }),
  );
  const prototype = DataStore.prototype as unknown as {
    recoverHeldFiles(destination: string): Promise<void>;
  };
  const recover = prototype.recoverHeldFiles;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(
    prototype,
    "recoverHeldFiles",
    async function (this: typeof prototype, destination: string) {
      entered();
      await blocked;
      return recover.call(this, destination);
    },
  );
  const store = new ChatPullRequestStore(() => directory);
  const reading = store.list("chat-1");
  await started;
  let deleted = false;
  const deletion = store.deleteChat("chat-1").then(() => {
    deleted = true;
  });
  // The broken barrier completes here while recovery is held. The fixed
  // deletion stays pending until the recovery is released.
  await Promise.race([deletion, delay(100)]);
  const completedBeforeRecovery = deleted;
  release();
  await Promise.all([reading, deletion]);
  assert.equal(completedBeforeRecovery, false);
  await assert.rejects(fs.stat(path.join(directory, "chat-1.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(await fs.readdir(directory), []);
});
