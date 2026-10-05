import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsInstructionNoticeMessage,
  createAgentsInstructionNoticeLog,
  parseAgentsInstructionNotice,
  parseAgentsInstructionNotices,
  type AgentsInstructionNotice,
} from "./agents-instructions-notice.js";

const notice = (overrides: Partial<AgentsInstructionNotice> = {}): AgentsInstructionNotice => ({
  scope: "workspace",
  kind: "truncated",
  sizeBytes: 20_000,
  limitBytes: 16_384,
  fingerprint: "0123456789abcdef",
  ...overrides,
});

test("notice copy names the file, its size and what Aiden did", () => {
  assert.equal(
    agentsInstructionNoticeMessage(notice({ sizeBytes: 51_991 })),
    "This workspace's AGENTS.md is 51 KB, over the 16 KB limit. Aiden is using the first 16 KB.",
  );
  assert.equal(
    agentsInstructionNoticeMessage(notice({ scope: "global", kind: "skipped", sizeBytes: 600 * 1024 })),
    "Your global AGENTS.md is 600 KB, too large to read. Aiden is responding without it.",
  );
});

test("only well-formed notices cross the IPC boundary", () => {
  assert.deepEqual(parseAgentsInstructionNotice({ ...notice(), extra: "dropped" }), notice());
  for (const bad of [
    null,
    [],
    { ...notice(), scope: "bot" },
    { ...notice(), kind: "failed" },
    { ...notice(), sizeBytes: -1 },
    { ...notice(), limitBytes: 0 },
    { ...notice(), sizeBytes: 1.5 },
    { ...notice(), fingerprint: "../../etc" },
  ]) {
    assert.equal(parseAgentsInstructionNotice(bad), undefined);
  }
  assert.deepEqual(parseAgentsInstructionNotices([]), []);
  assert.deepEqual(parseAgentsInstructionNotices([notice()]), [notice()]);
  assert.equal(parseAgentsInstructionNotices([notice(), { bad: true }]), undefined);
  assert.equal(parseAgentsInstructionNotices([notice(), notice(), notice()]), undefined);
  assert.equal(parseAgentsInstructionNotices(notice()), undefined);
});

test("each chat announces a notice once, again after an edit, and after the file fit in between", () => {
  const log = createAgentsInstructionNoticeLog();
  assert.deepEqual(log.update("chat-1", [notice()]), [notice()]);
  // The next response in the same chat sees the same file: no repeat.
  assert.deepEqual(log.update("chat-1", [notice()]), []);
  assert.deepEqual(log.update("chat-2", [notice()]), [notice()]);
  // Same size, different contents.
  const edited = notice({ fingerprint: "fedcba9876543210" });
  assert.deepEqual(log.update("chat-1", [edited]), [edited]);
  // The file fits again, then the same oversized version returns.
  assert.deepEqual(log.update("chat-1", []), []);
  assert.deepEqual(log.update("chat-1", [edited]), [edited]);
  // Scopes are tracked separately.
  const global = notice({ scope: "global" });
  assert.deepEqual(log.update("chat-1", [edited, global]), [global]);
});
