import assert from "node:assert/strict";
import test from "node:test";
import {
  beginChatDraftSend, createChatDraft, discardChatDraft, findReusableChatDraft, finishChatDraftSend,
  getChatDraft, listChatDrafts, requestChatDraftComposerFocus, retainChatDraft, setChatDraftHasContent,
  subscribeChatDraftComposerFocus, subscribeChatDrafts, updateChatDraft,
} from "./chat-draft";

const flush = async () => { await Promise.resolve(); };

test("leaving an unsent draft drops its renderer-only state", async () => {
  const draft = createChatDraft("workspace-a");
  const release = retainChatDraft(draft.chat.id);
  updateChatDraft(draft.chat.id, { workspaceId: "workspace-b" });
  assert.equal(getChatDraft(draft.chat.id)?.chat.workspaceId, "workspace-b");
  assert.deepEqual(draft.chat.messages, []);
  release();
  await flush();
  assert.equal(getChatDraft(draft.chat.id), undefined);
});

test("an explicit entry point can seed only its new renderer draft", () => {
  const seeded = createChatDraft("workspace-a", undefined, "Create an automation that ");
  const releaseSeeded = retainChatDraft(seeded.chat.id);
  const ordinary = createChatDraft("workspace-a");
  assert.equal(seeded.initialText, "Create an automation that ");
  assert.equal(ordinary.initialText, undefined);
  assert.equal(beginChatDraftSend(seeded.chat.id).initialText, "Create an automation that ");
  finishChatDraftSend(seeded.chat.id, true);
  releaseSeeded();
  discardChatDraft(ordinary.chat.id);
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
  updateChatDraft(chat.id, { title: "Renamed draft" });
  const submitted = beginChatDraftSend(chat.id);
  assert.equal(submitted.chat.title, "Renamed draft");
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
  const releaseFirst = retainChatDraft(first.chat.id);
  const second = createChatDraft("workspace-b");
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


test("superseded new activations discard unowned drafts while preserving mounted and sending drafts", async () => {
  const mounted = createChatDraft("workspace-a");
  const releaseMounted = retainChatDraft(mounted.chat.id);
  const sending = createChatDraft("workspace-b");
  const releaseSending = retainChatDraft(sending.chat.id);
  beginChatDraftSend(sending.chat.id);
  releaseSending();
  await flush();
  const superseded = createChatDraft("workspace-c");
  const latest = createChatDraft("workspace-d");
  assert.equal(getChatDraft(superseded.chat.id), undefined);
  assert.equal(getChatDraft(mounted.chat.id), mounted);
  assert.equal(getChatDraft(sending.chat.id)?.sending, true);
  assert.equal(getChatDraft(latest.chat.id), latest);
  releaseMounted();
  finishChatDraftSend(sending.chat.id, false);
  discardChatDraft(latest.chat.id);
  await flush();
});

test("only an open, empty, idle draft in the same workspace is reused", async () => {
  const draft = createChatDraft("workspace-a");
  // Not yet mounted: about to be superseded, so never handed back.
  assert.equal(findReusableChatDraft("workspace-a"), undefined);
  const release = retainChatDraft(draft.chat.id);
  assert.equal(findReusableChatDraft("workspace-a")?.chat.id, draft.chat.id);
  assert.equal(findReusableChatDraft("workspace-b"), undefined);

  setChatDraftHasContent(draft.chat.id, true);
  assert.equal(findReusableChatDraft("workspace-a"), undefined, "typed text or attachments");
  setChatDraftHasContent(draft.chat.id, false);
  assert.equal(findReusableChatDraft("workspace-a")?.chat.id, draft.chat.id, "cleared again");

  updateChatDraft(draft.chat.id, { workspaceId: "workspace-b" });
  assert.equal(findReusableChatDraft("workspace-a"), undefined, "the draft moved away");
  assert.equal(findReusableChatDraft("workspace-b")?.chat.id, draft.chat.id);

  beginChatDraftSend(draft.chat.id);
  assert.equal(findReusableChatDraft("workspace-b"), undefined, "a sending draft is never reused");
  finishChatDraftSend(draft.chat.id, true);
  release();
  await flush();
});

test("a seeded draft starts with content, and content changes notify subscribers once", async () => {
  const seeded = createChatDraft("workspace-a", undefined, "Create an automation that ");
  const releaseSeeded = retainChatDraft(seeded.chat.id);
  assert.equal(findReusableChatDraft("workspace-a"), undefined);
  let changes = 0;
  const unsubscribe = subscribeChatDrafts(() => { changes += 1; });
  setChatDraftHasContent(seeded.chat.id, true);
  assert.equal(changes, 0, "unchanged content state is not a change");
  setChatDraftHasContent(seeded.chat.id, false);
  assert.equal(changes, 1);
  setChatDraftHasContent("missing-draft", true);
  assert.equal(changes, 1);
  unsubscribe();
  releaseSeeded();
  await flush();
});

test("composer focus reaches a mounted draft now and a later-mounted draft once", () => {
  let mountedFocus = 0;
  const unsubscribeMounted = subscribeChatDraftComposerFocus("mounted", () => { mountedFocus += 1; });
  requestChatDraftComposerFocus("mounted");
  requestChatDraftComposerFocus("mounted");
  assert.equal(mountedFocus, 2, "every request for an open draft focuses it, e.g. a reused draft");
  unsubscribeMounted();

  requestChatDraftComposerFocus("pending");
  let pendingFocus = 0;
  const unsubscribePending = subscribeChatDraftComposerFocus("pending", () => { pendingFocus += 1; });
  assert.equal(pendingFocus, 1, "a draft that mounts after navigation takes the request");
  unsubscribePending();
  const resubscribe = subscribeChatDraftComposerFocus("pending", () => { pendingFocus += 1; });
  assert.equal(pendingFocus, 1, "the pending request is consumed once");
  resubscribe();

  const { chat } = createChatDraft("workspace-a");
  requestChatDraftComposerFocus(chat.id);
  discardChatDraft(chat.id);
  let discardedFocus = 0;
  const unsubscribeDiscarded = subscribeChatDraftComposerFocus(chat.id, () => { discardedFocus += 1; });
  assert.equal(discardedFocus, 0, "a discarded draft drops its pending focus");
  unsubscribeDiscarded();
});

test("a draft with text outlives its view until it is sent or cleared; an empty one does not", async () => {
  const typed = createChatDraft("workspace-a");
  const releaseTyped = retainChatDraft(typed.chat.id);
  setChatDraftHasContent(typed.chat.id, true);
  const empty = createChatDraft("workspace-a");
  const releaseEmpty = retainChatDraft(empty.chat.id);
  releaseTyped();
  releaseEmpty();
  await flush();
  assert.equal(getChatDraft(empty.chat.id), undefined);
  assert.ok(getChatDraft(typed.chat.id), "leaving a draft with text keeps it");
  assert.deepEqual(listChatDrafts().map(({ chat }) => chat.id), [typed.chat.id]);

  // Another New activation does not sweep it either.
  const next = createChatDraft("workspace-b");
  assert.ok(getChatDraft(typed.chat.id));
  discardChatDraft(next.chat.id);

  // Reopened and cleared, then left: now it goes.
  const reopened = retainChatDraft(typed.chat.id);
  setChatDraftHasContent(typed.chat.id, false);
  reopened();
  await flush();
  assert.equal(getChatDraft(typed.chat.id), undefined);
  assert.deepEqual(listChatDrafts(), []);

  // Reopened and sent: the committed draft goes away.
  const sent = createChatDraft("workspace-a");
  const releaseSent = retainChatDraft(sent.chat.id);
  setChatDraftHasContent(sent.chat.id, true);
  releaseSent();
  await flush();
  const reopenedSent = retainChatDraft(sent.chat.id);
  beginChatDraftSend(sent.chat.id);
  finishChatDraftSend(sent.chat.id, true);
  reopenedSent();
  await flush();
  assert.equal(getChatDraft(sent.chat.id), undefined);
});

test("a failed first send from a draft that was left keeps the draft and its text", async () => {
  const { chat } = createChatDraft("workspace-a");
  const release = retainChatDraft(chat.id);
  setChatDraftHasContent(chat.id, true);
  beginChatDraftSend(chat.id);
  release();
  await flush();
  finishChatDraftSend(chat.id, false);
  assert.equal(getChatDraft(chat.id)?.sending, false);
  discardChatDraft(chat.id);
});

test("the draft list is a stable snapshot between changes", () => {
  const first = listChatDrafts();
  assert.equal(listChatDrafts(), first);
  const { chat } = createChatDraft("workspace-a");
  const second = listChatDrafts();
  assert.notEqual(second, first);
  assert.equal(listChatDrafts(), second);
  discardChatDraft(chat.id);
});
