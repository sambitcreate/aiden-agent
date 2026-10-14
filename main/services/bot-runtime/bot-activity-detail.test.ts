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

test("a command step shows only its description, bounded and redacted; the command never appears", () => {
  const noDescription = botStepDescriptor("run_command", {
    command: "curl -H 'X-Api-Key: hunter2hunter2' https://x.test && mysql -u root -pS3cretPass && cat ~/.ssh/id_rsa && ls /Taxes2025",
  });
  assert.deepEqual(noDescription, { kind: "command", label: "Ran a command" });
  const secret = botStepDescriptor("run_command", {
    command: "ls",
    description: "Export OPENAI_API_KEY=sk-live1234567890abcdef then list /Users/sam/Private",
  });
  assert.ok(secret.detail);
  assert.doesNotMatch(secret.detail, /sk-live/u);
  assert.doesNotMatch(secret.detail, /\/Users\/sam/u);
  const long = botStepDescriptor("run_command", { command: "ls", description: "Tidy the notes and ".repeat(20) }).detail ?? "";
  assert.ok([...long].length <= BOT_STEP_DETAIL_CHARS);
  assert.ok(long.endsWith("…"));
  assert.equal(botStepDescriptor("run_command", { command: "ls -la", description: "List the folder" }).detail, "List the folder");
});

test("invisible format characters are stripped, and a secret-shaped search query is redacted", () => {
  const spoofed = botStepDescriptor("web_search", { query: "invoice\u202Egpj.exe \u200Bnow" }).detail;
  assert.equal(spoofed, "invoicegpj.exe now");
  const leaky = botStepDescriptor("web_search", { query: "why does token=sk-live1234567890abcdef fail" }).detail;
  assert.ok(leaky);
  assert.doesNotMatch(leaky, /sk-live/u);
  // A secret far past the shown length cannot leak through a long query either.
  const far = botStepDescriptor("web_search", { query: `${"word ".repeat(5_000)}sk-live1234567890abcdef` }).detail ?? "";
  assert.doesNotMatch(far, /sk-live/u);
  assert.ok([...far].length <= BOT_STEP_DETAIL_CHARS);
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

test("an argument of thousands of spaces is cut without stalling the main process", () => {
  const started = performance.now();
  const padded = botStepDescriptor("web_search", { query: `tofu${" ".repeat(15_990)}alpha beta gamma delta epsilon` }).detail ?? "";
  const blank = botStepDescriptor("web_search", { query: `${" ".repeat(20_000)}tofu` }).detail;
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `took ${elapsed.toFixed(0)} ms`);
  assert.ok([...padded].length <= BOT_STEP_DETAIL_CHARS);
  assert.match(padded, /^tofu/u);
  assert.ok(blank === undefined || [...blank].length <= BOT_STEP_DETAIL_CHARS);
});
