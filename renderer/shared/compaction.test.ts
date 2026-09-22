import assert from "node:assert/strict";
import test from "node:test";
import { compactionEngineFrom, isCompactionEngine } from "./compaction.js";
import { SLASH_COMMANDS } from "./slash-commands.js";
import { rankSlashResults } from "../lib/slash-command-core.js";
import { executeSlashCommandAction } from "../lib/slash-command-actions.js";

test("missing and invalid preferences use LLM; commands override once", async () => {
  for (const value of [undefined, null, "unknown", 1, {}])
    assert.equal(compactionEngineFrom(value), "llm");
  assert.equal(compactionEngineFrom("vcc"), "vcc");
  assert.equal(isCompactionEngine("VCC"), false);
  for (const [name, engine] of [
    ["compact", undefined],
    ["compact-LLM", "llm"],
    ["compact-VCC", "vcc"],
  ] as const) {
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === name)!;
    assert.equal(command.draftPolicy, "preserve");
    assert.equal(command.availability, "idle-chat-session");
    let received: unknown = "not-called";
    await executeSlashCommandAction(command, "", {
      executeCommand: () => false,
      openSettings: () => {},
      requestRename: () => {},
      copyLatestResponse: () => {},
      openReview: () => {},
      openAccess: () => {},
      compactChat: (value) => {
        received = value;
      },
    });
    assert.equal(received, engine);
  }
});

test("engine commands are found case-insensitively", () => {
  for (const query of ["compact-vcc", "COMPACT-VCC", "compact-VcC"]) {
    const first = rankSlashResults(query, [], "command").results[0];
    assert.ok(first.kind === "command");
    assert.equal(first.command.name, "compact-VCC");
  }
});
