import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeLegacyPiSession } from "./pi-legacy-session.js";
import {
  migratePiSessionJournal,
  rollbackPiSessionMigration,
} from "./pi-session-migration.js";

const fixtures = path.resolve("main/services/fixtures/pi-legacy");

async function withJournal(
  fixture: string,
  operation: (journalPath: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-migration-"));
  const journalPath = path.join(temporary, fixture);
  try {
    await writeFile(journalPath, await readFile(path.join(fixtures, fixture)), { mode: 0o600 });
    await operation(journalPath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("migration atomically promotes repeated checkpoints and preserves owner-only rollback data", async () => {
  await withJournal("repeated-split-turn.jsonl", async (journalPath) => {
    const source = await readFile(journalPath);
    const result = await migratePiSessionJournal(journalPath, "fixture-repeated");
    const header = JSON.parse((await readFile(journalPath, "utf8")).split("\n")[0]!);
    assert.deepEqual(
      { kind: header.kind, version: header.version, id: header.id },
      { kind: "header", version: 4, id: "fixture-repeated" },
    );
    assert.equal(result.receipt.counts.compactions, 2);
    assert.equal(result.receipt.counts.abandonedEntries, 2);
    assert.deepEqual(await readFile(result.receipt.backupPath), source);
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.receipt.backupPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(result.receiptPath, "utf8"), /toolCall|summary|content/u);

    const repeated = await migratePiSessionJournal(journalPath, "fixture-repeated");
    assert.deepEqual(repeated.receipt, result.receipt);

    const promoted = await readFile(journalPath, "utf8");
    const alteredLines = promoted.split("\n");
    const alteredHeader = JSON.parse(alteredLines[0]!);
    alteredHeader.metadata = { ...alteredHeader.metadata, chatId: "different-chat" };
    alteredLines[0] = JSON.stringify(alteredHeader);
    await writeFile(journalPath, alteredLines.join("\n"), { mode: 0o600 });
    await assert.rejects(
      migratePiSessionJournal(journalPath, "fixture-repeated"),
      /immutable session metadata/u,
    );
    await writeFile(journalPath, promoted, { mode: 0o600 });

    const rollbackArtifact = await rollbackPiSessionMigration(result.receipt);
    const rollbackEvidence = await readFile(rollbackArtifact);
    assert.deepEqual(await readFile(journalPath), source);
    assert.equal(decodeLegacyPiSession(await readFile(journalPath, "utf8")).header.version, 3);
    assert.equal((await stat(rollbackArtifact)).mode & 0o777, 0o600);
    await assert.rejects(stat(result.receiptPath), /ENOENT/u);
    assert.equal(await rollbackPiSessionMigration(result.receipt), rollbackArtifact);
    assert.deepEqual(await readFile(rollbackArtifact), rollbackEvidence);
  });
});

test("migration recovers a promoted journal whose receipt write was interrupted", async () => {
  await withJournal("uncompacted.jsonl", async (journalPath) => {
    const first = await migratePiSessionJournal(journalPath, "fixture-uncompacted");
    await unlink(first.receiptPath);
    const recovered = await migratePiSessionJournal(journalPath, "fixture-uncompacted");
    assert.equal(recovered.receipt.sourceSha256, first.receipt.sourceSha256);
    assert.equal(
      JSON.parse((await readFile(journalPath, "utf8")).split("\n")[0]!).version,
      4,
    );
  });
});

test("migration rejects stale receipts and non-private rollback backups", async () => {
  await withJournal("uncompacted.jsonl", async (journalPath) => {
    const result = await migratePiSessionJournal(journalPath, "fixture-uncompacted");
    const receiptBytes = await readFile(result.receiptPath);
    await rollbackPiSessionMigration(result.receipt);
    await writeFile(result.receiptPath, receiptBytes, { mode: 0o600 });
    await assert.rejects(
      migratePiSessionJournal(journalPath, "fixture-uncompacted"),
      /not a header|unsupported session version/u,
    );
    assert.equal(decodeLegacyPiSession(await readFile(journalPath, "utf8")).header.version, 3);
    await unlink(result.receiptPath);
    await chmod(result.receipt.backupPath, 0o644);
    await assert.rejects(
      migratePiSessionJournal(journalPath, "fixture-uncompacted"),
      /private regular file/u,
    );
  });
});

test("migration accepts a torn final append but backup retains exact source bytes", async () => {
  await withJournal("torn-tail.jsonl", async (journalPath) => {
    const before = await readFile(journalPath);
    const result = await migratePiSessionJournal(journalPath, "fixture-torn");
    assert.deepEqual(await readFile(result.receipt.backupPath), before);
    assert.equal(
      JSON.parse((await readFile(journalPath, "utf8")).split("\n")[0]!).version,
      4,
    );
  });
});

test("migration fails closed without changing a structurally invalid journal", async () => {
  await withJournal("corrupt-parent.jsonl", async (journalPath) => {
    const before = await readFile(journalPath);
    await assert.rejects(migratePiSessionJournal(journalPath, "chat-corrupt"), /missing parent/u);
    assert.deepEqual(await readFile(journalPath), before);
  });
});

test("randomized repeated checkpoint chains retain valid v4 context", async () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-migration-fuzz-"));
    const journalPath = path.join(temporary, `random-${seed}.jsonl`);
    try {
      const chatId = `random-${seed}`;
      const lines: Array<Record<string, unknown>> = [
        {
          type: "session",
          version: 3,
          id: chatId,
          timestamp: "2026-08-31T00:00:00.000Z",
          cwd: temporary,
          metadata: { kind: "aiden-chat-compaction-v1", chatId },
        },
      ];
      let parentId: string | null = null;
      for (let index = 0; index < 3 + (seed % 8); index += 1) {
        const messageId = `m-${index}`;
        lines.push({
          type: "message",
          id: messageId,
          parentId,
          timestamp: new Date(Date.UTC(2026, 7, 31, 0, 0, index + 1)).toISOString(),
          message: { role: "user", content: `message-${index}`, timestamp: index + 1 },
        });
        parentId = messageId;
        if (index > 0 && (index + seed) % 3 === 0) {
          const checkpointId = `cp-${index}`;
          lines.push({
            type: "compaction",
            id: checkpointId,
            parentId,
            timestamp: new Date(Date.UTC(2026, 7, 31, 0, 1, index)).toISOString(),
            summary: `checkpoint-${index}`,
            firstKeptEntryId: messageId,
            tokensBefore: 100 + index,
          });
          parentId = checkpointId;
        }
      }
      await writeFile(
        journalPath,
        `${lines.map((value) => JSON.stringify(value)).join("\n")}\n`,
        { mode: 0o600 },
      );
      const result = await migratePiSessionJournal(journalPath, chatId);
      assert.equal(result.receipt.validation, "passed");
      assert.equal(
        JSON.parse((await readFile(journalPath, "utf8")).split("\n")[0]!).version,
        4,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
