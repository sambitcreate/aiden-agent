import assert from "node:assert/strict";
import test from "node:test";
import { SubagentApprovalLedgerV2 } from "./approval-v2.js";
import { subagentMcpEffectProfileFingerprintV2 } from "./authority-v2.js";
import {
  SubagentMcpMutationApprovalCoreV2,
  subagentMcpMutationBindingDigestV2,
  type PrepareSubagentMcpMutationApprovalV2Input,
} from "./subagent-mcp-mutation-approval.js";

function profile() {
  const facts = {
    classification: "declared_mutating" as const,
    destructive: "destructive" as const,
    idempotency: "idempotent" as const,
    openWorld: "open" as const,
    taskSupport: "optional" as const,
  };
  return {
    ...facts,
    fingerprint: subagentMcpEffectProfileFingerprintV2(facts),
  };
}

function input(
  overrides: Partial<PrepareSubagentMcpMutationApprovalV2Input> = {},
): PrepareSubagentMcpMutationApprovalV2Input {
  return {
    treeRootId: "tree-1",
    runId: "run-1",
    childId: "child-1",
    childLabel: "Publisher",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    ownerDocumentId: "document-1",
    toolCallId: "call-1",
    agentToolName: "mcp_docs_publish",
    authorityRevision: 1,
    serverId: "docs",
    connectionFingerprint: "a".repeat(64),
    toolName: "publish",
    schemaHash: "b".repeat(64),
    effectProfile: profile(),
    arguments: { z: 2, a: "safe" },
    timeoutMs: 30_000,
    expiresAt: 1_000,
    priorUnknownEffect: false,
    ...overrides,
  };
}

test("mutation approval snapshots exact canonical arguments and complete safe display", () => {
  const core = new SubagentMcpMutationApprovalCoreV2(
    (text) => text,
    new SubagentApprovalLedgerV2(
      () => 100,
      () => "approval-1",
    ),
  );
  const args = { z: 2, a: "line\n\u0085\u202e\u2066done" };
  const prepared = core.prepare(input({ arguments: args }));
  assert.equal(
    prepared.details.canonicalArguments,
    '{"a":"line\\n\\u0085\\u202e\\u2066done","z":2}',
  );
  assert.doesNotMatch(prepared.details.canonicalArguments, /[\u0085\u202e\u2066]/u);
  assert.equal(prepared.details.argumentDigestPrefix.length, 12);
  assert.equal(prepared.details.automaticRetry, false);
  assert.equal(prepared.details.rollbackAvailable, false);
  args.a = "changed";
  assert.equal(
    core.authorize(prepared.approvalId, "document-1", input({ arguments: args })),
    false,
  );
});

test("mutation binding digest covers profile, exact arguments, and prior unknown state", () => {
  const base = {
    serverId: "docs",
    connectionFingerprint: "a".repeat(64),
    toolName: "publish",
    schemaHash: "b".repeat(64),
    effectProfileFingerprint: profile().fingerprint,
    canonicalArguments: '{"value":1}',
    priorUnknownEffect: false,
  };
  const digest = subagentMcpMutationBindingDigestV2(base);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    digest,
    subagentMcpMutationBindingDigestV2({
      ...base,
      priorUnknownEffect: true,
    }),
  );
  assert.notEqual(
    digest,
    subagentMcpMutationBindingDigestV2({
      ...base,
      canonicalArguments: '{"value":2}',
    }),
  );
});

test("mutation approval is owner-bound, expiring, and consumed once", () => {
  let now = 100;
  let sequence = 0;
  const core = new SubagentMcpMutationApprovalCoreV2(
    (text) => text,
    new SubagentApprovalLedgerV2(
      () => now,
      () => `approval-${++sequence}`,
    ),
  );
  const current = input();
  const prepared = core.prepare(current);
  assert.equal(core.authorize(prepared.approvalId, "other-document", current), false);
  assert.equal(core.authorize(prepared.approvalId, "document-1", current), true);
  assert.equal(core.consume(prepared.approvalId, current), true);
  assert.equal(core.consume(prepared.approvalId, current), false);

  const expiring = input({ toolCallId: "call-2", expiresAt: 150 });
  const expired = core.prepare(expiring);
  now = 150;
  assert.equal(core.authorize(expired.approvalId, "document-1", expiring), false);
});

test("prior unknown copy is explicit and credential-redaction changes deny preparation", () => {
  const safe = new SubagentMcpMutationApprovalCoreV2(
    (text) => text,
    new SubagentApprovalLedgerV2(
      () => 100,
      () => "approval-safe",
    ),
  );
  const prepared = safe.prepare(input({ priorUnknownEffect: true }));
  assert.equal(prepared.details.priorUnknownEffect, true);

  const redacting = new SubagentMcpMutationApprovalCoreV2((text) =>
    text.replace("credential", "[REDACTED]"),
  );
  assert.throws(
    () => redacting.prepare(input({ arguments: { token: "credential" } })),
    /credential material/u,
  );
  assert.throws(
    () => safe.prepare(input({ arguments: { huge: "x".repeat(8 * 1024) } })),
    /too large to review/u,
  );
});
