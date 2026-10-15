import assert from "node:assert/strict";
import test from "node:test";
import { compactionEngineFrom, isCompactionEngine, parseCompactionModelOverrides, resolveCompactionModelBudget } from "./compaction.js";
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


test("model budgets validate and snapshot exact model identities", () => {
  const input = { "provider/model/v2": { reserveTokens: 8_000, keepRecentTokens: 0 } };
  const overrides = parseCompactionModelOverrides(input);
  input["provider/model/v2"].reserveTokens = 500;
  assert.equal(overrides["provider/model/v2"].reserveTokens, 8_000);
  assert.equal(resolveCompactionModelBudget(overrides, { provider: "other", id: "model/v2", contextWindow: 128_000 }), undefined);
  assert.deepEqual(resolveCompactionModelBudget(overrides, { provider: "provider", id: "model/v2", contextWindow: 128_000 }), { reserveTokens: 8_000, keepRecentTokens: 0 });
  for (const invalid of [null, [], { model: {} }, { "provider/model": { reserveTokens: 1 } }, { "provider/model": { keepRecentTokens: -1 } }, { "provider/model": { reserveTokens: 1.5 } }, { "provider/model": { reserveTokens: Infinity } }, { "provider/model": { enabled: false } }]) {
    assert.throws(() => parseCompactionModelOverrides(invalid));
  }
});

test("partial model budgets inherit defaults and bound impossible model windows", () => {
  assert.equal(resolveCompactionModelBudget(parseCompactionModelOverrides({ "p/m": {} }), { provider: "p", id: "m", contextWindow: 128_000 }), undefined);
  const overrides = parseCompactionModelOverrides({ "p/m": { reserveTokens: 64_000 } });
  assert.deepEqual(resolveCompactionModelBudget(overrides, { provider: "p", id: "m", contextWindow: 128_000 }), { reserveTokens: 64_000, keepRecentTokens: 20_000 });
  assert.deepEqual(resolveCompactionModelBudget(overrides, { provider: "p", id: "m", contextWindow: 8_000 }), { reserveTokens: 2_000, keepRecentTokens: 3_000 });
  assert.deepEqual(resolveCompactionModelBudget(overrides, { provider: "p", id: "m", contextWindow: 128_000 }, "vcc"), { reserveTokens: 32_000, keepRecentTokens: 20_000 });
});
