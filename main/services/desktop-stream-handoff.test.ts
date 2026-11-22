import assert from "node:assert/strict";
import test from "node:test";
import { parseClaimHandoffRequest } from "../../renderer/shared/chat-handoff.js";
import {
  consumePendingChatHandoff,
  notifyPendingChatHandoff,
  subscribePendingChatHandoff,
} from "../../renderer/lib/chat-handoff-bridge.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../renderer/shared/aiden-ui/types.js";
import { SubagentControlMainV2 } from "./subagents/subagent-control-main.js";
import {
  DesktopHandoffTicketStore,
  DesktopLiveStreamAccumulator,
} from "./desktop-stream-handoff.js";
import { ToolApprovalCoordinator } from "./tool-approval.js";
import { AskUserQuestionCoordinator } from "./ask-user-question-coordinator.js";
import { createChatOwedTurns } from "./chat-owed-turns.js";

test("parseClaimHandoffRequest accepts chatId or ticketId and rejects empty or unknown fields", () => {
  assert.deepEqual(parseClaimHandoffRequest({ chatId: "chat-1" }), { chatId: "chat-1" });
  assert.deepEqual(parseClaimHandoffRequest({ ticketId: "t-1" }), { ticketId: "t-1" });
  assert.throws(() => parseClaimHandoffRequest({}));
  assert.throws(() => parseClaimHandoffRequest({ chatId: "chat-1", extra: true }));
  assert.throws(() => parseClaimHandoffRequest(null));
});

test("DesktopLiveStreamAccumulator retains >32 KiB text, reasoning, resets, and full approval previews", () => {
  const acc = new DesktopLiveStreamAccumulator();
  acc.begin("stream-1", "chat-1");

  const chunk = "a".repeat(20_000);
  acc.record("stream-1", "chat-1", "chat:delta", { streamId: "stream-1", delta: chunk });
  acc.record("stream-1", "chat-1", "chat:delta", { streamId: "stream-1", delta: chunk });
  acc.record("stream-1", "chat-1", "chat:reasoning-delta", { streamId: "stream-1", delta: "thinking…" });

  const snap = acc.snapshot(
    "stream-1",
    [
      {
        streamId: "stream-1",
        approvalId: "appr-1",
        toolCallId: "tc-1",
        toolName: "run_command",
        summary: "Run tests",
        preview: { kind: "command", command: "npm test" },
        autoWouldJudge: true,
      },
    ],
    [],
  );
  assert.ok(snap);
  assert.equal(snap.content.length, 40_000);
  assert.equal(snap.reasoning, "thinking…");
  assert.equal(snap.pendingApprovals.length, 1);
  assert.deepEqual(snap.pendingApprovals[0]?.preview, { kind: "command", command: "npm test" });
  assert.equal(snap.pendingApprovals[0]?.autoWouldJudge, true);

  // Reset clears prior overflow text and reasoning.
  acc.record("stream-1", "chat-1", "chat:delta", { streamId: "stream-1", delta: "retry", reset: true });
  const afterReset = acc.snapshot("stream-1", [], []);
  assert.equal(afterReset?.content, "retry");
  assert.equal(afterReset?.reasoning, "");

  acc.delete("stream-1");
  assert.equal(acc.snapshot("stream-1", [], []), null);
});

test("ToolApprovalCoordinator.rebindStreamOwner transfers ownership and rejects stale owner decisions", async () => {
  const published: string[] = [];
  const coordinator = new ToolApprovalCoordinator((prompt) => {
    published.push(prompt.approvalId);
  });

  const decisionPromise = coordinator.request(
    {
      streamId: "stream-1",
      toolCallId: "tc-1",
      toolName: "run_command",
      summary: "Run ls",
      preview: { kind: "command", command: "ls -la" },
      autoWouldJudge: true,
      scopes: ["once", "workspace"],
    },
    undefined,
    "floating-doc",
  );

  assert.equal(published.length, 1);
  const approvalId = published[0]!;

  const rebound = coordinator.rebindStreamOwner("stream-1", "floating-doc", "main-doc");
  assert.equal(rebound.length, 1);
  assert.equal(rebound[0]?.approvalId, approvalId);
  assert.deepEqual(rebound[0]?.preview, { kind: "command", command: "ls -la" });
  assert.equal(rebound[0]?.autoWouldJudge, true);

  // Old owner can no longer decide.
  assert.equal(coordinator.decide(approvalId, true, "floating-doc"), false);

  // New owner decides cleanly.
  assert.equal(coordinator.decide(approvalId, true, "main-doc", { scope: "workspace" }), true);
  assert.equal(await decisionPromise, "allowed");
  assert.deepEqual(coordinator.takeDecisionPayload("stream-1", "tc-1"), { scope: "workspace" });
});

test("AskUserQuestionCoordinator.rebindStreamOwner transfers pending questions to the new window", async () => {
  const published: string[] = [];
  const coordinator = new AskUserQuestionCoordinator((prompt) => {
    published.push(prompt.promptId);
  });

  const answerPromise = coordinator.request(
    {
      streamId: "stream-q",
      toolCallId: "tc-q",
      questions: [
        {
          header: "Mode",
          question: "Which target?",
          multiSelect: false,
          options: [
            { label: "Dev", description: "Local dev" },
            { label: "Prod", description: "Production" },
          ],
        },
      ],
    },
    "floating-doc",
  );

  assert.equal(published.length, 1);
  const promptId = published[0]!;

  const rebound = coordinator.rebindStreamOwner("stream-q", "floating-doc", "main-doc");
  assert.equal(rebound.length, 1);
  assert.equal(rebound[0]?.promptId, promptId);

  // Old owner is rejected.
  const payload = {
    version: 1,
    promptId,
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: "Dev" }],
  };
  assert.equal(coordinator.respondWithOutcome(promptId, payload, "floating-doc"), "rejected");

  // New owner succeeds.
  assert.equal(coordinator.respondWithOutcome(promptId, payload, "main-doc"), "answered");
  const response = await answerPromise;
  assert.equal(response.cancelled, false);
  const firstAnswer = response.answers[0];
  assert.ok(firstAnswer && firstAnswer.kind === "option");
  assert.equal(firstAnswer.answer, "Dev");
});

test("createChatOwedTurns.rebindOwner transfers stop ownership to the new window", () => {
  const owed = createChatOwedTurns({ refuses: () => false, start: () => undefined });
  owed.open("stream-owed", { chatId: "chat-1", ownerDocumentId: "floating-doc", context: {} });
  owed.rebindOwner("stream-owed", "floating-doc", "main-doc");

  assert.equal(owed.stop("stream-owed", "user_stop", "floating-doc"), false);
  assert.equal(owed.stop("stream-owed", "user_stop", "main-doc"), true);
});

test("DesktopHandoffTicketStore enforces one-shot claims, TTL expiry, and queued messages", () => {
  let clock = 1_000;
  const store = new DesktopHandoffTicketStore({ ttlMs: 5_000, now: () => clock });

  const ticketId = store.putDraft({
    workspaceId: "ws-1",
    text: "Hello from floating",
    attachments: [{ name: "a.png" }],
    providerId: "google",
    model: "gemini-4",
  });
  const claimedDraft = store.claimDraft(ticketId);
  assert.equal(claimedDraft?.text, "Hello from floating");
  assert.equal(claimedDraft?.attachments.length, 1);
  assert.equal(store.claimDraft(ticketId), null);

  let notified = false;
  store.putChat({
    chatId: "chat-42",
    fromDocumentId: "floating-doc",
    draftText: "follow-up",
    queuedMessages: [{ content: "next step" }],
    onClaimed: () => { notified = true; },
  });
  const claimedChat = store.claimChat("chat-42");
  assert.equal(claimedChat?.draftText, "follow-up");
  assert.deepEqual(claimedChat?.queuedMessages, [{ content: "next step" }]);
  claimedChat?.onClaimed?.();
  assert.equal(notified, true);
  assert.equal(store.claimChat("chat-42"), null);

  // Expiry check (exact boundary TTL expires).
  const ephemeralDraft = store.putDraft({
    workspaceId: "default",
    text: "temporary draft",
    attachments: [],
    ephemeral: true,
  });
  const claimedEphemeralDraft = store.claimDraft(ephemeralDraft);
  assert.equal(claimedEphemeralDraft?.ephemeral, true);
  assert.equal(claimedEphemeralDraft?.text, "temporary draft");

  const expiring = store.putDraft({ workspaceId: "ws-1", text: "stale", attachments: [] });
  clock += 5_000;
  assert.equal(store.claimDraft(expiring), null);

  // Deferred detach is cancelled when claimed, and fires if expired unclaimed.
  store.putChat({ chatId: "chat-defer-claim", fromDocumentId: "floating-doc" });
  let claimExpiredCalled = false;
  assert.equal(
    store.deferDetachIfPending("chat-defer-claim", "floating-doc", () => {
      claimExpiredCalled = true;
    }),
    true,
  );
  assert.ok(store.claimChat("chat-defer-claim"));
  clock += 10_000;
  assert.equal(claimExpiredCalled, false);

  store.putChat({ chatId: "chat-defer-expire", fromDocumentId: "floating-doc" });
  let expiredCalled = false;
  assert.equal(
    store.deferDetachIfPending("chat-defer-expire", "floating-doc", () => {
      expiredCalled = true;
    }),
    true,
  );
  clock += 5_000;
  assert.equal(store.claimChat("chat-defer-expire"), null);
  assert.equal(expiredCalled, true);
  store.clear();
});

test("DesktopLiveStreamAccumulator tracks workspaceId and clears uiVisuals on reset", () => {
  const acc = new DesktopLiveStreamAccumulator();
  acc.begin("stream-ws", "chat-ws", "ws-initial");
  acc.setWorkspaceId("stream-ws", "ws-resolved");
  acc.record("stream-ws", "chat-ws", "chat:artifact", {
    streamId: "stream-ws",
    event: {
      version: 1,
      operation: "ui",
      visual: {
        version: 1,
        kind: "ui",
        id: "ui-1",
        title: "Card",
        catalogVersion: AIDEN_UI_CATALOG_VERSION,
        fallbackText: "hi",
        tree: { t: "Visual", k: "0" },
      },
    },
  });
  const before = acc.snapshot("stream-ws", [], []);
  assert.equal(before?.workspaceId, "ws-resolved");
  assert.equal(before?.uiVisuals.length, 1);

  acc.record("stream-ws", "chat-ws", "chat:artifact", {
    streamId: "stream-ws",
    event: { version: 1, operation: "reset" },
  });
  const after = acc.snapshot("stream-ws", [], []);
  assert.equal(after?.uiVisuals.length, 0);
  assert.equal(after?.artifacts.length, 0);
});

test("AskUserQuestionCoordinator preserves expired lookup for new owner after rebindStreamOwner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const coordinator = new AskUserQuestionCoordinator(() => {});
  const pending = coordinator.request(
    {
      streamId: "stream-exp",
      toolCallId: "tc-exp",
      questions: [
        {
          header: "Choice",
          question: "Pick?",
          multiSelect: false,
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
        },
      ],
      timeoutMs: 15,
    },
    "floating-doc",
  );
  const rebound = coordinator.rebindStreamOwner("stream-exp", "floating-doc", "main-doc");
  assert.equal(rebound.length, 1);
  t.mock.timers.tick(20);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(
    coordinator.respondWithOutcome(rebound[0].promptId, { answers: { q1: ["A"] } }, "main-doc"),
    "expired",
  );
  assert.equal(
    coordinator.respondWithOutcome(rebound[0].promptId, { answers: { q1: ["A"] } }, "floating-doc"),
    "rejected",
  );
});

test("ToolApprovalCoordinator preserves denied effects across rebindStreamOwner", async () => {
  const published: string[] = [];
  const coordinator = new ToolApprovalCoordinator((prompt) => {
    published.push(prompt.approvalId);
  });
  const first = coordinator.request(
    {
      streamId: "stream-deny",
      toolCallId: "tc-1",
      toolName: "run_command",
      summary: "rm -rf build",
      effect: "cmd:rm-build",
    },
    undefined,
    "floating-doc",
  );
  assert.equal(published.length, 1);
  assert.equal(coordinator.decide(published[0], false, "floating-doc"), true);
  assert.equal(await first, "denied");

  coordinator.rebindStreamOwner("stream-deny", "floating-doc", "main-doc");
  const repeat = await coordinator.request(
    {
      streamId: "stream-deny",
      toolCallId: "tc-2",
      toolName: "run_command",
      summary: "rm -rf build",
      effect: "cmd:rm-build",
    },
    undefined,
    "main-doc",
  );
  assert.equal(repeat, "denied");
  assert.equal(published.length, 1, "denied effect must not re-prompt after handoff");
});

test("SubagentControlMainV2.rebindChatOwner transfers subagent stop authority to new window", async () => {
  const control = new SubagentControlMainV2();
  let stoppedReason: Error | null = null;
  control.register({
    ownerDocumentId: "floating-doc",
    snapshot: {
      version: 2,
      runId: "run-1",
      childId: "child-1",
      groupId: "group-1",
      generationId: "stream-sub",
      chatId: "chat-sub",
      workspaceId: "ws-sub",
      depth: 1,
      authorityRevision: 1,
      execution: "foreground",
      context: "fresh",
      role: "reviewer",
      label: "Research",
      taskPreview: "Check files",
      state: "queued",
      modelId: "model-one",
      revision: 1,
      startedAt: 100,
      updatedAt: 100,
      turns: 0,
      tools: 0,
      tokens: 0,
      warnings: [],
    },
    revokeApprovals: () => {},
    stop: (reason) => {
      stoppedReason = reason;
    },
    settle: async () => {},
  });

  assert.equal(control.rebindChatOwner("chat-sub", "floating-doc", "main-doc"), 1);
  await assert.rejects(
    control.executeForDocument(
      { chatId: "chat-sub", workspaceId: "ws-sub", ownerDocumentId: "floating-doc" },
      { version: 2, action: "stop", runId: "run-1" },
    ),
    /authority does not match/,
  );
  const result = await control.executeForDocument(
    { chatId: "chat-sub", workspaceId: "ws-sub", ownerDocumentId: "main-doc" },
    { version: 2, action: "stop", runId: "run-1" },
  );
  assert.equal(result.action, "stop");
  assert.ok(stoppedReason !== null);
});

test("chat-handoff-bridge delivers pending chat handoffs to mounted and later-mounted panes", () => {
  // Before mount: queued until consumed.
  notifyPendingChatHandoff("chat-pre");
  assert.equal(consumePendingChatHandoff("chat-pre"), true);
  assert.equal(consumePendingChatHandoff("chat-pre"), false);

  // Already mounted: subscriber fires immediately.
  let hits = 0;
  const unsub = subscribePendingChatHandoff("chat-live", () => {
    if (consumePendingChatHandoff("chat-live")) hits += 1;
  });
  notifyPendingChatHandoff("chat-live");
  assert.equal(hits, 1);
  unsub();
});
