import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildLegacyPiContext,
  buildLegacyPiContextState,
  buildProjectedPiV4Context,
  decodeLegacyPiSession,
  projectLegacyPiMigration,
  verifyLegacyPiMigrationFile,
} from "./pi-legacy-session.js";
import { projectMessagesForModel } from "./generation-context.js";

const fixtures = path.resolve("main/services/fixtures/pi-legacy");

test("frozen legacy decoder reconstructs uncompacted and repeated checkpoints", async () => {
  for (const name of ["uncompacted.jsonl", "repeated-split-turn.jsonl"]) {
    const filePath = path.join(fixtures, name);
    const contents = await readFile(filePath, "utf8");
    const decoded = decodeLegacyPiSession(contents);
    const messages = buildLegacyPiContext(decoded);
    const context = buildLegacyPiContextState(decoded);
    assert.deepEqual(context.messages, messages, name);
    assert.deepEqual(buildLegacyPiContextState(decodeLegacyPiSession(contents)), context, name);
  }
});

test("legacy projection materializes retained tails and preserves complete target context", async () => {
  const decoded = decodeLegacyPiSession(
    await readFile(path.join(fixtures, "repeated-split-turn.jsonl"), "utf8"),
  );
  const projection = projectLegacyPiMigration(decoded);
  assert.deepEqual(projection.targetContext, projection.sourceContext);
  const checkpoints = projection.entries.filter((entry) => entry.type === "compaction");
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(
    checkpoints.map((entry) =>
      "retainedTail" in entry
        ? (entry as unknown as { retainedTail: Array<{ role: string }> }).retainedTail.map(
            (retained) => retained.role,
          )
        : [],
    ),
    [
      ["assistant", "toolResult", "user"],
      ["assistant", "toolResult"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(checkpoints), /aiden\.pi-transaction/u);
  assert.ok(projection.entries.some((entry) => entry.id === "abandoned"));

  const corrupted = structuredClone(projection.entries);
  const latest = [...corrupted].reverse().find((entry) => entry.type === "compaction");
  assert.ok(latest && "retainedTail" in latest);
  (latest.retainedTail as Array<{ role: string }>).pop();
  assert.notDeepEqual(
    buildProjectedPiV4Context(corrupted, decoded.leafId),
    projection.sourceContext,
  );
});

test("surface binding fixture freezes canonical Bot sharing and isolated ordinary/child contexts", async () => {
  const bindings = JSON.parse(
    await readFile(path.join(fixtures, "surface-bindings.json"), "utf8"),
  ) as Array<{
    surface: string;
    chatId: string;
    providerId: string;
    model: string;
    scope: string;
  }>;
  const bySurface = new Map(bindings.map((binding) => [binding.surface, binding]));
  assert.deepEqual(bySurface.get("telegram-bot"), {
    ...bySurface.get("bot-mac"),
    surface: "telegram-bot",
  });
  assert.notEqual(
    bySurface.get("telegram-ordinary")?.chatId,
    bySurface.get("telegram-bot")?.chatId,
  );
  assert.notEqual(bySurface.get("child")?.scope, bySurface.get("workspace")?.scope);
  assert.equal(bySurface.get("telegram-bot")?.model, "claude-bot");
});

test("golden image context remains model-neutral and projects only at request time", async () => {
  const decoded = decodeLegacyPiSession(
    await readFile(path.join(fixtures, "uncompacted.jsonl"), "utf8"),
  );
  const messages = buildLegacyPiContext(decoded);
  assert.ok(JSON.stringify(projectMessagesForModel(messages, true)).includes('"type":"image"'));
  const textOnly = projectMessagesForModel(messages, false);
  assert.doesNotMatch(JSON.stringify(textOnly), /"type":"image"/u);
  assert.match(JSON.stringify(textOnly), /retained in Aiden's private journal/u);
});

test("migration verifier reports abandoned branches and never mutates its input", async () => {
  const filePath = path.join(fixtures, "repeated-split-turn.jsonl");
  const before = await stat(filePath);
  const first = await verifyLegacyPiMigrationFile(filePath);
  const second = await verifyLegacyPiMigrationFile(filePath);
  const after = await stat(filePath);
  assert.deepEqual(second, first);
  assert.equal(first.compactionCount, 2);
  assert.equal(first.abandonedEntryCount, 2);
  assert.equal(first.validation, "context_parity");
  assert.equal(first.changes.materializedRetainedTailCheckpoints, 2);
  assert.equal(first.changes.preservedAbandonedEntries, 2);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("legacy decoder recognizes a torn final record but rejects structural corruption", async () => {
  const torn = decodeLegacyPiSession(
    await readFile(path.join(fixtures, "torn-tail.jsonl"), "utf8"),
  );
  assert.equal(torn.tornFinalLine, true);
  assert.equal(torn.entries.length, 1);
  await assert.rejects(
    verifyLegacyPiMigrationFile(path.join(fixtures, "corrupt-parent.jsonl")),
    /missing parent/u,
  );
});

test("legacy decoder rejects malformed payloads for every recognized entry shape", () => {
  const header = {
    type: "session",
    version: 3,
    id: "malformed",
    timestamp: "2026-08-31T00:00:00.000Z",
    cwd: "/private",
  };
  const malformed = [
    { type: "message" },
    { type: "message", message: { role: "user", timestamp: 1 } },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 1,
        api: "api",
        provider: "provider",
        model: "model",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call", name: "tool" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        timestamp: 1,
        toolCallId: "call",
        toolName: "tool",
        content: [{ type: "text" }],
        isError: false,
      },
    },
    { type: "thinking_level_change" },
    { type: "model_change", provider: "provider" },
    { type: "active_tools_change", activeToolNames: [1] },
    { type: "compaction", summary: "summary", firstKeptEntryId: "", tokensBefore: 1 },
    { type: "branch_summary", fromId: "entry", summary: 1 },
    { type: "custom" },
    { type: "custom_message", customType: "note", content: {}, display: true },
    { type: "label", targetId: "entry", label: 1 },
    { type: "session_info", name: 1 },
    { type: "leaf", targetId: 1 },
    { type: "future_unknown" },
  ];
  for (const [index, payload] of malformed.entries()) {
    const entry = {
      id: `entry-${index}`,
      parentId: null,
      timestamp: "2026-08-31T00:00:01.000Z",
      ...payload,
    };
    assert.throws(
      () => decodeLegacyPiSession(`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`),
      /invalid or unsupported/u,
      String(payload.type),
    );
  }
});
