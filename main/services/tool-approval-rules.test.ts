import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import {
  emptyToolApprovalRulesDocument,
  MAX_CHAT_TOOL_APPROVAL_RULES,
  MAX_PERSISTED_TOOL_APPROVAL_RULES,
  normalizeToolApprovalRulesDocument,
  ToolApprovalRuleBook,
  toolApprovalRuleTarget,
  type ToolApprovalRulesDocument,
} from "./tool-approval-rules.js";

async function diskBook(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-approval-rules-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const open = () =>
    new DataStore<ToolApprovalRulesDocument>(
      "tool-approval-rules.json",
      emptyToolApprovalRulesDocument(),
      () => dir,
      { normalize: normalizeToolApprovalRulesDocument, reloadBeforeWrite: true },
    );
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  let ids = 0;
  const book = (store = open()) =>
    new ToolApprovalRuleBook(
      store,
      () => new Date((clock += 1_000)),
      () => `rule${++ids}`,
    );
  return { dir, file: path.join(dir, "tool-approval-rules.json"), open, book };
}

test("rule targets are exact and never wider than the approved call", () => {
  assert.deepEqual(toolApprovalRuleTarget("run_command", { command: "  npm test  " }, "ws1"), {
    toolName: "run_command",
    pattern: "npm test",
    workspaceId: "ws1",
  });
  assert.equal(
    toolApprovalRuleTarget("edit_file", { path: "./src//app.ts/" }, "ws1")?.pattern,
    "src/app.ts",
  );
  for (const unsafe of ["/etc/hosts", "~/notes.md", "../outside.txt", "src/../../x", "C:\\x.txt", "."]) {
    assert.equal(toolApprovalRuleTarget("write_file", { path: unsafe }, "ws1"), undefined, unsafe);
  }
  // Only the three parent workspace tools can be remembered, and only in a workspace.
  assert.equal(toolApprovalRuleTarget("read_file", { path: "a.txt" }, "ws1"), undefined);
  assert.equal(toolApprovalRuleTarget("run_command", { command: "ls" }, undefined), undefined);
  assert.equal(toolApprovalRuleTarget("run_command", { command: "a\u0000b" }, "ws1"), undefined);
  assert.equal(toolApprovalRuleTarget("run_command", { command: "   " }, "ws1"), undefined);
});

test("a chat rule matches only the same chat, tool, workspace and exact target", async (t) => {
  const { book } = await diskBook(t);
  const rules = book();
  const target = toolApprovalRuleTarget("run_command", { command: "npm test" }, "ws1")!;
  await rules.grant("chat", "chat-a", target);

  assert.equal(await rules.match("chat-a", target), "chat");
  assert.equal(await rules.match("chat-b", target), undefined);
  assert.equal(
    await rules.match("chat-a", toolApprovalRuleTarget("run_command", { command: "npm test -- --watch" }, "ws1")!),
    undefined,
  );
  assert.equal(
    await rules.match("chat-a", toolApprovalRuleTarget("run_command", { command: "npm test" }, "ws2")!),
    undefined,
  );
  // Chat rules are never persisted or listed in Settings.
  assert.deepEqual(await rules.list(), []);
  rules.forgetChat("chat-a");
  assert.equal(await rules.match("chat-a", target), undefined);
});

test("chat rules keep only the newest entries once the per-chat cap is reached", async (t) => {
  const { book } = await diskBook(t);
  const rules = book();
  const target = (n: number) => toolApprovalRuleTarget("run_command", { command: `echo ${n}` }, "ws1")!;
  for (let n = 0; n <= MAX_CHAT_TOOL_APPROVAL_RULES; n += 1) await rules.grant("chat", "c", target(n));
  assert.equal(await rules.match("c", target(0)), undefined);
  assert.equal(await rules.match("c", target(1)), "chat");
  assert.equal(await rules.match("c", target(MAX_CHAT_TOOL_APPROVAL_RULES)), "chat");
});

test("always rules persist across restarts, apply to every chat, and revoke cleanly", async (t) => {
  const { book } = await diskBook(t);
  const first = book();
  const changes: number[] = [];
  first.onChange(() => changes.push(changes.length));
  const command = toolApprovalRuleTarget("run_command", { command: "npm run lint" }, "ws1")!;
  const file = toolApprovalRuleTarget("write_file", { path: "docs/notes.md" }, "ws1")!;
  await first.grant("always", "chat-a", command, "  Aiden  ");
  await first.grant("always", "chat-a", command, "Aiden");
  await first.grant("always", "chat-a", file);
  assert.equal(changes.length, 2, "a duplicate grant is not a change");

  const restarted = book();
  assert.equal(await restarted.match("another-chat", command), "always");
  assert.equal(
    await restarted.match("another-chat", { ...file, toolName: "edit_file" }),
    undefined,
    "a write_file rule does not authorize edit_file",
  );
  const listed = await restarted.list();
  assert.deepEqual(
    listed.map((rule) => [rule.toolName, rule.pattern, rule.workspaceLabel]),
    [
      ["write_file", "docs/notes.md", undefined],
      ["run_command", "npm run lint", "Aiden"],
    ],
  );

  assert.equal(await restarted.revoke(listed[1]!.id), true);
  assert.equal(await restarted.revoke(listed[1]!.id), false);
  assert.equal(await restarted.match("chat-a", command), undefined);
  assert.equal(await restarted.revokeAll(), 1);
  assert.deepEqual(await book().list(), []);
});

test("the persisted rule count is bounded", async (t) => {
  const { book, file } = await diskBook(t);
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      rules: Array.from({ length: MAX_PERSISTED_TOOL_APPROVAL_RULES + 5 }, (_, n) => ({
        id: `r${n}`,
        toolName: "run_command",
        pattern: `echo ${n}`,
        workspaceId: "ws1",
        createdAt: "2026-09-01T00:00:00.000Z",
      })),
    }),
  );
  const rules = book();
  assert.equal((await rules.list()).length, MAX_PERSISTED_TOOL_APPROVAL_RULES);
  await assert.rejects(
    rules.grant("always", "c", toolApprovalRuleTarget("run_command", { command: "echo over" }, "ws1")!),
    /at most 200/u,
  );
  assert.equal((await rules.list()).length, MAX_PERSISTED_TOOL_APPROVAL_RULES);
});

test("hand-edited rules that widen or malform a pattern are ignored", async (t) => {
  const { book, file } = await diskBook(t);
  const createdAt = "2026-09-01T00:00:00.000Z";
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      rules: [
        { id: "ok", toolName: "run_command", pattern: "npm test", workspaceId: "ws1", createdAt },
        { id: "dup", toolName: "run_command", pattern: "npm test", workspaceId: "ws1", createdAt },
        { id: "padded", toolName: "run_command", pattern: " npm test ", workspaceId: "ws1", createdAt },
        { id: "absolute", toolName: "write_file", pattern: "/etc/passwd", workspaceId: "ws1", createdAt },
        { id: "dotdot", toolName: "edit_file", pattern: "a/../../b", workspaceId: "ws1", createdAt },
        { id: "noncanonical", toolName: "edit_file", pattern: "./src/app.ts", workspaceId: "ws1", createdAt },
        { id: "tool", toolName: "read_file", pattern: "a.txt", workspaceId: "ws1", createdAt },
        { id: "bad id!", toolName: "run_command", pattern: "ls", workspaceId: "ws1", createdAt },
        { id: "nodate", toolName: "run_command", pattern: "ls", workspaceId: "ws1", createdAt: "soon" },
      ],
    }),
  );
  const rules = book();
  assert.deepEqual((await rules.list()).map((rule) => rule.id), ["ok"]);
  assert.equal(
    await rules.match("c", toolApprovalRuleTarget("write_file", { path: "etc/passwd" }, "ws1")!),
    undefined,
  );
  assert.deepEqual(normalizeToolApprovalRulesDocument({ version: 2, rules: [] }), emptyToolApprovalRulesDocument());
  assert.deepEqual(normalizeToolApprovalRulesDocument("nope"), emptyToolApprovalRulesDocument());
});
