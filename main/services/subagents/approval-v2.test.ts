import assert from "node:assert/strict";
import test from "node:test";
import {
  SubagentApprovalLedgerV2,
  subagentApprovalArgumentDigestV2,
  type PrepareSubagentApprovalV2Input,
} from "./approval-v2.js";

function input(argumentsValue: unknown = { path: "README.md", line: 1 }) {
  return {
    treeRootId: "tree-1",
    runId: "run-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    ownerDocumentId: "document-1",
    toolCallId: "call-1",
    toolName: "write_file",
    authorityRevision: 1,
    arguments: argumentsValue,
    expiresAt: 2_000,
  } satisfies PrepareSubagentApprovalV2Input;
}

test("argument digests are canonical, bounded, and reject unsupported values", () => {
  assert.equal(
    subagentApprovalArgumentDigestV2("write_file", { b: 2, a: 1 }),
    subagentApprovalArgumentDigestV2("write_file", { a: 1, b: 2 }),
  );
  assert.notEqual(
    subagentApprovalArgumentDigestV2("write_file", { a: 1 }),
    subagentApprovalArgumentDigestV2("write_file", { a: 2 }),
  );
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", { value: Infinity }),
    /finite/u,
  );
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", { value: undefined }),
    /unsupported/u,
  );
});

test("canonicalization never invokes object, array, input accessors, or proxy traps", () => {
  let objectGetterCalls = 0;
  const objectWithGetter: Record<string, unknown> = {};
  Object.defineProperty(objectWithGetter, "path", {
    enumerable: true,
    get: () => {
      objectGetterCalls += 1;
      return "secret";
    },
  });
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", objectWithGetter),
    /accessor/u,
  );
  assert.equal(objectGetterCalls, 0);

  let arrayGetterCalls = 0;
  const arrayWithGetter: unknown[] = ["safe"];
  Object.defineProperty(arrayWithGetter, "0", {
    enumerable: true,
    get: () => {
      arrayGetterCalls += 1;
      return "secret";
    },
  });
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", arrayWithGetter),
    /accessor/u,
  );
  assert.equal(arrayGetterCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy(
    { path: "README.md" },
    {
      getPrototypeOf: () => {
        proxyTrapCalls += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        proxyTrapCalls += 1;
        return ["path"];
      },
    },
  );
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", proxy),
    /proxy|unsupported/u,
  );
  assert.equal(proxyTrapCalls, 0);

  const arrayProxy = new Proxy(["safe"], {
    getPrototypeOf: () => {
      proxyTrapCalls += 1;
      return Array.prototype;
    },
    ownKeys: () => {
      proxyTrapCalls += 1;
      return ["0", "length"];
    },
  });
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", arrayProxy),
    /proxy|unsupported/u,
  );
  assert.equal(proxyTrapCalls, 0);

  let inputGetterCalls = 0;
  const inputWithGetter = input();
  Object.defineProperty(inputWithGetter, "arguments", {
    enumerable: true,
    get: () => {
      inputGetterCalls += 1;
      return { path: "secret" };
    },
  });
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "approval-accessor",
  );
  assert.throws(() => ledger.prepare(inputWithGetter), /accessor/u);
  assert.equal(inputGetterCalls, 0);
  assert.equal(ledger.pendingCount, 0);
});

test("canonicalization rejects direct and indirect cycles while preserving repeated acyclic values", () => {
  const direct: Record<string, unknown> = {};
  direct.self = direct;
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", direct),
    /cyclic/u,
  );

  const first: Record<string, unknown> = {};
  const second: Record<string, unknown> = { first };
  first.second = second;
  assert.throws(
    () => subagentApprovalArgumentDigestV2("write_file", first),
    /cyclic/u,
  );

  const shared = { path: "README.md" };
  assert.doesNotThrow(() =>
    subagentApprovalArgumentDigestV2("write_file", {
      first: shared,
      second: shared,
    }),
  );
});

test("approval is owner-bound, exact, authorized once, and consumed once", () => {
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "approval-1",
  );
  const prepared = ledger.prepare(input());
  assert.equal(prepared.binding.argumentDigest.length, 64);
  assert.equal("arguments" in prepared.binding, false);
  assert.equal(
    ledger.authorize(prepared.approvalId, "wrong-document", input()),
    false,
  );
  assert.equal(
    ledger.authorize(
      prepared.approvalId,
      "document-1",
      input({ path: "OTHER" }),
    ),
    false,
  );
  assert.equal(
    ledger.authorize(prepared.approvalId, "document-1", input()),
    true,
  );
  assert.equal(
    ledger.authorize(prepared.approvalId, "document-1", input()),
    false,
  );
  assert.equal(
    ledger.consume(prepared.approvalId, { ...input(), authorityRevision: 2 }),
    false,
  );
  assert.equal(ledger.consume(prepared.approvalId, input()), true);
  assert.equal(ledger.consume(prepared.approvalId, input()), false);
  assert.equal(ledger.pendingCount, 0);
});

test("expiry, duplicate call ownership, denial, and run cancellation fail closed", () => {
  let now = 1_000;
  let id = 0;
  const ledger = new SubagentApprovalLedgerV2(
    () => now,
    () => `approval-${++id}`,
  );
  const first = ledger.prepare(input());
  assert.throws(() => ledger.prepare(input()), /already has an approval/u);
  assert.equal(ledger.deny(first.approvalId, "wrong-document"), false);
  assert.equal(ledger.deny(first.approvalId, "document-1"), true);
  const second = ledger.prepare(input());
  now = 2_000;
  assert.equal(
    ledger.authorize(second.approvalId, "document-1", input()),
    false,
  );
  ledger.cancelRun("run-1");
  assert.equal(ledger.pendingCount, 0);
});

test("expired approvals release both capacity and tool-call ownership", () => {
  let current = 1_000;
  let sequence = 0;
  const ledger = new SubagentApprovalLedgerV2(
    () => current,
    () => `approval-expiry-${sequence++}`,
  );
  for (let index = 0; index < 128; index += 1) {
    ledger.prepare({
      ...input(),
      toolCallId: `call-${index}`,
      expiresAt: 1_001,
    });
  }
  assert.equal(ledger.pendingCount, 128);
  current = 1_001;
  assert.equal(ledger.pendingCount, 0);
  assert.doesNotThrow(() => ledger.prepare({ ...input(), expiresAt: 2_000 }));
});

test("approval identity allocation retries unsafe and colliding values within a fixed bound", () => {
  const candidates = ["unsafe id", "approval-1", "approval-1", "approval-2"];
  let allocations = 0;
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => candidates[allocations++] ?? "approval-fallback",
  );
  const first = ledger.prepare(input());
  assert.equal(first.approvalId, "approval-1");
  const second = ledger.prepare({ ...input(), toolCallId: "call-2" });
  assert.equal(second.approvalId, "approval-2");
  assert.equal(allocations, 4);

  let rejectedAllocations = 0;
  const rejecting = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => {
      rejectedAllocations += 1;
      return "still unsafe";
    },
  );
  assert.throws(() => rejecting.prepare(input()), /allocate/u);
  assert.equal(rejectedAllocations, 128);
  assert.equal(rejecting.pendingCount, 0);
});

test("stored bindings are data-only copies and never retain raw argument containers", () => {
  const argumentsValue = { path: "README.md", nested: { line: 1 } };
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "approval-copy",
  );
  const prepared = ledger.prepare(input(argumentsValue));
  argumentsValue.path = "CHANGED";
  argumentsValue.nested.line = 99;

  assert.equal("arguments" in prepared.binding, false);
  assert.deepEqual(Object.keys(prepared.binding).sort(), [
    "argumentDigest",
    "authorityRevision",
    "chatId",
    "childId",
    "expiresAt",
    "ownerDocumentId",
    "runId",
    "toolCallId",
    "toolName",
    "treeRootId",
    "workspaceId",
  ]);
  assert.equal(
    ledger.authorize(prepared.approvalId, "document-1", input(argumentsValue)),
    false,
  );
});
