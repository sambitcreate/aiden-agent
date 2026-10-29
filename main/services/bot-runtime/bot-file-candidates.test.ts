import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createBotOwnWrites } from "../bot-routine-events/own-writes.js";
import { botFileCandidates } from "./bot-file-candidates.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import type { BotToolCall } from "./tool-adapter.js";

const BOT = "bot-1";

async function folder(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-file-candidates-")));
}

function call(requestIds: readonly (string | undefined)[]): BotToolCall {
  return { runRequestIds: async () => requestIds } as unknown as BotToolCall;
}

async function write(candidates: BotToolCandidate[], requestIds: readonly (string | undefined)[], file: string) {
  const candidate = candidates.find(({ tool }) => tool.name === "write_file");
  assert.ok(candidate?.bind);
  await candidate.bind(call(requestIds)).execute("w", { path: file, content: "out" });
}

test("a routine run's file writes are journaled even though the registry built the attended tools", async () => {
  const root = await folder();
  try {
    const journal = createBotOwnWrites();
    const since = Date.now();
    // As production builds them: without a turn, so not a routine build.
    const candidates = botFileCandidates([{ id: "home", label: "Bot folder", root }], {
      routine: false,
      recordOwnWrite: (written) => journal.record(BOT, written),
    });

    await write(candidates, ["routine:r1:event:e1"], "report.md");
    await write(candidates, ["chat:1"], "notes.md");
    await write(candidates, ["tg:7"], "telegram.md");

    assert.equal(await fs.readFile(path.join(root, "report.md"), "utf8"), "out");
    assert.equal(journal.wroteSince(BOT, path.join(root, "report.md"), since), true);
    assert.equal(journal.wroteSince(BOT, path.join(root, "notes.md"), since), false);
    assert.equal(journal.wroteSince(BOT, path.join(root, "telegram.md"), since), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
