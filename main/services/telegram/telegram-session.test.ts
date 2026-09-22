import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { CompactChatResult } from "../context-lifecycle-service.js";
import { telegramCompactionResult } from "./telegram-session.js";

test("Telegram compaction presents every closed lifecycle result without owning policy", () => {
  const reasons: Array<Exclude<CompactChatResult, { compacted: true }>['reason']> = [
    "already_compact",
    "busy",
    "archived",
    "not_canonical",
    "provider_unavailable",
    "context_metadata_invalid",
    "cancelled",
    "compaction_failed",
  ];

  for (const reason of reasons) {
    const result = telegramCompactionResult({ compacted: false, reason });
    assert.equal(result.compacted, false);
    assert.ok(result.error);
  }
  assert.deepEqual(
    telegramCompactionResult({ compacted: true, tokensBefore: 100, estimatedTokensAfter: 20 }),
    { compacted: true, tokensBefore: 100, estimatedTokensAfter: 20 },
  );
});

test("Telegram manual compaction uses the production shared-lifecycle adapter", async () => {
  const service = await readFile(new URL("./telegram-service.ts", import.meta.url), "utf8");

  assert.match(
    service,
    /createTelegramLifecycleAdapter\(contextLifecycleService, profile\)/u,
  );
  assert.match(service, /compactChat: lifecycle\.compactChat/u);
  assert.match(service, /lifecycle\.cancelChat\(chatId\)/u);
  assert.doesNotMatch(service, /openSession|resolveRuntime|PiCompactionCoordinator/u);
});
