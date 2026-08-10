import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  AIDEN_CHAT_EXPORT_VERSION,
  projectAidenChatExport,
  safeExportFileName,
  writeAidenChatExport,
  writeAidenChatExportForRenderer,
} from "./chat-export.js";
import type { Chat } from "./types.js";
import { jsonStringBytesBounded } from "./json-representation.js";

const chat: Chat = {
  id: "private-storage-id",
  title: "Review: phase/four?",
  workspaceId: "workspace-one",
  providerId: "provider-one",
  model: "model-one",
  createdAt: 10,
  updatedAt: 20,
  messages: [
    { id: "system", role: "system", content: "PRIVATE SYSTEM", createdAt: 1 },
    {
      id: "user",
      role: "user",
      content: "Review this",
      createdAt: 2,
      skill: { version: 1, name: "Review", source: "configured" },
    },
    {
      id: "assistant",
      role: "assistant",
      content: "Visible answer",
      reasoning: "PRIVATE REASONING",
      timeline: {
        version: 2,
        generationId: "generation-private",
        status: "completed",
        startedAt: 2,
        finishedAt: 3,
        steps: [],
      },
      createdAt: 3,
    },
  ],
};

test("Aiden export is versioned and projects only visible linear chat fields", () => {
  const projected = projectAidenChatExport(chat, "2026-08-09T00:00:00.000Z");
  assert.equal(projected.schema, "aiden.chat.export");
  assert.equal(projected.version, AIDEN_CHAT_EXPORT_VERSION);
  assert.equal(projected.chat.messages.length, 2);
  assert.deepEqual(
    projected.chat.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /PRIVATE SYSTEM|PRIVATE REASONING|timeline|subagents/u);
  assert.doesNotMatch(serialized, /private-storage-id/u);
  assert.match(serialized, /"skill":\{"version":1,"name":"Review","source":"configured"\}/u);
});

test("Aiden export writes one owner-only JSON file through a same-directory stage", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-export-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, safeExportFileName(chat.title));
  await writeAidenChatExport(target, chat);
  const parsed = JSON.parse(await fs.readFile(target, "utf8")) as { version: number };
  const serialized = await fs.readFile(target, "utf8");
  assert.equal(parsed.version, 1);
  assert.doesNotMatch(serialized, /PRIVATE REASONING|timeline|subagents/u);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), [path.basename(target)]);
  assert.equal(path.basename(target), "Review phase four.aiden-chat.json");
});

test("export rejects malformed visible fields and counts JSON escaping exactly", () => {
  const malformed = {
    ...chat,
    messages: [
      {
        id: "bad",
        role: "user",
        content: "visible",
        createdAt: { reasoning: "PRIVATE" },
      },
    ],
  } as unknown as Chat;
  assert.throws(() => projectAidenChatExport(malformed), /timestamp/iu);

  for (const sample of ["plain", "\0\n\"\\", "\ud800", "😀"]) {
    assert.equal(
      jsonStringBytesBounded(sample, Number.MAX_SAFE_INTEGER),
      Buffer.byteLength(JSON.stringify(sample), "utf8"),
    );
  }
  assert.equal(
    safeExportFileName(`${" ".repeat(639)}😀`),
    "😀.aiden-chat.json",
  );
});

test("renderer-facing export failures never reveal the main-owned save path", async () => {
  const target = "/definitely-missing-aiden-parent/private/export.aiden-chat.json";
  await assert.rejects(
    writeAidenChatExportForRenderer(target, chat),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Aiden could not write the exported chat." &&
      !error.message.includes(target),
  );
});
