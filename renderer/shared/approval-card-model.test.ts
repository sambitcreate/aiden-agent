import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_CARD_LIMITS, approvalCardAllows, buildApprovalCard, type ApprovalCard } from "./approval-card-model.ts";

const allowLabels = (card: ApprovalCard) => card.buttons.filter((button) => button.decision === "allow").map((button) => button.label);

function hook(command: string) {
  return { event: "PreToolUse", matcher: "", command, timeoutSeconds: 30, async: false, failClosed: true, envAllow: [] };
}

test("a Mac command card carries the whole command, Deny first, and the scopes the host offers", () => {
  const card = buildApprovalCard({
    toolName: "run_command",
    summary: "Run command: git status --short && npm test",
    canAllow: true,
    scopes: ["chat"],
  });
  assert.equal(card.kind, "mac");
  assert.equal(card.mac, "shell");
  assert.equal(card.title, "Run on your Mac?");
  assert.deepEqual(card.body, { format: "command", text: "git status --short && npm test" });
  assert.equal(card.buttons[0]?.decision, "deny");
  assert.deepEqual(allowLabels(card), ["Allow once", "Allow in this chat"]);
  assert.equal(card.allowOnMac, undefined);
  assert.equal(approvalCardAllows(card), true);
  assert.equal(approvalCardAllows(card, "chat"), true);
  assert.equal(approvalCardAllows(card, "always"), false, "a scope the card does not offer is refused");
});

test("a card whose content does not fit, or whose details the host dropped, can only be denied", () => {
  const long = buildApprovalCard({
    toolName: "run_command",
    summary: `Run command: ${"x".repeat(APPROVAL_CARD_LIMITS.body + 1)}`,
    canAllow: true,
    scopes: ["chat"],
  });
  assert.deepEqual(long.buttons.map((button) => button.decision), ["deny"]);
  assert.equal(long.allowOnMac, "Allow it on your Mac.");
  assert.equal(approvalCardAllows(long), false);

  const omitted = buildApprovalCard({ toolName: "hooks", summary: "Add a hook", canAllow: true, details: { kind: "hook-proposal" }, detailsOmitted: true });
  assert.equal(approvalCardAllows(omitted), false);

  const malformed = buildApprovalCard({ toolName: "hooks", summary: "Add a hook", canAllow: true, details: { kind: "hook-proposal" } });
  assert.deepEqual(malformed.buttons.map((button) => button.decision), ["deny"], "details that are not the shape their kind promises fail closed");

  const refused = buildApprovalCard({ toolName: "web_fetch", summary: "Fetch https://example.com", canAllow: false });
  assert.equal(approvalCardAllows(refused), false, "the host's own canAllow still wins");
});

test("arguments read short values first, as the desktop shows them", () => {
  const card = buildApprovalCard({
    toolName: "run_command",
    summary: "Run command: ls",
    canAllow: true,
    details: {
      kind: "subagent-shell",
      childLabel: "Research helper",
      initialCwd: "/Users/me/projects/a-rather-long-folder-name",
      workspaceLabel: "Docs",
      command: "ls",
    },
  });
  const lengths = card.arguments.map((entry) => [...entry.value].length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
  assert.deepEqual(card.arguments.map((entry) => entry.key), ["workspace", "who", "folder"]);
  assert.deepEqual(allowLabels(card), ["Allow once"], "a specialized card never offers a remembered allow");
});

test("a hook proposal is a held change with Apply and Dismiss and the hook it replaces", () => {
  const card = buildApprovalCard({
    toolName: "hooks",
    summary: "Update hook",
    canAllow: true,
    scopes: ["chat", "always"],
    details: {
      kind: "hook-proposal",
      action: "update",
      name: "Lint before commit",
      scopeLabel: "This workspace (docs)",
      warnings: ["It runs before every tool."],
      previous: hook("npm run lint"),
      digestPrefix: "abc123",
      ...hook("npm run lint -- --fix"),
    },
  });
  assert.equal(card.kind, "held_change");
  assert.deepEqual(card.buttons.map((button) => [button.label, button.decision]), [["Dismiss", "deny"], ["Apply", "allow"]]);
  assert.equal(card.buttons[1]?.answered, "Applied");
  assert.match(card.body?.text ?? "", /command: npm run lint -- --fix/u);
  assert.match(card.previous?.text ?? "", /command: npm run lint\n/u);
  assert.deepEqual(card.notes, ["It runs before every tool."]);
});

test("Computer Use: a plain call stays on the Mac, the access grant can be answered anywhere", () => {
  const plain = buildApprovalCard({ toolName: "computer_use", summary: "Click Send in Mail", canAllow: true });
  assert.equal(plain.mac, "computer_use");
  assert.equal(approvalCardAllows(plain), false);

  const grant = buildApprovalCard({ toolName: "computer_use", summary: "Use your Mac", canAllow: true, details: { kind: "computer-use-access" } });
  assert.equal(grant.title, "Use your Mac with Computer Use?");
  assert.equal(approvalCardAllows(grant), true);
  assert.deepEqual(grant.notes, ["macOS permissions for Computer Use are set up on the Mac."]);
});

test("disclosure tools and kinds this model does not know are allowed only on the Mac", () => {
  for (const toolName of ["classify", "generate_image"]) {
    assert.equal(approvalCardAllows(buildApprovalCard({ toolName, summary: "Send data", canAllow: true })), false, toolName);
  }
  const unknown = buildApprovalCard({ toolName: "x", summary: "Something new", canAllow: true, details: { kind: "from-the-future" } });
  assert.deepEqual(unknown.buttons.map((button) => button.decision), ["deny"]);
});

test("a form fill shows every row it would type, or none at all when it has too many", () => {
  const row = (index: number) => ({ order: index, elementIndex: index, label: `Field ${index}`, value: `Value ${index}`, sourceLabel: "Doc", sourceLine: index });
  const details = (count: number) => ({
    kind: "form-fill-batch",
    planId: "plan-1",
    sourceDocument: "invoice.pdf",
    sourceHashPrefix: "abcd",
    targetApp: "Safari",
    targetTitle: "Checkout",
    rows: Array.from({ length: count }, (_, index) => row(index)),
    skippedRows: [],
    fillCount: count,
    reviewCount: 0,
  });
  const small = buildApprovalCard({ toolName: "form_fill", summary: "Fill a form", canAllow: true, details: details(2) });
  assert.equal(small.kind, "batch");
  assert.deepEqual(small.buttons.map((button) => button.label), ["Cancel", "Fill 2 fields"]);
  assert.deepEqual(small.rows, [{ label: "Field 0", value: "Value 0" }, { label: "Field 1", value: "Value 1" }]);

  const large = buildApprovalCard({ toolName: "form_fill", summary: "Fill a form", canAllow: true, details: details(APPROVAL_CARD_LIMITS.rows + 1) });
  assert.equal(approvalCardAllows(large), false);
});

test("a Bot's Always button uses the label the host gives it", () => {
  const card = buildApprovalCard({
    toolName: "web_fetch",
    summary: "Fetch https://example.com",
    canAllow: true,
    scopes: ["always"],
    alwaysLabel: "Always allow this tool",
    notes: ["You’ve allowed this 4 times in the last 2 weeks."],
  });
  assert.deepEqual(allowLabels(card), ["Allow once", "Always allow this tool"]);
  assert.equal(approvalCardAllows(card, "always"), true);
  assert.deepEqual(card.notes, ["You’ve allowed this 4 times in the last 2 weeks."]);
});

function subagentWrite(diffPreview: string, diffTruncated: boolean) {
  return {
    kind: "subagent-workspace-write",
    operation: "edit",
    childLabel: "Research helper",
    path: "docs/notes.md",
    workspaceLabel: "Docs",
    worktreeLabel: null,
    isManagedWorktree: false,
    preDigestPrefix: "aa11",
    postDigestPrefix: "bb22",
    beforeBytes: 10,
    afterBytes: 20,
    diffPreview,
    diffTruncated,
    commandWillRun: false,
    refuseIfChanged: true,
  };
}

test("a sub-agent's file change shows its diff, and is allowable only when the whole diff is there", () => {
  const diff = "--- a/docs/notes.md\n+++ b/docs/notes.md\n-old\n+new";
  const small = buildApprovalCard({ toolName: "write_file", summary: "Edit docs/notes.md", canAllow: true, details: subagentWrite(diff, false) });
  assert.deepEqual(small.body, { format: "command", text: diff });
  assert.equal(approvalCardAllows(small), true);

  const truncated = buildApprovalCard({ toolName: "write_file", summary: "Edit docs/notes.md", canAllow: true, details: subagentWrite(diff, true) });
  assert.equal(approvalCardAllows(truncated), false, "a diff the host cut short is allowed on the Mac");
  assert.equal(truncated.allowOnMac, "Allow it on your Mac.");

  const oversize = buildApprovalCard({ toolName: "write_file", summary: "Edit docs/notes.md", canAllow: true, details: subagentWrite(`+${"x".repeat(APPROVAL_CARD_LIMITS.body)}`, false) });
  assert.equal(approvalCardAllows(oversize), false, "a diff that does not fit the card is allowed on the Mac");

  const blank = buildApprovalCard({ toolName: "write_file", summary: "Edit docs/notes.md", canAllow: true, details: subagentWrite(" ", false) });
  assert.equal(approvalCardAllows(blank), false, "a blank diff shows nothing to allow");
});

test("a sub-agent's connector call shows its arguments, and is allowable only when they fit", () => {
  const mutation = (canonicalArguments: string) => ({
    kind: "subagent-mcp-mutation",
    childLabel: "Research helper",
    serverId: "linear",
    toolName: "create_issue",
    connectionDigestPrefix: "c1",
    schemaDigestPrefix: "s1",
    profileDigestPrefix: "p1",
    argumentDigestPrefix: "a1",
    classification: "declared_mutating",
    destructive: "additive",
    idempotency: "not_declared",
    openWorld: "closed",
    taskSupport: "forbidden",
    timeoutMs: 30_000,
    canonicalArguments,
    priorUnknownEffect: false,
    automaticRetry: false,
    rollbackAvailable: false,
  });
  const args = '{"title":"Fix the login bug","team":"ENG"}';
  const small = buildApprovalCard({ toolName: "mcp", summary: "Call linear:create_issue", canAllow: true, details: mutation(args) });
  assert.deepEqual(small.body, { format: "command", text: args });
  assert.equal(approvalCardAllows(small), true);

  const oversize = buildApprovalCard({ toolName: "mcp", summary: "Call linear:create_issue", canAllow: true, details: mutation(`"${"x".repeat(APPROVAL_CARD_LIMITS.body)}"`) });
  assert.equal(approvalCardAllows(oversize), false);

  for (const blank of ["", "  \n "]) {
    const empty = buildApprovalCard({ toolName: "mcp", summary: "Call linear:create_issue", canAllow: true, details: mutation(blank) });
    assert.equal(approvalCardAllows(empty), false, "arguments that show nothing are allowed on the Mac");
    assert.equal(empty.allowOnMac, "Allow it on your Mac.");
  }
});

test("a sub-agent's run-wide grant is given on the Mac only, whatever it reaches", () => {
  for (const fullHostAccess of [false, true]) {
    const card = buildApprovalCard({
      toolName: "subagent",
      summary: "Allow writes for this run",
      canAllow: true,
      details: {
        kind: "subagent-run-grant",
        lane: "write",
        runId: "run-1",
        childLabel: "Research helper",
        workspaceLabel: "Docs",
        worktreeLabel: null,
        isManagedWorktree: false,
        workspaceRevisionPrefix: "r1",
        fullHostAccess,
        noRollback: false,
      },
    });
    assert.deepEqual(card.buttons.map((button) => button.decision), ["deny"], `fullHostAccess ${fullHostAccess}`);
    assert.equal(card.allowOnMac, "Allow it on your Mac.");
  }
});

test("a hook proposal can be applied from a device only when its event, matcher and command are all shown", () => {
  const proposal = (overrides: Record<string, unknown>) => ({
    kind: "hook-proposal",
    action: "create",
    name: "Lint",
    scopeLabel: "This workspace (docs)",
    warnings: [],
    digestPrefix: "abc123",
    ...hook("npm run lint"),
    ...overrides,
  });
  const whole = buildApprovalCard({ toolName: "hooks", summary: "Add hook", canAllow: true, details: proposal({ matcher: "Bash" }) });
  assert.match(whole.body?.text ?? "", /event: PreToolUse\nmatcher: Bash\ncommand: npm run lint/u);
  assert.equal(approvalCardAllows(whole), true);

  const long = buildApprovalCard({ toolName: "hooks", summary: "Add hook", canAllow: true, details: proposal({ command: `echo ${"x".repeat(APPROVAL_CARD_LIMITS.body)}` }) });
  assert.equal(approvalCardAllows(long), false, "a command clipped to fit is applied on the Mac");

  const noMatcher = buildApprovalCard({ toolName: "hooks", summary: "Add hook", canAllow: true, details: proposal({ matcher: undefined }) });
  assert.equal(approvalCardAllows(noMatcher), false);
});
