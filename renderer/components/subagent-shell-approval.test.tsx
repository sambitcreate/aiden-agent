import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isSubagentShellApprovalShell,
  isSubagentShellApprovalDetails,
  isSubagentRunGrantApprovalDetails,
  type SubagentShellApprovalDetails,
  type SubagentRunGrantApprovalDetails,
} from "../shared/assistant.js";
import { SubagentShellApproval } from "./subagent-shell-approval.js";
import { SubagentRunGrantApproval } from "./subagent-run-grant-approval.js";
import { ChatApprovalCard } from "./chat-approval-card.js";
import type { ApprovalPrompt } from "../lib/ipc.js";

function renderApprovalCard(details: unknown, prompt: Partial<ApprovalPrompt> = {}): { markup: string; buttons: string[] } {
  const markup = renderToStaticMarkup(
    <ChatApprovalCard
      pending={{
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "run_command",
        summary: "summary",
        details: details as ApprovalPrompt["details"],
        ...prompt,
      }}
      deciding={false}
      onDecide={() => {}}
    />,
  );
  const buttons = [...markup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gu)].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/gu, "").trim(),
  );
  return { markup, buttons };
}

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

test("chat approval surface claims shell details before generic approval and keeps Deny first", () => {
  const shell = renderApprovalCard(details);
  assert.match(shell.markup, /Run checks wants to run a full-host command/u);
  assert.match(shell.markup, /Complete exact command/u);
  assert.deepEqual(shell.buttons, ["Deny", "Allow once"]);

  // A details payload that claims the shell kind but fails its guard can only be denied.
  const malformed = renderApprovalCard({ ...details, shell: "/bin/bash -c" });
  assert.match(malformed.markup, /Invalid privileged approval blocked/u);
  assert.doesNotMatch(malformed.markup, /Complete exact command/u);
  assert.deepEqual(malformed.buttons, ["Deny"]);
});

test("run grant card states its whole-run scope and rejects malformed host claims", () => {
  const grant: SubagentRunGrantApprovalDetails = {
    kind: "subagent-run-grant", lane: "shell", runId: "run-1",
    childLabel: "Implement checks", workspaceLabel: "Project",
    worktreeLabel: null, isManagedWorktree: false,
    workspaceRevisionPrefix: "a".repeat(12), fullHostAccess: true, noRollback: true,
  };
  assert.equal(isSubagentRunGrantApprovalDetails(grant), true);
  assert.equal(isSubagentRunGrantApprovalDetails({ ...grant, fullHostAccess: false }), false);
  assert.equal(isSubagentRunGrantApprovalDetails({ ...grant, extra: "x" }), false);
  assert.equal(isSubagentRunGrantApprovalDetails({ ...grant, childLabel: "bad\u202ename" }), false);
  const shellHtml = renderToStaticMarkup(
    <SubagentRunGrantApproval details={grant} descriptionId="grant-description" />,
  );
  assert.match(shellHtml, /Later commands will not ask again/u);
  assert.match(shellHtml, /not OS sandboxed/u);
  const writeHtml = renderToStaticMarkup(
    <SubagentRunGrantApproval details={{ ...grant, lane: "write", fullHostAccess: false, noRollback: false }} descriptionId="write-description" />,
  );
  assert.match(writeHtml, /Later file changes will not ask again/u);
  const card = renderApprovalCard(grant, { scopes: ["chat", "always"] });
  assert.match(card.markup, /Allow shell for Implement checks/u);
  assert.deepEqual(card.buttons, ["Deny", "Allow for run"], "a run grant is never remembered");
  assert.deepEqual(renderApprovalCard({ ...grant, fullHostAccess: false }).buttons, ["Deny"]);
});
