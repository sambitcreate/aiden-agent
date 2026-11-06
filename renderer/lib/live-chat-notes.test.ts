import assert from "node:assert/strict";
import test from "node:test";
import {
  LiveChatNoteWatcher,
  liveChatEnding,
  liveChatTurn,
  type LiveChatActivity,
  type LiveChatEnding,
  type LiveChatTurn,
} from "./live-chat-notes";

function activity(input: { active?: string[]; approval?: string[]; input?: string[] } = {}): LiveChatActivity {
  return {
    activeChatIds: new Set(input.active ?? []),
    approvalChatIds: new Set(input.approval ?? []),
    inputChatIds: new Set(input.input ?? []),
  };
}

/** Each chat's latest turn; Live's own turns unless told otherwise. */
function harness(turns: Record<string, Partial<LiveChatTurn>> = {}) {
  const notes: string[] = [];
  const watcher = new LiveChatNoteWatcher({
    note: (text) => notes.push(text),
    turn: async (chatId) => ({ byVoice: true, ending: "finished" as LiveChatEnding, ...turns[chatId] }),
  });
  return { notes, watcher, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("a chat Live sent to gets one note when its reply finishes or fails", async () => {
  const { notes, watcher, settle } = harness({ broken: { ending: "failed" } });
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
  const { notes, watcher, settle } = harness({ fix: { ending: "stopped" } });
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

test("only chats Live sent to are watched, and a reply to a message the person typed gets no note", async () => {
  const { notes, watcher, settle } = harness({ typed: { byVoice: false } });
  watcher.observe(activity({ active: ["other", "typed"] }));
  watcher.watch("typed", "Typed since");
  assert.equal(watcher.isWatching("other"), false);
  watcher.observe(activity({ approval: ["typed"] }));
  watcher.observe(activity());
  await settle();
  assert.deepEqual(notes, []);
});

test("a read that lands after the session ended sends nothing", async () => {
  let release!: (turn: LiveChatTurn) => void;
  const notes: string[] = [];
  const watcher = new LiveChatNoteWatcher({
    note: (text) => notes.push(text),
    turn: () => new Promise((resolve) => (release = resolve)),
  });
  watcher.observe(activity({ active: ["fix"] }));
  watcher.watch("fix", "Fix login");
  watcher.observe(activity());
  watcher.reset();
  release({ byVoice: true, ending: "finished" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notes, []);
  assert.equal(watcher.isWatching("fix"), false);
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

test("the latest turn is Live's only when the newest user message came by voice", () => {
  assert.deepEqual(liveChatTurn([]), { byVoice: false, ending: null });
  assert.deepEqual(
    liveChatTurn([{ role: "user", inputSource: "voice" }, { role: "assistant" }]),
    { byVoice: true, ending: "finished" },
  );
  // The person typed after Live's message: that reply is theirs.
  assert.deepEqual(
    liveChatTurn([{ role: "user", inputSource: "voice" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }]),
    { byVoice: false, ending: "finished" },
  );
  // A notice row is not a message from the person; no reply yet means no ending.
  assert.deepEqual(
    liveChatTurn([{ role: "user", inputSource: "voice" }, { role: "user", notice: { title: "x", summary: "y" } }]),
    { byVoice: true, ending: null },
  );
});
