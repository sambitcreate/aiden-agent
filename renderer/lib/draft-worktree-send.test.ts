// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { chatsApi } from "./ipc";
import {
  isWorktreeSendCancelled,
  startWorktreeFirstSend,
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

function start(views: WorktreeSendView[]) {
  return startWorktreeFirstSend({
    api: {
      createInWorktree: chatsApi.createWithFirstMessageInWorktree,
      createInCheckout: chatsApi.createWithFirstMessage,
      onProgress: chatsApi.onFirstMessageWorktreeProgress,
    },
    input: INPUT,
    worktree: REQUEST,
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
