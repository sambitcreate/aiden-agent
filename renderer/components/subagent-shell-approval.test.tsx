import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isSubagentShellApprovalShell,
  isSubagentShellApprovalDetails,
  type SubagentShellApprovalDetails,
} from "../shared/assistant.js";
import { SubagentShellApproval } from "./subagent-shell-approval.js";

const details: SubagentShellApprovalDetails = {
  kind: "subagent-shell",
  childLabel: "Run checks",
  command: "printf 'one'\nprintf 'two'",
  initialCwd: "/Users/example/project",
  shell: "/bin/zsh -f -c",
  argumentDigestPrefix: "a".repeat(12),
  rootDigestPrefix: "b".repeat(12),
  effectDigestPrefix: "c".repeat(12),
  timeoutMs: 120_000,
  stdoutLimitBytes: 512 * 1024,
  stderrLimitBytes: 512 * 1024,
  workspaceLabel: "Project",
  isManagedWorktree: true,
  worktreeLabel: "feature/shell",
  environmentProfile: "minimal-private-0700-v1",
  osSandboxed: false,
  rollbackAvailable: false,
  outputSentToModel: true,
  arbitraryNetworkAvailable: true,
  detachedProcessesMaySurvive: true,
};

test("shell approval parser is exact and malformed claims fail closed", () => {
  assert.equal(isSubagentShellApprovalDetails(details), true);
  assert.equal(isSubagentShellApprovalShell("/bin/zsh -f -c"), true);
  assert.equal(isSubagentShellApprovalShell("/bin/sh -c"), true);
  assert.equal(isSubagentShellApprovalDetails({ ...details, shell: "/bin/sh -c" }), true);
  assert.equal(isSubagentShellApprovalShell("/bin/bash -c"), false);
  assert.equal(isSubagentShellApprovalDetails({ ...details, shell: "/bin/bash -c" }), false);
  assert.equal(isSubagentShellApprovalDetails({ ...details, rollbackAvailable: true }), false);
  assert.equal(isSubagentShellApprovalDetails({ ...details, command: "echo\u202ebad" }), false);
  assert.equal(isSubagentShellApprovalDetails({ ...details, extra: true }), false);
});

test("shell approval renders the complete command and full-host warning", () => {
  const html = renderToStaticMarkup(
    <SubagentShellApproval details={details} descriptionId="shell-description" />,
  );
  assert.match(html, /Complete exact command/u);
  assert.match(html, /printf &#x27;one&#x27;\nprintf &#x27;two&#x27;/u);
  assert.match(html, /not OS-sandboxed/u);
  assert.match(html, /Keychain\/API/u);
  assert.match(html, /no rollback/u);
  assert.match(html, /detached processes may survive/u);
});

test("chat approval surface claims shell details before generic approval and keeps Deny first", async () => {
  const source = await readFile(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
  assert.match(source, /isSubagentShellApprovalDetails\(pending\.details\)/u);
  assert.match(source, /invalidPendingShell/u);
  assert.match(source, /SubagentShellApproval/u);
  assert.ok(source.indexOf("ref={approvalDenyRef}") < source.indexOf('variant="accent"'));
});
