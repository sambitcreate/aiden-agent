import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { createPiSessionPort } from "./pi-session-port.js";
import { parsePiSessionMigrationReceipt } from "./pi-session-migration.js";

test("current Pi session port preserves journal context and rollback behavior", async () => {
  const native = await new InMemorySessionRepo().create({ id: "port-test" });
  const port = createPiSessionPort(native);
  await port.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const leaf = await port.getLeafId();
  await port.appendMessage({ role: "user", content: "second", timestamp: 2 });
  await port.moveTo(leaf);

  assert.deepEqual(
    (await port.buildContext()).messages.map((message) =>
      "content" in message ? message.content : undefined,
    ),
    ["first"],
  );
  assert.equal((await port.getEntries()).length, 2);
});

test("entry-projector views do not expose a native Pi session", async () => {
  const native = await new InMemorySessionRepo().create({ id: "projector-port-test" });
  const port = createPiSessionPort(native);
  await port.appendCustomEntry("plugin.note.v1", "remember");
  const projected = port.withEntryProjectors({
    "plugin.note.v1": (entry) => [
      { role: "user", content: `Projected: ${String(entry.data)}`, timestamp: 1 },
    ],
  });
  assert.match(JSON.stringify(await projected.buildContext()), /Projected: remember/u);
  assert.equal("getStorage" in projected, false);
  assert.equal(Object.getOwnPropertyNames(projected).includes("session"), false);
  assert.doesNotMatch(JSON.stringify(projected), /projector-port-test/u);
});

test("migration receipt parser accepts metadata and rejects transcript-shaped fields", () => {
  const value = {
    version: 1,
    chatId: "chat-1",
    oldFormat: "pi-session-v3",
    newFormat: "pi-session-v4",
    sourceSha256: "a".repeat(64),
    promotedPath: "/private/new.jsonl",
    backupPath: "/private/old.jsonl.backup",
    counts: { entries: 5, messages: 2, compactions: 1, customEntries: 2, abandonedEntries: 0 },
    validation: "passed",
    createdAt: "2026-08-31T12:00:00.000Z",
  };
  assert.deepEqual(parsePiSessionMigrationReceipt(value), value);
  assert.throws(
    () => parsePiSessionMigrationReceipt({ ...value, transcript: "private" }),
    /Invalid/u,
  );
  assert.throws(
    () =>
      parsePiSessionMigrationReceipt({
        ...value,
        counts: { ...value.counts, entries: 1, messages: 2 },
      }),
    /Invalid/u,
  );
  assert.throws(
    () =>
      parsePiSessionMigrationReceipt({
        ...value,
        counts: { ...value.counts, abandonedEntries: value.counts.entries + 1 },
      }),
    /Invalid/u,
  );
  assert.throws(
    () => parsePiSessionMigrationReceipt({ ...value, newFormat: value.oldFormat }),
    /Invalid/u,
  );
  assert.throws(
    () => parsePiSessionMigrationReceipt({ ...value, backupPath: value.promotedPath }),
    /Invalid/u,
  );
});
