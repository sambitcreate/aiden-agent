import assert from "node:assert/strict";
import test from "node:test";
import { LiveChatNoteWatcher, liveChatEnding, type LiveChatActivity, type LiveChatEnding } from "./live-chat-notes";

function activity(input: { active?: string[]; approval?: string[]; input?: string[] } = {}): LiveChatActivity {
  return {
    activeChatIds: new Set(input.active ?? []),
    approvalChatIds: new Set(input.approval ?? []),
    inputChatIds: new Set(input.input ?? []),
  };
}

function harness(endings: Record<string, LiveChatEnding> = {}) {
  const notes: string[] = [];
  const watcher = new LiveChatNoteWatcher({
    note: (text) => notes.push(text),
    ending: async (chatId) => endings[chatId] ?? "finished",
  });
  return { notes, watcher, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("a chat Live sent to gets one note when its reply finishes or fails", async () => {
  const { notes, watcher, settle } = harness({ broken: "failed" });
  watcher.observe(activity());
  watcher.watch("fix", "Fix login");
  watcher.watch("broken", "Deploy");
  watcher.observe(activity({ active: ["fix", "broken"] }));
  watcher.observe(activity({ active: ["fix", "broken"] }));
  assert.deepEqual(notes, [], "nothing while they work");
  watcher.observe(activity());
  await settle();
  assert.deepEqual(notes, [
    "The chat “Fix login” finished its reply.",
    "The chat “Deploy” stopped with an error.",
  ]);
});

test("waiting for an approval or an answer is a note; a reply the person stopped is not", async () => {
  const { notes, watcher, settle } = harness({ fix: "stopped" });
  watcher.observe(activity({ active: ["fix"] }));
  watcher.watch("fix", "Fix login");
  watcher.observe(activity({ active: ["fix"], approval: ["fix"] }));
  watcher.observe(activity({ active: ["fix"], approval: ["fix"] }));
  watcher.observe(activity({ active: ["fix"], input: ["fix"] }));
  watcher.observe(activity());
  await settle();
  assert.deepEqual(notes, [
    "The chat “Fix login” is waiting for an approval.",
    "The chat “Fix login” has a question for the user.",
  ]);
});

test("the open chat is watched only while it is on screen; chats Live sent to stay watched", async () => {
  const { notes, watcher, settle } = harness();
  watcher.observe(activity({ active: ["open", "sent"] }));
  watcher.setOpenChat("open", "On screen");
  watcher.watch("sent", "Sent to");
  watcher.setOpenChat("sent", "Sent to");
  watcher.setOpenChat(null, "");
  assert.equal(watcher.isWatching("open"), false);
  assert.equal(watcher.isWatching("sent"), true);
  watcher.observe(activity());
  await settle();
  assert.deepEqual(notes, ["The chat “Sent to” finished its reply."]);
});

test("an ending read after the session ended sends nothing", async () => {
  let release!: (ending: LiveChatEnding) => void;
  const notes: string[] = [];
  const watcher = new LiveChatNoteWatcher({
    note: (text) => notes.push(text),
    ending: () => new Promise((resolve) => (release = resolve)),
  });
  watcher.observe(activity({ active: ["fix"] }));
  watcher.watch("fix", "Fix login");
  watcher.observe(activity());
  watcher.reset();
  release("finished");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notes, []);
});

test("an ending is read from the newest reply", () => {
  assert.equal(liveChatEnding([]), null);
  assert.equal(liveChatEnding([{ role: "user" }, { role: "assistant" }]), "finished");
  assert.equal(liveChatEnding([{ role: "assistant", providerFailure: { kind: "rate_limit" } }]), "failed");
  assert.equal(liveChatEnding([{ role: "assistant", timeline: { status: "failed" } }]), "failed");
  assert.equal(liveChatEnding([{ role: "assistant", timeline: { status: "cancelled" } }]), "stopped");
  assert.equal(
    liveChatEnding([{ role: "assistant", providerFailure: {} }, { role: "assistant" }, { role: "user" }]),
    "finished",
  );
});
