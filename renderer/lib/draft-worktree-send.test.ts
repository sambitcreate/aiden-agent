// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { chatsApi } from "./ipc";
import {
  activeWorktreeSend,
  continueWorktreeSendInView,
  isWorktreeSendCancelled,
  registerWorktreeSendContinuation,
  startWorktreeFirstSend,
  subscribeActiveWorktreeSends,
  type WorktreeSendView,
} from "./draft-worktree-send";
import type { Chat } from "./types";
import type { FirstMessageWorktreeRequest } from "../shared/worktree-on-send";

// The draft's first send through the real `chatsApi` wrappers over a fake
// main process: what is sent on each attempt, and what the user sees.

const DRAFT_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const PROGRESS = "chats:first-message-worktree-progress";

const REQUEST: FirstMessageWorktreeRequest = {
  sourceWorkspaceId: "ws-repo",
  baseRef: "main",
  fromOrigin: true,
  idempotencyKey: DRAFT_ID,
};

const INPUT = {
  draftId: DRAFT_ID,
  workspaceId: "ws-repo",
  providerId: "lmstudio",
  model: "m",
  turnId: "turn-1",
  message: { role: "user" as const, content: "Fix the login bug" },
};

function savedChat(workspaceId: string): Chat {
  return { id: DRAFT_ID, workspaceId, title: "Fix the login bug", messages: [], createdAt: 1, updatedAt: 1 } as Chat;
}

const WORKTREE_INFO = {
  workspaceId: "ws-worktree",
  branch: "aiden/fix-the-login-bug",
  baseRef: "main",
  startPoint: "origin/main",
  baseCommit: "a".repeat(40),
  baseSource: "fetched" as const,
  reused: false,
};

let calls: BotTestIpcCall[];
let replies: unknown[];

beforeEach(() => {
  replies = [];
  calls = installBotTestIpc({
    "chats:createWithFirstMessage": (input) => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("No reply queued");
      const worktree = (input as { worktree?: unknown }).worktree;
      return typeof reply === "function" ? (reply as (worktree: unknown) => unknown)(worktree) : reply;
    },
  });
});

function start(views: WorktreeSendView[], draftId = DRAFT_ID) {
  return startWorktreeFirstSend({
    api: {
      createInWorktree: chatsApi.createWithFirstMessageInWorktree,
      createInCheckout: chatsApi.createWithFirstMessage,
      onProgress: chatsApi.onFirstMessageWorktreeProgress,
    },
    input: { ...INPUT, draftId },
    worktree: { ...REQUEST, idempotencyKey: draftId },
    message: { text: INPUT.message.content, attachments: [] },
    onView: (view) => views.push(view),
  });
}

function sent(): Array<{ worktree?: FirstMessageWorktreeRequest }> {
  return calls
    .filter((call) => call.channel === "chats:createWithFirstMessage")
    .map((call) => call.args[0] as { worktree?: FirstMessageWorktreeRequest });
}

async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a successful send reports this draft's progress and returns the chat saved in the new worktree", async () => {
  let finish!: (value: unknown) => void;
  replies.push(() => new Promise((resolve) => { finish = resolve; }));
  const views: WorktreeSendView[] = [];
  const send = start(views);
  await nextTick();
  emitBotTestNotification(PROGRESS, { draftId: DRAFT_ID, phase: "fetching", startPoint: "origin/main" });
  emitBotTestNotification(PROGRESS, { draftId: "11111111-2222-4333-8444-555555555555", phase: "creating", branch: "other" });
  emitBotTestNotification(PROGRESS, {
    draftId: DRAFT_ID,
    phase: "creating",
    branch: "aiden/fix-the-login-bug",
    startPoint: "origin/main",
  });
  finish({ ok: true, chat: savedChat("ws-worktree"), worktree: WORKTREE_INFO });
  const outcome = await send.result;

  assert.equal(outcome.chat.workspaceId, "ws-worktree");
  assert.equal(outcome.worktree?.branch, "aiden/fix-the-login-bug");
  assert.deepEqual(sent().map((input) => input.worktree), [REQUEST]);
  assert.deepEqual(
    views.map((view) => [view.status, view.progress.phase, view.progress.branch]),
    [
      ["running", undefined, undefined],
      ["running", "fetching", undefined],
      ["running", "creating", "aiden/fix-the-login-bug"],
    ],
    "another draft's progress is ignored",
  );
  emitBotTestNotification(PROGRESS, { draftId: DRAFT_ID, phase: "ready", branch: "late" });
  assert.equal(views.length, 3, "nothing is shown after the send settles");
});

test("a failure waits for the user; Retry resends with the same idempotency key", async () => {
  replies.push(
    { ok: false, code: "worktree-failed", reason: "Couldn't fetch origin.", detail: "fatal: unable to access" },
    { ok: true, chat: savedChat("ws-worktree"), worktree: { ...WORKTREE_INFO, reused: false } },
  );
  const views: WorktreeSendView[] = [];
  const send = start(views);
  await nextTick();
  const failed = views[views.length - 1];
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.status === "failed" ? failed.reason : "", "Couldn't fetch origin.");
  assert.equal(failed?.status === "failed" ? failed.detail : "", "fatal: unable to access");
  assert.equal(sent().length, 1, "nothing is retried until the user chooses");

  send.decide("retry");
  const outcome = await send.result;
  assert.equal(outcome.chat.workspaceId, "ws-worktree");
  assert.deepEqual(
    sent().map((input) => input.worktree?.idempotencyKey),
    [DRAFT_ID, DRAFT_ID],
  );
});

test("Run in this checkout instead sends the same message without a worktree", async () => {
  replies.push(
    { ok: false, code: "worktree-failed", reason: "Not enough free space." },
    savedChat("ws-repo"),
  );
  const views: WorktreeSendView[] = [];
  const send = start(views);
  await nextTick();
  send.decide("checkout");
  const outcome = await send.result;
  assert.equal(outcome.chat.workspaceId, "ws-repo");
  assert.equal(outcome.worktree, undefined);
  assert.equal(outcome.keptWorktreeBranch, undefined, "no worktree was made, so none is kept");
  const [, plain] = sent();
  assert.equal(plain?.worktree, undefined, "the second request is the plain first-message send");
  assert.equal((plain as typeof INPUT | undefined)?.message.content, "Fix the login bug");
  assert.equal(views[views.length - 1]?.status, "checkout");
});

test("Cancel rejects as a cancellation, so the composer gets the text back quietly", async () => {
  replies.push({ ok: false, code: "worktree-failed", reason: "Couldn't create the worktree." });
  const send = start([]);
  await nextTick();
  send.decide("cancel");
  await assert.rejects(send.result, (error) => isWorktreeSendCancelled(error));
  assert.equal(sent().length, 1);
  assert.equal(isWorktreeSendCancelled(new Error("other")), false);
});

test("settings that changed since an earlier attempt offer the worktree that attempt created", async () => {
  replies.push(
    {
      ok: false,
      code: "worktree-settings-changed",
      reason: "This chat already has a worktree on aiden/first-try.",
      // That attempt asked for Auto, from develop, without fetching.
      worktree: { workspaceId: "ws-worktree", branch: "aiden/first-try", baseRef: "develop", fromOrigin: false },
    },
    { ok: true, chat: savedChat("ws-worktree"), worktree: { ...WORKTREE_INFO, reused: true } },
  );
  const views: WorktreeSendView[] = [];
  const send = start(views);
  await nextTick();
  const failed = views[views.length - 1];
  assert.equal(failed?.status === "failed" ? failed.existing?.branch : undefined, "aiden/first-try");
  send.decide("use-existing");
  await send.result;
  const [, second] = sent();
  assert.deepEqual(second?.worktree, { ...REQUEST, baseRef: "develop", fromOrigin: false });
});

test("an IPC rejection fails the send like any other first message", async () => {
  replies.push(() => {
    throw new Error("Main is unavailable.");
  });
  const send = start([]);
  await assert.rejects(send.result, /Main is unavailable/u);
});

const OTHER_DRAFT = "7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c";

test("a failure stays with its draft until answered, even with no view open", async () => {
  replies.push(
    { ok: false, code: "worktree-failed", reason: "Couldn't create the worktree." },
    { ok: true, chat: savedChat("ws-worktree"), worktree: WORKTREE_INFO },
  );
  let changes = 0;
  const unsubscribe = subscribeActiveWorktreeSends(() => { changes += 1; });
  // Nothing renders the send: the user left the draft while it ran.
  const send = startWorktreeFirstSend({
    api: {
      createInWorktree: chatsApi.createWithFirstMessageInWorktree,
      createInCheckout: chatsApi.createWithFirstMessage,
      onProgress: chatsApi.onFirstMessageWorktreeProgress,
    },
    input: INPUT,
    worktree: REQUEST,
    message: { text: "Fix the login bug", attachments: [] },
  });
  await nextTick();
  await nextTick();
  // Coming back, the draft's view finds the failure and answers it.
  const returned = activeWorktreeSend(DRAFT_ID);
  assert.equal(returned?.view.status, "failed");
  assert.equal(returned?.text, "Fix the login bug");
  assert.ok(changes > 0, "views are told the send changed");
  returned!.decide("retry");
  const outcome = await send.result;
  assert.equal(outcome.chat.workspaceId, "ws-worktree");
  assert.equal(activeWorktreeSend(DRAFT_ID)?.view.status, "running", "kept until the caller releases it");
  send.release();
  assert.equal(activeWorktreeSend(DRAFT_ID), undefined);
  unsubscribe();
});

test("two drafts' worktree sends never answer or show each other's state", async () => {
  let finishOther!: (value: unknown) => void;
  replies.push(
    { ok: false, code: "worktree-failed", reason: "First draft failed." },
    () => new Promise((resolve) => { finishOther = resolve; }),
  );
  const first = start([], DRAFT_ID);
  await nextTick();
  const second = start([], OTHER_DRAFT);
  await nextTick();
  emitBotTestNotification(PROGRESS, { draftId: OTHER_DRAFT, phase: "creating", branch: "aiden/other" });

  assert.equal(activeWorktreeSend(DRAFT_ID)?.view.status, "failed");
  assert.equal(activeWorktreeSend(OTHER_DRAFT)?.view.status, "running");
  assert.equal(activeWorktreeSend(OTHER_DRAFT)?.view.progress.branch, "aiden/other");
  assert.equal(activeWorktreeSend(DRAFT_ID)?.view.progress.branch, undefined);

  // Answering the running draft does nothing to the failed one.
  activeWorktreeSend(OTHER_DRAFT)!.decide("cancel");
  assert.equal(activeWorktreeSend(DRAFT_ID)?.view.status, "failed");
  activeWorktreeSend(DRAFT_ID)!.decide("cancel");
  await assert.rejects(first.result, (error) => isWorktreeSendCancelled(error));
  first.release();
  assert.equal(activeWorktreeSend(DRAFT_ID), undefined);
  assert.equal(activeWorktreeSend(OTHER_DRAFT)?.view.status, "running");

  finishOther({ ok: true, chat: savedChat("ws-worktree"), worktree: WORKTREE_INFO });
  assert.equal((await second.result).chat.workspaceId, "ws-worktree");
  second.release();
});

test("running in this checkout after a worktree was made reports the worktree as kept", async () => {
  replies.push(
    {
      ok: false,
      code: "worktree-settings-changed",
      reason: "This draft already created worktree aiden/first-try from main.",
      worktree: { workspaceId: "ws-worktree", branch: "aiden/first-try", baseRef: "main", fromOrigin: false },
    },
    savedChat("ws-repo"),
    () => new Promise(() => undefined),
  );
  const send = start([]);
  await nextTick();
  send.decide("checkout");
  assert.equal((await send.result).keptWorktreeBranch, "aiden/first-try");
  send.release();

  // A worktree that reported ready before the chat failed to save is kept too.
  replies.length = 0;
  replies.push(
    () => {
      emitBotTestNotification(PROGRESS, { draftId: OTHER_DRAFT, phase: "ready", branch: "aiden/made-it" });
      return { ok: false, code: "worktree-failed", reason: "Aiden couldn't save the chat." };
    },
    savedChat("ws-repo"),
  );
  const saved = start([], OTHER_DRAFT);
  await nextTick();
  saved.decide("checkout");
  assert.equal((await saved.result).keptWorktreeBranch, "aiden/made-it");
  saved.release();
});

test("a save after the user answered a failure says so; one that needed no answer does not", async () => {
  replies.push({ ok: true, chat: savedChat("ws-worktree"), worktree: WORKTREE_INFO });
  const direct = start([]);
  assert.equal((await direct.result).answered, false);
  direct.release();

  replies.push(
    { ok: false, code: "worktree-failed", reason: "Couldn't create the worktree." },
    savedChat("ws-repo"),
  );
  const answered = start([]);
  await nextTick();
  activeWorktreeSend(DRAFT_ID)!.decide("checkout");
  assert.equal((await answered.result).answered, true);
  answered.release();
});

test("a continued send's reply starts in the view now showing the chat, once, and only there", () => {
  const started: Array<[string, string, string | undefined]> = [];
  const leave = registerWorktreeSendContinuation(DRAFT_ID, (turnId, workspaceId) => {
    started.push(["first view", turnId, workspaceId]);
  });
  // The pane that took over replaces the one that left.
  const unregisterReturned = registerWorktreeSendContinuation(DRAFT_ID, (turnId, workspaceId) => {
    started.push(["returned view", turnId, workspaceId]);
  });
  leave();
  assert.equal(continueWorktreeSendInView(DRAFT_ID, "turn-1", "ws-worktree"), true);
  assert.deepEqual(started, [["returned view", "turn-1", "ws-worktree"]]);
  assert.equal(continueWorktreeSendInView(OTHER_DRAFT, "turn-2", undefined), false, "no view shows that chat");
  unregisterReturned();
  assert.equal(continueWorktreeSendInView(DRAFT_ID, "turn-3", undefined), false, "nobody is looking: abandon");
  assert.equal(started.length, 1);
});
