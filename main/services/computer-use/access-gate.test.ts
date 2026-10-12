import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { COMPUTER_USE_ACCESS_SCOPES } from "../../../renderer/shared/computer-use-access.js";
import type { ToolApprovalScope } from "../../../renderer/shared/tool-approval-scope.js";
import { createChatStore } from "../chat-store-core.js";
import { ToolApprovalCoordinator, type ToolApprovalPrompt } from "../tool-approval.js";
import type { GenerationCancellationOrigin } from "../../../renderer/shared/generation-timeline.js";
import {
  COMPUTER_USE_DECLINED_REASON,
  COMPUTER_USE_RESETTING_REASON,
  COMPUTER_USE_SETUP_REASON,
  createComputerUseAccessGate,
  resetComputerUseGrants,
  revokeComputerUseGrants,
} from "./access-gate.js";

const READY = { ready: true, available: true, detail: "Ready." };
const NEEDS_PERMISSIONS = {
  ready: false,
  available: true,
  detail: "Allow Accessibility and Screen Recording.",
};

/**
 * A desktop with a real chat store and a real approval coordinator. Each
 * stream builds its own gate the way llm-client does; `answer` decides the
 * next card the user sees.
 */
async function desktop(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-cu-access-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatStore = createChatStore(async () => root);
  const settings: { computerUseAlwaysAllow?: boolean } = {};
  const cards: ToolApprovalPrompt[] = [];
  let status: { ready: boolean; available: boolean; detail: string } = READY;
  const forcedStatusReads: boolean[] = [];
  let cancellationOrigin: GenerationCancellationOrigin | undefined;
  let answer: (prompt: ToolApprovalPrompt) => void = () => undefined;
  const approvals = new ToolApprovalCoordinator((prompt) => {
    cards.push(prompt);
    queueMicrotask(() => answer(prompt));
  });
  let streams = 0;

  const stream = (chatId: string) => {
    const streamId = `s-${++streams}`;
    return {
      streamId,
      gate: createComputerUseAccessGate({
        readGrant: async () =>
          settings.computerUseAlwaysAllow === true ||
          (await chatStore.get(chatId))?.computerUseAllowed === true,
        status: async ({ force }) => {
          forcedStatusReads.push(force === true);
          return status;
        },
        requestAccess: async (toolCallId, signal) => {
          const outcome = await approvals.request(
            {
              streamId,
              toolCallId,
              toolName: "computer_use",
              summary: "Use your computer in this chat.",
              scopes: COMPUTER_USE_ACCESS_SCOPES,
            },
            signal,
          );
          const scope =
            outcome === "allowed"
              ? approvals.takeDecisionPayload(streamId, toolCallId)?.scope
              : undefined;
          return { outcome, scope };
        },
        grantChat: () => chatStore.setComputerUseAllowed(chatId, true),
        grantAlways: async () => {
          settings.computerUseAlwaysAllow = true;
        },
        setPendingContinue: (pending) => chatStore.setComputerUsePendingContinue(chatId, pending),
        cancellationOrigin: () => cancellationOrigin,
        warn: () => undefined,
      }),
    };
  };

  return {
    chatStore,
    settings,
    cards,
    approvals,
    forcedStatusReads,
    stream,
    setStatus(next: typeof status) {
      status = next;
    },
    /** Stop or quit: record the origin, then cancel the stream's card. */
    cancel(streamId: string, origin: GenerationCancellationOrigin) {
      cancellationOrigin = origin;
      approvals.cancelStream(streamId);
    },
    /** The user answers every later card this way. */
    willAnswer(allowed: boolean, scope?: ToolApprovalScope) {
      answer = (prompt) => {
        approvals.decide(prompt.approvalId, allowed, undefined, scope ? { scope } : undefined);
      };
    },
    /** Leave later cards unanswered so the test can settle them itself. */
    willWait() {
      answer = () => undefined;
    },
  };
}

test("the first call in an ungranted chat raises one card offering this chat or always, with no once", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.willAnswer(true, "chat");

  const decision = await d.stream(chat.id).gate.authorize("call-1");

  assert.deepEqual(decision, { allowed: true });
  assert.equal(d.cards.length, 1);
  assert.equal(d.cards[0]?.toolName, "computer_use");
  assert.deepEqual([...(d.cards[0]?.scopes ?? [])].sort(), ["always", "chat"]);
});

test("a deny blocks, and later calls in the same response are blocked without another card", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.willAnswer(false);
  const { gate } = d.stream(chat.id);

  assert.deepEqual(await gate.authorize("call-1"), {
    allowed: false,
    reason: COMPUTER_USE_DECLINED_REASON,
  });
  assert.deepEqual(await gate.authorize("call-2"), {
    allowed: false,
    reason: COMPUTER_USE_DECLINED_REASON,
  });
  assert.equal(d.cards.length, 1);
  assert.equal((await d.chatStore.get(chat.id))?.computerUseAllowed, undefined);

  // The next user message starts a new response, which may ask again.
  d.willAnswer(true, "chat");
  assert.deepEqual(await d.stream(chat.id).gate.authorize("call-3"), { allowed: true });
  assert.equal(d.cards.length, 2);
});

test("allow for this chat persists the grant, so later calls and later responses ask nothing", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  const other = await d.chatStore.create({ title: "Other" });
  d.willAnswer(true, "chat");
  const first = d.stream(chat.id).gate;

  assert.deepEqual(await first.authorize("call-1"), { allowed: true });
  assert.equal((await d.chatStore.get(chat.id))?.computerUseAllowed, true);
  assert.deepEqual(await first.authorize("call-2"), { allowed: true });
  assert.deepEqual(await d.stream(chat.id).gate.authorize("call-3"), { allowed: true });
  assert.equal(d.cards.length, 1);
  assert.equal(d.settings.computerUseAlwaysAllow, undefined);

  // The grant belongs to that chat only.
  d.willAnswer(false);
  assert.equal((await d.stream(other.id).gate.authorize("call-4")).allowed, false);
  assert.equal(d.cards.length, 2);
});

test("always allow sets the global setting and skips the card in a new chat", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.willAnswer(true, "always");

  assert.deepEqual(await d.stream(chat.id).gate.authorize("call-1"), { allowed: true });
  assert.equal(d.settings.computerUseAlwaysAllow, true);

  const fresh = await d.chatStore.create({ title: "Fresh" });
  d.willAnswer(false);
  assert.deepEqual(await d.stream(fresh.id).gate.authorize("call-2"), { allowed: true });
  assert.equal(d.cards.length, 1);
  assert.equal((await d.chatStore.get(fresh.id))?.computerUseAllowed, undefined);
});

for (const scope of [undefined, "once"] as const) {
  test(`a ${scope ?? "bare"} allow (a phone's Allow once) covers only this response and saves nothing`, async (t) => {
    const d = await desktop(t);
    const chat = await d.chatStore.create({ title: "Notes" });
    d.willAnswer(true, scope);
    const { gate } = d.stream(chat.id);

    assert.deepEqual(await gate.authorize("call-1"), { allowed: true });
    assert.deepEqual(await gate.authorize("call-2"), { allowed: true });
    assert.equal(d.cards.length, 1);
    assert.equal((await d.chatStore.get(chat.id))?.computerUseAllowed, undefined);
    assert.equal(d.settings.computerUseAlwaysAllow, undefined);

    // The next response in the same chat asks again.
    d.willAnswer(false);
    assert.equal((await d.stream(chat.id).gate.authorize("call-3")).allowed, false);
    assert.equal(d.cards.length, 2);
  });
}

test("missing permissions mark the chat to continue; an allow before setup finishes still blocks", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.setStatus(NEEDS_PERMISSIONS);
  d.willWait();
  const { gate } = d.stream(chat.id);

  const pending = gate.authorize("call-1");
  while (d.cards.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await d.chatStore.get(chat.id))?.computerUsePendingContinue, true);

  d.approvals.decide(d.cards[0]!.approvalId, true, undefined, { scope: "chat" });
  assert.deepEqual(await pending, { allowed: false, reason: COMPUTER_USE_SETUP_REASON });
  const stored = await d.chatStore.get(chat.id);
  // Still not ready, so the chat keeps its Continue marker for after setup.
  assert.equal(stored?.computerUsePendingContinue, true);
  assert.equal(stored?.computerUseAllowed, true);
  // The decision re-probes rather than trusting the status cached before the card.
  assert.equal(d.forcedStatusReads[d.forcedStatusReads.length - 1], true);

  // A later (or parallel) call in the same response does not raise the card again.
  assert.deepEqual(await gate.authorize("call-2"), { allowed: false, reason: COMPUTER_USE_SETUP_REASON });
  assert.equal(d.cards.length, 1);
});

test("an allow after the user finishes setup during the card lets the call run", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.setStatus(NEEDS_PERMISSIONS);
  d.willWait();
  const authorizing = d.stream(chat.id).gate.authorize("call-1");
  while (d.cards.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await d.chatStore.get(chat.id))?.computerUsePendingContinue, true);

  // The user grants the macOS permissions, then allows on the card.
  d.setStatus(READY);
  d.approvals.decide(d.cards[0]!.approvalId, true, undefined, { scope: "chat" });

  assert.deepEqual(await authorizing, { allowed: true });
  assert.equal((await d.chatStore.get(chat.id))?.computerUsePendingContinue, undefined);
});

test("a granted chat on a Mac that lost its permissions asks for setup without another card", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  await d.chatStore.setComputerUseAllowed(chat.id, true);
  d.setStatus(NEEDS_PERMISSIONS);
  d.willAnswer(false);
  const { gate } = d.stream(chat.id);

  const decisions = await Promise.all([gate.authorize("call-1"), gate.authorize("call-2")]);

  assert.deepEqual(decisions, [
    { allowed: false, reason: COMPUTER_USE_SETUP_REASON },
    { allowed: false, reason: COMPUTER_USE_SETUP_REASON },
  ]);
  assert.equal(d.cards.length, 0);
  const stored = await d.chatStore.get(chat.id);
  assert.equal(stored?.computerUseAllowed, true);
  assert.equal(stored?.computerUsePendingContinue, true);
});

test("app quit during a setup card keeps the continue marker for after restart", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.setStatus(NEEDS_PERMISSIONS);
  d.willWait();
  const { gate, streamId } = d.stream(chat.id);

  const pending = gate.authorize("call-1");
  while (d.cards.length === 0) await new Promise((resolve) => setImmediate(resolve));
  d.cancel(streamId, "application_shutdown");

  const decision = await pending;
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /cancelled/u);
  assert.equal((await d.chatStore.get(chat.id))?.computerUsePendingContinue, true);
  assert.equal((await d.chatStore.get(chat.id))?.computerUseAllowed, undefined);
});

test("Stop during a setup card clears the continue marker", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.setStatus(NEEDS_PERMISSIONS);
  d.willWait();
  const { gate, streamId } = d.stream(chat.id);

  const pending = gate.authorize("call-1");
  while (d.cards.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await d.chatStore.get(chat.id))?.computerUsePendingContinue, true);
  d.cancel(streamId, "user_stop");

  assert.equal((await pending).allowed, false);
  const stored = await d.chatStore.get(chat.id);
  assert.equal(stored?.computerUsePendingContinue, undefined);
  assert.equal(stored?.computerUseAllowed, undefined);
});

test("once a response runs Computer Use on a ready Mac, later calls skip the readiness probe", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  await d.chatStore.setComputerUseAllowed(chat.id, true);
  const { gate } = d.stream(chat.id);

  assert.deepEqual(await gate.authorize("call-1"), { allowed: true });
  const probes = d.forcedStatusReads.length;
  d.setStatus(NEEDS_PERMISSIONS);
  assert.deepEqual(await gate.authorize("call-2"), { allowed: true });
  assert.equal(d.forcedStatusReads.length, probes);
});

test("revoking grants makes a running response ask again on its next call", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.willAnswer(true, "always");
  const { gate } = d.stream(chat.id);
  assert.deepEqual(await gate.authorize("call-1"), { allowed: true });
  assert.equal(d.cards.length, 1);

  // Settings turns Always allow off.
  d.settings.computerUseAlwaysAllow = false;
  revokeComputerUseGrants();
  d.willAnswer(false);

  assert.deepEqual(await gate.authorize("call-2"), {
    allowed: false,
    reason: COMPUTER_USE_DECLINED_REASON,
  });
  assert.equal(d.cards.length, 2);
});

test("reset chat permissions clears every chat's grant and Always allow, and stops live Computer Use", async (t) => {
  const d = await desktop(t);
  const first = await d.chatStore.create({ title: "First" });
  const second = await d.chatStore.create({ title: "Second" });
  const untouched = await d.chatStore.create({ title: "Untouched" });
  await d.chatStore.setComputerUseAllowed(first.id, true);
  await d.chatStore.setComputerUseAllowed(second.id, true);
  d.settings.computerUseAlwaysAllow = true;
  const { gate } = d.stream(first.id);
  assert.deepEqual(await gate.authorize("call-1"), { allowed: true });
  let cancelled = 0;

  const result = await resetComputerUseGrants({
    cancelActivatedStreams: () => {
      cancelled += 1;
    },
    clearAlwaysAllow: async () => {
      d.settings.computerUseAlwaysAllow = false;
    },
    clearChatGrants: () => d.chatStore.clearAllComputerUseAllowed(),
  });

  assert.deepEqual(result, { cleared: 2 });
  assert.equal(cancelled, 1);
  assert.equal(d.settings.computerUseAlwaysAllow, false);
  for (const chat of [first, second, untouched]) {
    assert.equal((await d.chatStore.get(chat.id))?.computerUseAllowed, undefined);
  }
  // A stream that already ran Computer Use asks again.
  d.willAnswer(false);
  assert.equal((await gate.authorize("call-2")).allowed, false);
  assert.equal(d.cards.length, 1);
});

test("a response that starts while reset is still clearing grants cannot keep a cleared grant", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  await d.chatStore.setComputerUseAllowed(chat.id, true);
  let releaseClear: () => void = () => undefined;
  const clearing = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });

  const reset = resetComputerUseGrants({
    cancelActivatedStreams: () => undefined,
    clearAlwaysAllow: async () => undefined,
    clearChatGrants: async () => {
      await clearing;
      return d.chatStore.clearAllComputerUseAllowed();
    },
  });
  // Admitted after reset began, while the chat's grant is still stored.
  const { gate } = d.stream(chat.id);
  assert.deepEqual(await gate.authorize("call-1"), {
    allowed: false,
    reason: COMPUTER_USE_RESETTING_REASON,
  });
  releaseClear();
  await reset;

  d.willAnswer(false);
  assert.equal((await gate.authorize("call-2")).allowed, false);
  assert.equal(d.cards.length, 1, "after reset the chat asks again instead of reusing the old grant");
});

test("an unsupported Mac or build blocks with its own detail and never raises a card", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.setStatus({
    ready: false,
    available: false,
    detail: "Computer Use requires a signed packaged build of Aiden.",
  });
  d.willAnswer(true, "chat");

  assert.deepEqual(await d.stream(chat.id).gate.authorize("call-1"), {
    allowed: false,
    reason: "Computer Use requires a signed packaged build of Aiden.",
  });
  assert.equal(d.cards.length, 0);
  assert.equal((await d.chatStore.get(chat.id))?.computerUsePendingContinue, undefined);
});

test("parallel first calls share one card", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.willAnswer(true, "chat");
  const { gate } = d.stream(chat.id);

  const decisions = await Promise.all([gate.authorize("call-1"), gate.authorize("call-2")]);

  assert.deepEqual(decisions, [{ allowed: true }, { allowed: true }]);
  assert.equal(d.cards.length, 1);
});
