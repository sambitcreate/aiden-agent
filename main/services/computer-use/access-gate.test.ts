import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { COMPUTER_USE_ACCESS_SCOPES } from "../../../renderer/shared/computer-use-access.js";
import type { ToolApprovalScope } from "../../../renderer/shared/tool-approval-scope.js";
import { createChatStore } from "../chat-store-core.js";
import { ToolApprovalCoordinator, type ToolApprovalPrompt } from "../tool-approval.js";
import {
  COMPUTER_USE_DECLINED_REASON,
  COMPUTER_USE_SETUP_REASON,
  createComputerUseAccessGate,
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

test("a bare allow from a client that sends no scope grants this chat", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.willAnswer(true);

  assert.deepEqual(await d.stream(chat.id).gate.authorize("call-1"), { allowed: true });
  assert.equal((await d.chatStore.get(chat.id))?.computerUseAllowed, true);
  assert.equal(d.settings.computerUseAlwaysAllow, undefined);
});

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
  assert.equal(stored?.computerUsePendingContinue, undefined);
  assert.equal(stored?.computerUseAllowed, true);
  // The decision re-probes rather than trusting the status cached before the card.
  assert.equal(d.forcedStatusReads[d.forcedStatusReads.length - 1], true);
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

test("a granted chat on a Mac that is not ready asks again and keeps the grant", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  await d.chatStore.setComputerUseAllowed(chat.id, true);
  d.setStatus(NEEDS_PERMISSIONS);
  d.willAnswer(false);

  assert.deepEqual(await d.stream(chat.id).gate.authorize("call-1"), {
    allowed: false,
    reason: COMPUTER_USE_DECLINED_REASON,
  });
  assert.equal(d.cards.length, 1);
  const stored = await d.chatStore.get(chat.id);
  assert.equal(stored?.computerUseAllowed, true);
  assert.equal(stored?.computerUsePendingContinue, undefined);
});

test("a card cancelled by Stop or app quit leaves the continue marker for after restart", async (t) => {
  const d = await desktop(t);
  const chat = await d.chatStore.create({ title: "Notes" });
  d.setStatus(NEEDS_PERMISSIONS);
  d.willWait();
  const { gate, streamId } = d.stream(chat.id);

  const pending = gate.authorize("call-1");
  while (d.cards.length === 0) await new Promise((resolve) => setImmediate(resolve));
  d.approvals.cancelStream(streamId);

  const decision = await pending;
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /cancelled/u);
  assert.equal((await d.chatStore.get(chat.id))?.computerUsePendingContinue, true);
  assert.equal((await d.chatStore.get(chat.id))?.computerUseAllowed, undefined);
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
