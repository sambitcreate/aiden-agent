import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  parseWorkspaceArtifactActions,
  parseWorkspaceArtifactOutput,
  parseWorkspaceArtifactRefresh,
  parseWorkspaceArtifactSnapshotV1,
  parseWorkspaceArtifactSources,
  resolveWorkspaceArtifactCommand,
  workspaceArtifactDataJson,
  workspaceArtifactSourceAccess,
  type WorkspaceArtifactActionV1,
  type WorkspaceArtifactSourceV1,
} from "./workspace-artifacts.js";

test("sources accept shell commands and workspace files and reject paths outside the folder", () => {
  assert.deepEqual(
    parseWorkspaceArtifactSources([
      { name: "pulls", kind: "shell", command: "  gh pr list --json number,title  " },
      { name: "todo", kind: "file", file: "docs/TODO.md", parse: "lines" },
    ]),
    [
      { name: "pulls", kind: "shell", command: "gh pr list --json number,title", parse: "json" },
      { name: "todo", kind: "file", file: "docs/TODO.md", parse: "lines" },
    ],
  );
  for (const file of ["/etc/passwd", "../secrets", "docs/../../x", "~/notes", "C:\\Windows\\x"]) {
    assert.throws(() => parseWorkspaceArtifactSources([{ name: "x", kind: "file", file }]), /workspace/u, file);
  }
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "a", kind: "shell", command: "x" }, { name: "a", kind: "shell", command: "y" }]), /twice/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "constructor", kind: "shell", command: "x" }]), /identifier/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "path", kind: "shell", command: "x" }]), /identifier/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "x", kind: "http", command: "x" }]), /kind/u);
});

test("action templates may only name their own params", () => {
  assert.deepEqual(
    parseWorkspaceArtifactActions([
      { name: "merge", label: "Merge pull request", command: "gh pr merge {{number}} --squash", params: [{ name: "number", type: "number" }] },
    ]),
    [{ name: "merge", label: "Merge pull request", command: "gh pr merge {{number}} --squash", params: [{ name: "number", type: "number" }] }],
  );
  assert.throws(
    () => parseWorkspaceArtifactActions([{ name: "merge", label: "Merge", command: "gh pr merge {{id}}", params: [{ name: "number" }] }]),
    /\{\{id\}\} is not one of its params/u,
  );
  assert.throws(() => parseWorkspaceArtifactActions([{ name: "merge", label: "", command: "x" }]), /label/u);
});

test("refresh intervals are opt-in and never faster than a minute", () => {
  assert.deepEqual(parseWorkspaceArtifactRefresh(undefined), { onOpen: true });
  assert.deepEqual(parseWorkspaceArtifactRefresh({ onOpen: false, intervalSeconds: 300 }), { onOpen: false, intervalSeconds: 300 });
  assert.throws(() => parseWorkspaceArtifactRefresh({ intervalSeconds: 5 }), /60/u);
});

const merge: WorkspaceArtifactActionV1 = {
  name: "comment",
  label: "Comment",
  command: "printf '%s|%s' {{who}} {{count}}",
  params: [
    { name: "who", type: "string" },
    { name: "count", type: "number" },
  ],
};

test("filled-in values reach the shell as single literal words", () => {
  // The shell itself is the oracle: whatever the page passes comes back verbatim.
  const hostile = [`$(touch /tmp/aiden-pwned)`, `'; echo hi; '`, "a  b c", `"$HOME"`, "`id`", "plain", "x\"y"];
  for (const value of hostile) {
    const { command } = resolveWorkspaceArtifactCommand(merge, [value, 3]);
    const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.equal(output, `${value}|3`, value);
  }
});

test("a value never runs as code, even where a template quotes its placeholder", () => {
  const marker = path.join(os.tmpdir(), `aiden-artifact-injection-${process.pid}`);
  fs.rmSync(marker, { force: true });
  // These shapes are rejected when the model saves an action; the runner is safe even so.
  for (const template of [`printf '%s' "{{body}}"`, `printf '%s' '{{body}}'`, "printf '%s' `echo {{body}}`", `printf '%s' $(echo {{body}})`]) {
    const action: WorkspaceArtifactActionV1 = { name: "a", label: "A", command: template, params: [{ name: "body", type: "string" }] };
    for (const value of [`$(touch ${marker})`, `'; touch ${marker}; '`, `\`touch ${marker}\``]) {
      execFileSync("/bin/sh", ["-c", resolveWorkspaceArtifactCommand(action, [value]).command], { encoding: "utf8" });
    }
  }
  assert.equal(fs.existsSync(marker), false);
});

test("a placeholder must be its own unquoted word", () => {
  const action = (command: string) => [{ name: "a", label: "A", command, params: [{ name: "x" }] }];
  for (const command of [`echo "{{x}}"`, `echo '{{x}}'`, "echo `{{x}}`", "echo $(cat {{x}})", "echo ${{{x}}}", "echo pre{{x}}", "cat <<EOF\n{{x}}\nEOF"]) {
    assert.throws(() => parseWorkspaceArtifactActions(action(command)), /own unquoted word/u, command);
  }
  for (const command of ["gh pr merge {{x}} --squash", "echo {{x}}; echo done", "(cd sub && make {{x}})", `echo "fixed" {{x}}`]) {
    assert.equal(parseWorkspaceArtifactActions(action(command)).length, 1, command);
  }
});

test("filled-in values are checked against their declared types", () => {
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", "not a number"]), /number/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, [{ nested: true }, 1]), /text/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\u0000b", 1]), /control/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\u202eb", 1]), /control/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["--upload-pack=x", 1]), /cannot start with "-"/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a", 1, "extra"]), /takes 2/u);
  assert.equal(resolveWorkspaceArtifactCommand(merge, ["x", "42"]).preview, "printf '%s|%s' 'x' '42'");
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", -1]), /cannot be negative/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", "-1"]), /cannot be negative/u);
});

test("commands and labels reject characters that hide what runs", () => {
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "a", kind: "shell", command: "ls \u202e-la" }]), /control/u);
  assert.throws(() => parseWorkspaceArtifactActions([{ name: "a", label: "Me\u200brge", command: "x" }]), /label/u);
});

test("output parses as JSON, non-empty lines or text, within the data cap", () => {
  assert.deepEqual(parseWorkspaceArtifactOutput("json", '[{"n":1}]'), { ok: true, dataJson: '[{"n":1}]' });
  assert.deepEqual(parseWorkspaceArtifactOutput("lines", "a\n\n  b  \r\nc\n"), { ok: true, dataJson: '["a","  b","c"]' });
  assert.deepEqual(parseWorkspaceArtifactOutput("text", "hello\n\n"), { ok: true, dataJson: '"hello"' });
  assert.equal(parseWorkspaceArtifactOutput("json", "not json").ok, false);
  const big = parseWorkspaceArtifactOutput("text", "x".repeat(70 * 1024));
  assert.equal(big.ok, false);
});

test("sources follow the workspace's access like a chat would", () => {
  const shell: WorkspaceArtifactSourceV1 = { name: "a", kind: "shell", command: "ls", parse: "lines" };
  const file: WorkspaceArtifactSourceV1 = { name: "b", kind: "file", file: "a.json", parse: "json" };
  assert.equal(workspaceArtifactSourceAccess("full", true, shell, false), "run");
  assert.equal(workspaceArtifactSourceAccess("ask", true, shell, false), "needs-approval");
  assert.equal(workspaceArtifactSourceAccess("ask", true, shell, true), "run");
  assert.equal(workspaceArtifactSourceAccess("ask", true, file, false), "run");
  assert.equal(workspaceArtifactSourceAccess("none", true, file, true), "blocked");
  assert.equal(workspaceArtifactSourceAccess("full", false, shell, true), "blocked");
});

test("page data binds each source by name, null until it first loads", () => {
  const artifact = {
    visual: { dataJson: '{"title":"PRs","pulls":"static"}' } as never,
    sources: [
      { name: "pulls", kind: "shell", command: "x", parse: "json" },
      { name: "todo", kind: "file", file: "t", parse: "lines" },
    ] satisfies WorkspaceArtifactSourceV1[],
  };
  const snapshot = parseWorkspaceArtifactSnapshotV1({
    revision: 1,
    refreshedAt: 1,
    sources: { pulls: { status: "error", at: 1, dataJson: "[1,2]", error: "offline" } },
  });
  assert.deepEqual(JSON.parse(workspaceArtifactDataJson(artifact, snapshot)!), { title: "PRs", pulls: [1, 2], todo: null });
});
