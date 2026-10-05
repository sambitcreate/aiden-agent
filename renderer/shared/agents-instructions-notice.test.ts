import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsInstructionNoticeMessage,
  createAgentsInstructionNoticeLog,
  parseAgentsInstructionNotice,
} from "./agents-instructions-notice.js";

test("notice copy names the file, its size and what Aiden did", () => {
  assert.equal(
    agentsInstructionNoticeMessage({ scope: "workspace", kind: "truncated", sizeBytes: 51_991, limitBytes: 16_384 }),
    "This workspace's AGENTS.md is 51 KB, over the 16 KB limit. Aiden is using the first 16 KB.",
  );
  assert.equal(
    agentsInstructionNoticeMessage({ scope: "global", kind: "skipped", sizeBytes: 600 * 1024, limitBytes: 16_384 }),
    "Your global AGENTS.md is 600 KB, too large to read. Aiden is responding without it.",
  );
});

test("only well-formed notices cross the IPC boundary", () => {
  const notice = { scope: "workspace", kind: "truncated", sizeBytes: 20_000, limitBytes: 16_384 };
  assert.deepEqual(parseAgentsInstructionNotice({ ...notice, extra: "dropped" }), notice);
  for (const bad of [
    null,
    [],
    { ...notice, scope: "bot" },
    { ...notice, kind: "failed" },
    { ...notice, sizeBytes: -1 },
    { ...notice, limitBytes: 0 },
    { ...notice, sizeBytes: 1.5 },
  ]) {
    assert.equal(parseAgentsInstructionNotice(bad), undefined);
  }
});

test("each chat announces a notice once until the file changes", () => {
  const log = createAgentsInstructionNoticeLog();
  const notice = { scope: "workspace", kind: "truncated", sizeBytes: 20_000, limitBytes: 16_384 } as const;
  assert.equal(log.shouldAnnounce("chat-1", notice), true);
  assert.equal(log.shouldAnnounce("chat-1", notice), false);
  assert.equal(log.shouldAnnounce("chat-2", notice), true);
  assert.equal(log.shouldAnnounce("chat-1", { ...notice, sizeBytes: 21_000 }), true);
  assert.equal(log.shouldAnnounce("chat-1", { ...notice, scope: "global" }), true);
});
