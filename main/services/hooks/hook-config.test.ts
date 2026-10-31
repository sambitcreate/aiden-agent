import assert from "node:assert/strict";
import test from "node:test";
import { hookScopesFor, parseHooksConfig, parseHooksConfigText, validateHookHandler } from "./hook-config.js";
import { aidenToolInput, aidenToolName, claudeToolInput, claudeToolName } from "./hook-aliases.js";
import type { HookScope } from "./hook-types.js";

const workspace: HookScope = { kind: "workspace", workspaceRoot: "/repo" };
const options = { scope: workspace, source: "workspace-file" as const, idPrefix: "repo:test" };

test("a Claude Code hooks file parses into one listing per handler", () => {
  const parsed = parseHooksConfig(
    {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/.aiden/hooks/guard-shell.sh", timeout: 10 }] }],
        PostToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "npx prettier --write \"$AIDEN_HOOK_FILE\"" }, { type: "command", command: "./lint.sh" }] },
        ],
      },
    },
    options,
  );
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(
    parsed.hooks.map((hook) => [hook.event, hook.matcher, hook.name, hook.status]),
    [
      ["PreToolUse", "Bash", "guard-shell", "waiting-for-approval"],
      ["PostToolUse", "Write|Edit", "prettier", "waiting-for-approval"],
      ["PostToolUse", "Write|Edit", "lint", "waiting-for-approval"],
    ],
  );
  assert.equal(new Set(parsed.hooks.map((hook) => hook.id)).size, 3, "ids are unique");
  assert.equal(new Set(parsed.hooks.map((hook) => hook.digest)).size, 3, "digests differ per handler");
});

test("ids and digests are stable across reparses and change with what the hook does", () => {
  const document = { hooks: { Stop: [{ hooks: [{ type: "command", command: "./check.sh" }] }] } };
  const first = parseHooksConfig(document, options).hooks[0];
  const again = parseHooksConfig(structuredClone(document), options).hooks[0];
  assert.equal(first?.id, again?.id);
  assert.equal(first?.digest, again?.digest);
  const edits = [
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "./check.sh --strict" }] }] } },
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "./check.sh", timeout: 5 }] }] } },
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "./check.sh", envAllow: ["GITHUB_TOKEN"] }] }] } },
    { hooks: { Stop: [{ matcher: "x", hooks: [{ type: "command", command: "./check.sh" }] }] } },
  ];
  for (const edit of edits) {
    const edited = parseHooksConfig(edit, options).hooks[0];
    assert.equal(edited?.id, first?.id);
    assert.notEqual(edited?.digest, first?.digest);
  }
  const elsewhere = parseHooksConfig(document, { ...options, scope: { kind: "workspace", workspaceRoot: "/other" } }).hooks[0];
  assert.notEqual(elsewhere?.digest, first?.digest, "the same file in another workspace needs its own approval");
});

test("unsupported entries are listed with a reason instead of dropped", () => {
  const parsed = parseHooksConfig(
    {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "http", url: "https://example.com/hook" }] },
          { matcher: "Bash", hooks: [{ type: "prompt", prompt: "Is this safe?" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "./slow.sh", async: true }] },
          { matcher: "(", hooks: [{ type: "command", command: "./bad-matcher.sh" }] },
        ],
        TeammateIdle: [{ hooks: [{ type: "command", command: "./idle.sh" }] }],
      },
    },
    options,
  );
  assert.deepEqual(
    parsed.hooks.map((hook) => [hook.configuredEvent, hook.event, hook.configuredType, hook.status]),
    [
      ["PreToolUse", "PreToolUse", "http", "unsupported"],
      ["PreToolUse", "PreToolUse", "prompt", "unsupported"],
      ["PreToolUse", "PreToolUse", "command", "unsupported"],
      ["PreToolUse", "PreToolUse", "command", "unsupported"],
      ["TeammateIdle", "unknown", "command", "unsupported"],
    ],
  );
  for (const hook of parsed.hooks) assert.ok(hook.unsupportedReason, `${hook.id} explains why`);
});

test("file-level problems are reported without throwing", () => {
  assert.match(parseHooksConfigText("{ not json", options).problems[0] ?? "", /not valid JSON/u);
  assert.match(parseHooksConfig([], options).problems[0] ?? "", /JSON object/u);
  assert.match(parseHooksConfig({ hooks: { Stop: {} } }, options).problems[0] ?? "", /list of matcher groups/u);
  assert.deepEqual(parseHooksConfig({ hooks: {} }, options).hooks, []);
});

test("handler validation enforces the timeout, env and command rules", () => {
  const lowered = validateHookHandler({ type: "command", command: "./x.sh", timeout: 600 });
  assert.ok(lowered.ok);
  assert.equal(lowered.handler.timeout, 120);
  assert.equal(lowered.warnings.length, 1);

  const agent = validateHookHandler({ type: "command", command: "./x.sh", timeout: 31 }, { maxTimeoutSeconds: 30 });
  assert.equal(agent.ok, false);

  assert.equal(validateHookHandler({ type: "command", command: "   " }).ok, false);
  assert.equal(validateHookHandler({ type: "command", command: "./x.sh", envAllow: ["AIDEN_PROJECT_DIR"] }).ok, false);
  assert.equal(validateHookHandler({ type: "command", command: "./x.sh", envAllow: ["not a name"] }).ok, false);
  assert.equal(validateHookHandler({ type: "command", command: "./x.sh", extra: 1 }).ok, false);

  const accepted = validateHookHandler({ type: "command", command: "./x.sh", envAllow: ["B_TOKEN", "A_TOKEN", "A_TOKEN"], failClosed: true, statusMessage: "Checking" });
  assert.ok(accepted.ok);
  assert.deepEqual(accepted.handler.envAllow, ["A_TOKEN", "B_TOKEN"]);
  assert.equal(accepted.handler.failClosed, true);
});

test("scopes for a run are ordered global, workspace, bot, chat", () => {
  assert.deepEqual(hookScopesFor({ workspaceRoot: "/repo/", botId: "bot-1", chatId: "chat-1" }), [
    { kind: "global" },
    { kind: "workspace", workspaceRoot: "/repo" },
    { kind: "bot", botId: "bot-1" },
    { kind: "chat", chatId: "chat-1" },
  ]);
  assert.deepEqual(hookScopesFor({ workspaceRoot: null }), [{ kind: "global" }]);
});

test("tool names and inputs translate between Aiden and Claude spellings", () => {
  assert.equal(claudeToolName("run_command"), "Bash");
  assert.equal(claudeToolName("github__create_issue"), "mcp__github__create_issue");
  assert.equal(claudeToolName("unknown_tool"), "unknown_tool");
  assert.equal(aidenToolName("MultiEdit"), "edit_file");
  assert.equal(aidenToolName("Agent"), "subagent");
  assert.equal(aidenToolName("mcp__github__create_issue"), "github__create_issue");

  const original = { path: "src/a.ts", old_string: "a", new_string: "b" };
  assert.deepEqual(claudeToolInput(original), { ...original, file_path: "src/a.ts" });
  assert.deepEqual(original, { path: "src/a.ts", old_string: "a", new_string: "b" }, "the caller's input is not changed");
  assert.deepEqual(aidenToolInput("edit_file", { file_path: "src/b.ts", path: "src/a.ts", old_string: "a", new_string: "c" }, original), {
    path: "src/b.ts",
    old_string: "a",
    new_string: "c",
  });
});
