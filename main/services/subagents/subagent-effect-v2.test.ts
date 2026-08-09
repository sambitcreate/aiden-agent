import assert from "node:assert/strict";
import test from "node:test";
import {
  durableSubagentEffectRecordsMatchV2,
  parseDurableSubagentApprovalV2,
  parseDurableSubagentEffectV2,
  parsePrepareDurableSubagentEffectV2Input,
  subagentEffectEvidenceDigestV2,
  type DurableSubagentApprovalV2,
  type DurableSubagentEffectV2,
} from "./subagent-effect-v2.js";

const digest = "a".repeat(64);
const approval = (
  overrides: Partial<DurableSubagentApprovalV2> = {},
): DurableSubagentApprovalV2 => ({
  version: 1,
  approvalId: "approval-1",
  effectId: "effect-1",
  runId: "run-1",
  chatId: "chat-1",
  childId: "child-1",
  toolCallId: "call-1",
  toolName: "tool-1",
  state: "prepared",
  argumentDigest: digest,
  effectDigest: "b".repeat(64),
  authorityDigest: "c".repeat(64),
  createdAt: 10,
  updatedAt: 10,
  expiresAt: 100,
  ...overrides,
});
const effect = (overrides: Partial<DurableSubagentEffectV2> = {}): DurableSubagentEffectV2 => ({
  version: 1,
  effectId: "effect-1",
  approvalId: "approval-1",
  runId: "run-1",
  chatId: "chat-1",
  childId: "child-1",
  toolCallId: "call-1",
  toolName: "tool-1",
  effectKind: "mcp_mutation",
  state: "prepared",
  argumentDigest: digest,
  effectDigest: "b".repeat(64),
  authorityDigest: "c".repeat(64),
  preparedAt: 10,
  updatedAt: 10,
  ...overrides,
});

test("durable effect records accept exact digest-only evidence", () => {
  assert.deepEqual(parseDurableSubagentApprovalV2(approval()), approval());
  assert.deepEqual(parseDurableSubagentEffectV2(effect()), effect());
  assert.equal(durableSubagentEffectRecordsMatchV2(approval(), effect()), true);
  assert.match(subagentEffectEvidenceDigestV2("startup"), /^[a-f0-9]{64}$/u);
});

test("durable effect records reject raw or mismatched evidence", () => {
  assert.equal(
    parseDurableSubagentApprovalV2({ ...approval(), arguments: { secret: true } }),
    undefined,
  );
  assert.equal(parseDurableSubagentEffectV2({ ...effect(), result: "secret" }), undefined);
  assert.equal(parseDurableSubagentEffectV2({ ...effect(), state: "unknown" }), undefined);
  assert.equal(
    durableSubagentEffectRecordsMatchV2(
      approval({ state: "authorized", updatedAt: 11 }),
      effect({ state: "dispatch_started", updatedAt: 11 }),
    ),
    false,
  );
});

test("effect parsers reject hostile object shapes without invoking accessors or proxy traps", () => {
  let getterCalls = 0;
  const accessor = { ...effect() };
  Object.defineProperty(accessor, "authorityDigest", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "c".repeat(64);
    },
  });
  assert.equal(parseDurableSubagentEffectV2(accessor), undefined);
  assert.equal(getterCalls, 0);

  let proxyReads = 0;
  const proxy = new Proxy(effect(), {
    get(target, key, receiver) {
      proxyReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(parseDurableSubagentEffectV2(proxy), undefined);
  assert.equal(proxyReads, 0);

  const withSymbol = { ...approval(), [Symbol("hidden")]: "secret" };
  assert.equal(parseDurableSubagentApprovalV2(withSymbol), undefined);
  const nonEnumerable = { ...approval() };
  Object.defineProperty(nonEnumerable, "hidden", { enumerable: false, value: "secret" });
  assert.equal(parseDurableSubagentApprovalV2(nonEnumerable), undefined);
  assert.equal(parseDurableSubagentApprovalV2(Object.assign(Object.create({}), approval())), undefined);

  const preparation = {
    approvalId: "approval-1",
    effectId: "effect-1",
    runId: "run-1",
    chatId: "chat-1",
    childId: "child-1",
    toolCallId: "call-1",
    toolName: "tool-1",
    effectKind: "shell",
    argumentDigest: digest,
    effectDigest: "b".repeat(64),
    authorityDigest: "c".repeat(64),
    expiresAt: 100,
  };
  const parsed = parsePrepareDurableSubagentEffectV2Input(preparation);
  preparation.toolName = "changed-after-parse";
  assert.equal(parsed?.toolName, "tool-1");
});
