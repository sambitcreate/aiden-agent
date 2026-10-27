import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_APPROVAL_PREVIEW_MAX_LINES,
  parseToolApprovalPreview,
  toolApprovalPreview,
  type ToolApprovalPreview,
} from "./tool-approval-preview";

/** Rebuilds both sides of an edit from its preview lines. */
function sides(preview: ToolApprovalPreview | undefined): { before: string[]; after: string[] } {
  assert.equal(preview?.kind, "file");
  const lines = preview.kind === "file" ? preview.lines : [];
  return {
    before: lines.filter((line) => line.type !== "added").map((line) => line.text),
    after: lines.filter((line) => line.type !== "removed").map((line) => line.text),
  };
}

test("a command preview is the exact command, untouched", () => {
  const command = "  printf 'a\\nb' |\n  wc -l  ";
  assert.deepEqual(toolApprovalPreview("run_command", { command }), { kind: "command", command });
  assert.equal(toolApprovalPreview("run_command", { command: "   " }), undefined);
  assert.equal(toolApprovalPreview("run_command", { command: 42 }), undefined);
  assert.equal(toolApprovalPreview("run_command", ["npm test"]), undefined);
});

test("an edit keeps only the changed lines and two unchanged lines around them", () => {
  const before = ["a", "b", "c", "d", "old 1", "old 2", "e", "f", "g"];
  const after = ["a", "b", "c", "d", "new", "e", "f", "g"];
  const preview = toolApprovalPreview("edit_file", {
    path: "src/x.ts",
    old_string: before.join("\n"),
    new_string: after.join("\r\n"),
  });

  assert.deepEqual(sides(preview), { before: ["c", "d", "old 1", "old 2", "e", "f"], after: ["c", "d", "new", "e", "f"] });
  assert.equal(preview?.kind === "file" && preview.removed, 2);
  assert.equal(preview?.kind === "file" && preview.added, 1);
  assert.equal(preview?.kind === "file" && preview.operation, "edit");
});

test("a pure insertion or deletion has no lines on the other side", () => {
  const insertion = toolApprovalPreview("edit_file", { path: "a.md", old_string: "one\ntwo", new_string: "one\nnew\ntwo" });
  assert.deepEqual(sides(insertion), { before: ["one", "two"], after: ["one", "new", "two"] });
  assert.equal(insertion?.kind === "file" && insertion.removed, 0);

  const deletion = toolApprovalPreview("edit_file", { path: "a.md", old_string: "gone", new_string: "" });
  assert.deepEqual(sides(deletion), { before: ["gone"], after: [] });
});

test("a long change is cut at the line limit and says how much is left out", () => {
  const content = Array.from({ length: TOOL_APPROVAL_PREVIEW_MAX_LINES + 5 }, (_, index) => `line ${index}`).join("\n");
  const preview = toolApprovalPreview("write_file", { path: "big.txt", content });

  assert.equal(preview?.kind, "file");
  if (preview?.kind !== "file") return;
  assert.equal(preview.lines.length, TOOL_APPROVAL_PREVIEW_MAX_LINES);
  assert.equal(preview.omittedLines, 5);
  assert.equal(preview.added, TOOL_APPROVAL_PREVIEW_MAX_LINES + 5, "the count covers the whole file");
  assert.equal(preview.lines[preview.lines.length - 1]?.text, `line ${TOOL_APPROVAL_PREVIEW_MAX_LINES - 1}`);

  const readme = toolApprovalPreview("write_file", { path: "README.md", content: "# Title\n\nBody\n" });
  assert.equal(readme?.kind === "file" && readme.added, 3, "a final newline does not count as another line");

  const wide = toolApprovalPreview("write_file", { path: "wide.txt", content: "x".repeat(1_000) });
  assert.equal(wide?.kind === "file" && wide.lines[0]?.text.length, 401, "400 characters and an ellipsis");
});

test("tools without a preview and malformed arguments get none", () => {
  assert.equal(toolApprovalPreview("delete_file", { path: "a" }), undefined);
  assert.equal(toolApprovalPreview("edit_file", { path: "a", old_string: "x" }), undefined);
  assert.equal(toolApprovalPreview("write_file", { path: " ", content: "x" }), undefined);
  assert.equal(toolApprovalPreview("write_file", { path: "a".repeat(1_025), content: "x" }), undefined);
  assert.equal(toolApprovalPreview("write_file", null), undefined);
});

test("a preview survives the trip to the renderer, and anything malformed is dropped", () => {
  const edit = toolApprovalPreview("edit_file", { path: "a.ts", old_string: "a", new_string: "b" });
  assert.deepEqual(parseToolApprovalPreview(structuredClone(edit)), edit);
  assert.deepEqual(parseToolApprovalPreview({ kind: "command", command: "ls" }), { kind: "command", command: "ls" });

  const valid = { kind: "file", operation: "write", path: "a", lines: [], added: 0, removed: 0, omittedLines: 0 };
  assert.deepEqual(parseToolApprovalPreview(valid), valid);
  for (const malformed of [
    { ...valid, operation: "delete" },
    { ...valid, lines: [{ type: "changed", text: "x" }] },
    { ...valid, lines: Array.from({ length: TOOL_APPROVAL_PREVIEW_MAX_LINES + 1 }, () => ({ type: "added", text: "" })) },
    { ...valid, added: -1 },
    { ...valid, omittedLines: 1.5 },
    { ...valid, path: "" },
    { kind: "command", command: " " },
    { kind: "diff" },
    "ls",
  ]) {
    assert.equal(parseToolApprovalPreview(malformed), undefined, JSON.stringify(malformed).slice(0, 80));
  }
});
