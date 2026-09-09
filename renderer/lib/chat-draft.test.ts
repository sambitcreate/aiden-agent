import assert from "node:assert/strict";
import test from "node:test";
import {
  beginChatDraftSend, createChatDraft, discardChatDraft, finishChatDraftSend,
  getChatDraft, retainChatDraft, subscribeChatDrafts, updateChatDraft,
} from "./chat-draft";

const flush = async () => { await Promise.resolve(); };

test("leaving an unsent draft drops its renderer-only state", async () => {
  const draft = createChatDraft("workspace-a");
  const release = retainChatDraft(draft.chat.id);
  updateChatDraft(draft.chat.id, { workspaceId: "workspace-b", computerUseEnabled: true });
  assert.equal(getChatDraft(draft.chat.id)?.chat.workspaceId, "workspace-b");
  assert.deepEqual(draft.chat.messages, []);
  release();
  await flush();
  assert.equal(getChatDraft(draft.chat.id), undefined);
});

test("StrictMode release and reacquire does not discard the mounted draft", async () => {
  const { chat } = createChatDraft("workspace-a");
  const firstRelease = retainChatDraft(chat.id);
  firstRelease();
  const secondRelease = retainChatDraft(chat.id);
  await flush();
  assert.ok(getChatDraft(chat.id));
  firstRelease(); // cleanup is idempotent
  assert.ok(getChatDraft(chat.id));
  secondRelease();
  await flush();
  assert.equal(getChatDraft(chat.id), undefined);
});

test("same-tick duplicate sends and settings edits are rejected while committing", () => {
  const { chat } = createChatDraft("workspace-a");
  const release = retainChatDraft(chat.id);
  updateChatDraft(chat.id, { computerUseEnabled: true });
  const submitted = beginChatDraftSend(chat.id);
  assert.equal(submitted.chat.computerUseEnabled, true);
  assert.throws(() => beginChatDraftSend(chat.id), /already being sent/u);
  assert.throws(() => updateChatDraft(chat.id, { workspaceId: "workspace-b" }), /finish saving/u);
  finishChatDraftSend(chat.id, false);
  assert.equal(getChatDraft(chat.id)?.sending, false);
  assert.equal(getChatDraft(chat.id)?.chat.workspaceId, "workspace-a");
  release();
});

test("an in-flight draft survives navigation until its operation settles", async () => {
  const { chat } = createChatDraft("workspace-a");
  const release = retainChatDraft(chat.id);
  beginChatDraftSend(chat.id);
  release();
  await flush();
  assert.equal(getChatDraft(chat.id)?.sending, true);
  finishChatDraftSend(chat.id, false);
  assert.equal(getChatDraft(chat.id), undefined);
});

test("successful promotion removes only the submitted draft and keeps its identity", () => {
  const first = createChatDraft("workspace-a");
  const second = createChatDraft("workspace-b");
  const releaseFirst = retainChatDraft(first.chat.id);
  const releaseSecond = retainChatDraft(second.chat.id);
  const submitted = beginChatDraftSend(first.chat.id);
  assert.equal(submitted.chat.id, first.chat.id);
  finishChatDraftSend(first.chat.id, true);
  assert.equal(getChatDraft(first.chat.id), undefined);
  assert.equal(getChatDraft(second.chat.id), second);
  finishChatDraftSend(first.chat.id, false); // finally after success is harmless
  assert.equal(getChatDraft(second.chat.id), second);
  releaseFirst();
  releaseSecond();
});

test("draft mutation subscriptions are removable and failed navigation can discard", () => {
  let changes = 0;
  const unsubscribe = subscribeChatDrafts(() => { changes += 1; });
  const { chat } = createChatDraft("workspace-a");
  assert.equal(changes, 1);
  discardChatDraft(chat.id);
  assert.equal(changes, 2);
  unsubscribe();
  discardChatDraft(chat.id);
  assert.equal(changes, 2);
});

test("reopening an in-flight draft retains its busy state and unlocks on definite failure", async () => {
  const { chat } = createChatDraft("workspace-a");
  const firstRelease = retainChatDraft(chat.id);
  beginChatDraftSend(chat.id);
  firstRelease();
  await flush();
  const reopenedRelease = retainChatDraft(chat.id);
  assert.equal(getChatDraft(chat.id)?.sending, true);
  assert.throws(() => beginChatDraftSend(chat.id), /already being sent/u);
  finishChatDraftSend(chat.id, false);
  assert.equal(getChatDraft(chat.id)?.sending, false);
  beginChatDraftSend(chat.id);
  finishChatDraftSend(chat.id, true);
  reopenedRelease();
});
