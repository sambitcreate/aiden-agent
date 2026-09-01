import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  projectAidenMemoryExport,
  safeMemoryExportFileName,
  writeAidenMemoryExport,
} from "./memory-export.js";
import type { MemoryFact } from "./memory-store.js";

const fact: MemoryFact = {
  id: "fact-a",
  scope: { kind: "workspace", id: "workspace-a" },
  text: "Prefer concise release notes.",
  provenance: { kind: "chat_message", chatId: "chat-a", messageId: "message-a" },
  createdAt: 1,
  updatedAt: 2,
  confidence: 1,
  reviewState: "approved",
  state: "active",
  alwaysOn: true,
};

test("memory export preserves exact scope, provenance, and fact lifecycle", () => {
  const projected = projectAidenMemoryExport(fact.scope, [fact], "2026-08-31T00:00:00.000Z");
  assert.equal(projected.schema, "aiden.memory.export");
  assert.deepEqual(projected.scope, fact.scope);
  assert.deepEqual(projected.facts, [fact]);
  assert.deepEqual(projected.facts[0]?.provenance, fact.provenance);
  assert.equal(safeMemoryExportFileName({ kind: "bot", id: "bot/a" }), "bot-bot-a.aiden-memory.json");
});

test("memory export writes a private, complete JSON file atomically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-memory-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "memory.json");
  await writeAidenMemoryExport(target, fact.scope, [fact]);
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
  assert.equal(value.schema, "aiden.memory.export");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});
