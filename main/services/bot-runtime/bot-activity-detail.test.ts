import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpAgentToolName } from "../mcp-tool-identity.js";
import { BOT_STEP_DETAIL_CHARS, botStepDescriptor } from "./bot-activity-detail.js";

test("a file step names only the file's base name", () => {
  assert.deepEqual(botStepDescriptor("read_file", { path: "/Users/sam/Lists/grocery-list.md" }), {
    kind: "reading",
    label: "Read 1 file",
    detail: "grocery-list.md",
  });
  assert.deepEqual(botStepDescriptor("edit_file", { path: "notes\\week.md" }), {
    kind: "editing",
    label: "Edited 1 file",
    detail: "week.md",
  });
  assert.equal(botStepDescriptor("grep", { pattern: "tofu", path: "recipes" }).detail, "tofu");
});

test("a command step is bounded and never shows a secret or an absolute path", () => {
  const secret = botStepDescriptor("run_command", {
    command: "export OPENAI_API_KEY=sk-live1234567890abcdef && ls /Users/sam/Private",
  });
  assert.equal(secret.kind, "command");
  assert.equal(secret.label, "Ran a command");
  assert.ok(secret.detail);
  assert.doesNotMatch(secret.detail, /sk-live/u);
  assert.doesNotMatch(secret.detail, /\/Users\/sam/u);
  const long = botStepDescriptor("run_command", { command: "echo hi && ".repeat(20) }).detail ?? "";
  assert.ok([...long].length <= BOT_STEP_DETAIL_CHARS);
  assert.ok(long.endsWith("…"));
  // The model's own description is preferred over the raw command.
  assert.equal(botStepDescriptor("run_command", { command: "ls -la", description: "List the folder" }).detail, "List the folder");
});

test("a search step shows its query; a connection step names the app and shows no arguments", () => {
  assert.deepEqual(botStepDescriptor("web_search", { query: "lisbon trains" }), {
    kind: "searching",
    label: "Searched the web",
    detail: "lisbon trains",
  });
  const notion = mcpAgentToolName({ id: "srv-1", name: "Notion" }, "search_pages");
  assert.deepEqual(botStepDescriptor(notion, { query: "private plans" }), {
    kind: "app",
    label: "Used Notion",
    app: "Notion",
  });
  assert.deepEqual(botStepDescriptor("ask_user_question", {}), { kind: "waiting", label: "Asked you a question" });
  assert.deepEqual(botStepDescriptor("read_file", "not an object"), { kind: "reading", label: "Read 1 file" });
});
