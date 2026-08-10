import assert from "node:assert/strict";
import test from "node:test";
import { SLASH_LIMITS, SkillInvocationError } from "../../renderer/shared/slash-commands.js";
import type { RegisteredSkill } from "./skill-registry.js";
import {
  formatPreparedSkillInvocation,
  prepareSkillInvocationForAppend,
  requireSkillInvocationWorkspace,
} from "./skill-invocation-turn.js";
import { ChatTurnAdmission } from "./chat-turn-admission.js";

function skill(overrides: Partial<RegisteredSkill> = {}): RegisteredSkill {
  return {
    stableId: "configured:review",
    invocationId: `sk1_${"a".repeat(43)}`,
    toolKey: "skill_review",
    name: "Review",
    description: "Review changes",
    instructions: "Inspect the diff carefully.",
    source: "configured",
    enabled: true,
    available: true,
    ...overrides,
  };
}

test("Pi formatting is bounded, XML-safe, and returns safe provenance only", () => {
  const prepared = formatPreparedSkillInvocation(
    skill({ name: 'Review ">&', path: '/private/skill ">&/SKILL.md' }),
    "Check the current patch.",
    "workspace-a",
    "message-a",
  );
  assert.match(prepared.formattedPrompt, /name="Review &quot;&gt;&amp;"/u);
  assert.match(prepared.formattedPrompt, /location="\/private\/skill &quot;&gt;&amp;\/SKILL\.md"/u);
  assert.match(prepared.formattedPrompt, /Inspect the diff carefully\./u);
  assert.match(prepared.formattedPrompt, /Check the current patch\./u);
  assert.deepEqual(prepared.provenance, {
    version: 1,
    name: 'Review ">&',
    source: "configured",
  });
  assert.doesNotMatch(JSON.stringify(prepared.provenance), /private|instructions|invocationId/u);
});

test("formatted invocations fail closed at the aggregate byte boundary", () => {
  assert.throws(
    () =>
      formatPreparedSkillInvocation(
        skill({ instructions: "x".repeat(SLASH_LIMITS.instructionBytes) }),
        "y".repeat(SLASH_LIMITS.formattedInvocationBytes),
        "workspace-a",
        "message-a",
      ),
    (error: unknown) =>
      error instanceof SkillInvocationError && error.code === "instructions_too_large",
  );
});

test("turn snapshots are exact, one-shot, and clear with their lease", () => {
  const admission = new ChatTurnAdmission();
  const prepared = formatPreparedSkillInvocation(
    skill(),
    "Review this change.",
    "workspace-a",
    "message-a",
  );
  const lease = admission.tryBegin("chat-a", "turn-a", "owner-a", false);
  assert.ok(lease);
  lease.reserveSkillPreparation();
  lease.prepareSkillInvocation(prepared);
  lease.settleAsyncWork();
  assert.equal(
    admission.handoff("chat-a", "turn-b", "owner-a", () => {}),
    false,
  );
  assert.equal(
    admission.handoff("chat-a", "turn-a", "owner-b", () => {}),
    false,
  );
  let received: unknown;
  assert.equal(
    admission.handoff("chat-a", "turn-a", "owner-a", (invocation) => {
      received = invocation;
    }),
    true,
  );
  assert.deepEqual(received, prepared);
  assert.equal(
    admission.handoff("chat-a", "turn-a", "owner-a", () => {}),
    false,
  );
});

test("a throwing handoff keeps the snapshot fail-closed until explicit release", () => {
  const admission = new ChatTurnAdmission();
  const prepared = formatPreparedSkillInvocation(
    skill(),
    "Review this change.",
    "workspace-a",
    "message-a",
  );
  const lease = admission.tryBegin("chat-a", "turn-a", "owner-a", false);
  assert.ok(lease);
  lease.reserveSkillPreparation();
  lease.prepareSkillInvocation(prepared);
  lease.settleAsyncWork();
  assert.throws(
    () =>
      admission.handoff("chat-a", "turn-a", "owner-a", (received) => {
        assert.deepEqual(received, prepared);
        throw new Error("registration failed");
      }),
    /registration failed/u,
  );
  assert.equal(lease.isActive(), true);
  lease.release();
  assert.equal(lease.isActive(), false);
  assert.equal(
    admission.handoff("chat-a", "turn-a", "owner-a", () => {}),
    false,
  );
});

test("prepared prompt admission is process-bounded and restores budget after release", () => {
  const admission = new ChatTurnAdmission({
    maxPreparedTurns: 1,
    maxPreparedBytes: 2 * 1024 * 1024,
  });
  const first = admission.tryBegin("chat-a", "turn-a", "owner-a", false);
  const second = admission.tryBegin("chat-b", "turn-b", "owner-b", false);
  assert.ok(first);
  assert.ok(second);
  first.reserveSkillPreparation();
  first.prepareSkillInvocation(
    formatPreparedSkillInvocation(skill(), "Review A.", "workspace-a", "message-a"),
  );
  assert.throws(
    () => second.reserveSkillPreparation(),
    (error: unknown) => error instanceof SkillInvocationError && error.code === "turn_unavailable",
  );
  first.release();
  assert.throws(
    () => second.reserveSkillPreparation(),
    (error: unknown) => error instanceof SkillInvocationError && error.code === "turn_unavailable",
  );
  first.settleAsyncWork();
  second.reserveSkillPreparation();
  second.prepareSkillInvocation(
    formatPreparedSkillInvocation(skill(), "Review B.", "workspace-a", "message-b"),
  );
  second.release();
  second.settleAsyncWork();
});

test("an abandoned prepared turn expires and releases its prompt budget", async () => {
  const admission = new ChatTurnAdmission({
    leaseTtlMs: 15,
    maxPreparedTurns: 1,
    maxPreparedBytes: 2 * 1024 * 1024,
  });
  const abandoned = admission.tryBegin("chat-a", "turn-a", "owner-a", false);
  assert.ok(abandoned);
  abandoned.reserveSkillPreparation();
  abandoned.prepareSkillInvocation(
    formatPreparedSkillInvocation(skill(), "Review A.", "workspace-a", "message-a"),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(abandoned.isActive(), false);
  const next = admission.tryBegin("chat-b", "turn-b", "owner-b", false);
  assert.ok(next);
  assert.throws(
    () => next.reserveSkillPreparation(),
    (error: unknown) => error instanceof SkillInvocationError && error.code === "turn_unavailable",
  );
  abandoned.settleAsyncWork();
  next.reserveSkillPreparation();
  next.prepareSkillInvocation(
    formatPreparedSkillInvocation(skill(), "Review B.", "workspace-a", "message-b"),
  );
  next.release();
  next.settleAsyncWork();
});

test("raw message bounds run before whitespace normalization or fresh resolution", async () => {
  let resolutions = 0;
  await assert.rejects(
    prepareSkillInvocationForAppend(
      {
        invocationId: `sk1_${"a".repeat(43)}`,
        role: "user",
        content: " ".repeat(SLASH_LIMITS.formattedInvocationBytes + 1),
        attachments: undefined,
        workspaceId: "workspace-a",
        userMessageId: "message-a",
      },
      async () => {
        resolutions += 1;
        return skill();
      },
    ),
    (error: unknown) =>
      error instanceof SkillInvocationError && error.code === "instructions_too_large",
  );
  assert.equal(resolutions, 0);
});

test("an explicit skill never downgrades to an ordinary message without a workspace", () => {
  assert.equal(requireSkillInvocationWorkspace("workspace-a"), "workspace-a");
  for (const workspaceId of [undefined, ""]) {
    assert.throws(
      () => requireSkillInvocationWorkspace(workspaceId),
      (error: unknown) =>
        error instanceof SkillInvocationError && error.code === "workspace_changed",
    );
  }
});
