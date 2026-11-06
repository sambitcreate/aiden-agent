import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_CHAT_MAX_NOTE_CHARS,
  LIVE_CHAT_MAX_READ_CHARS,
  decideLiveChatSend,
  findLiveChat,
  findLiveWorkspace,
  liveChatNoteText,
  liveChatTranscript,
  redactLiveChatSecrets,
  type LiveChatTranscriptMessage,
} from "./live-chat-tools";

const user = (content: string, extra: Partial<LiveChatTranscriptMessage> = {}): LiveChatTranscriptMessage => ({
  role: "user",
  content,
  ...extra,
});
const assistant = (content: string, extra: Partial<LiveChatTranscriptMessage> = {}): LiveChatTranscriptMessage => ({
  role: "assistant",
  content,
  ...extra,
});

test("read keeps at most 20 of the newest messages, oldest first", () => {
  const messages = Array.from({ length: 30 }, (_, index) => user(`message ${index}`));
  const read = liveChatTranscript(messages, 500);
  assert.equal(read.messages.length, 20);
  assert.equal(read.messages[0]!.text, "message 10");
  assert.equal(read.messages[read.messages.length - 1]!.text, "message 29");
  assert.equal(read.truncated, true);
  assert.deepEqual(liveChatTranscript(messages.slice(0, 3), 10), {
    messages: [
      { role: "user", text: "message 0" },
      { role: "user", text: "message 1" },
      { role: "user", text: "message 2" },
    ],
    truncated: false,
  });
});

test("read stays within 12,000 characters and drops the oldest text first", () => {
  const messages = [user("A".repeat(9_000)), assistant("B".repeat(5_000)), user("newest question")];
  const read = liveChatTranscript(messages, 20);
  const total = read.messages.reduce((sum, message) => sum + message.text.length, 0);
  assert.ok(total <= LIVE_CHAT_MAX_READ_CHARS, `read ${total} characters`);
  assert.equal(read.messages[read.messages.length - 1]!.text, "newest question");
  assert.equal(read.messages[read.messages.length - 2]!.text, "B".repeat(5_000));
  assert.ok(read.messages[0]!.text.endsWith("A"), "an oversized message keeps its newest end");
  assert.ok(read.messages[0]!.text.startsWith("…"));
  assert.equal(read.truncated, true);
});

test("read summarises tool activity to one line, counts attachments and hides credentials", () => {
  const read = liveChatTranscript([
    user("Deploy with key sk-abcdefghijklmnop please", {
      attachments: [{ data: "iVBORw0KGgo=" }, { data: "secret file contents" }],
      inputSource: "voice",
    }),
    assistant("Deployed.", {
      timeline: {
        steps: [
          { kind: "thinking" },
          { kind: "tool", toolName: "run_command" },
          { kind: "tool", toolName: "run_command" },
          { kind: "tool", toolName: "read_file" },
        ],
      },
    }),
    { role: "system", content: "private system text" },
    user("[Aiden follow-up]\n```\nfull log\n```", { notice: { title: "Background job ended", summary: "exit code 1" } }),
  ]);
  assert.deepEqual(read.messages, [
    { role: "user", text: "Deploy with key [hidden] please\n[2 attachments]", byVoice: true },
    { role: "assistant", text: "[Used tools: run_command ×2, read_file]\nDeployed." },
    { role: "user", text: "[Notice] Background job ended: exit code 1" },
  ]);
});

test("auto sends when the chat is idle and steers while it works", () => {
  const idle = { busy: false, steerAvailable: false, queueAvailable: true, hasQueued: false };
  const working = { busy: true, steerAvailable: true, queueAvailable: true, hasQueued: false };
  assert.equal(decideLiveChatSend("auto", idle), "send");
  assert.equal(decideLiveChatSend("auto", working), "steer");
  // A run that can't take guidance (another device's run, or one stopping) queues instead.
  assert.equal(decideLiveChatSend("auto", { ...working, steerAvailable: false }), "queue");
  // Queued messages keep their order: a new one goes behind them.
  assert.equal(decideLiveChatSend("auto", { ...idle, hasQueued: true }), "queue");
  // A draft has no queue: its first message sends.
  assert.equal(decideLiveChatSend("auto", { ...idle, queueAvailable: false, hasQueued: true }), "send");
});

test("a paused queue refuses the messages that would wait in it", () => {
  const paused = { busy: true, steerAvailable: false, queueAvailable: true, hasQueued: true, queuePaused: true };
  assert.deepEqual(decideLiveChatSend("auto", paused), { refuse: { code: "queue_paused", message: "This chat's queue is paused. Ask the person to resume it in Aiden first." } });
  assert.equal(decideLiveChatSend("auto", { ...paused, steerAvailable: true }), "steer");
  assert.equal(typeof decideLiveChatSend("auto", { ...paused, busy: false }), "object", "idle with a held queue");
  assert.equal(decideLiveChatSend("auto", { ...paused, busy: false, hasQueued: false }), "send");
});

test("steer and queue are refused with a reason when the chat can't take them", () => {
  const idle = { busy: false, steerAvailable: false, queueAvailable: true, hasQueued: false };
  const working = { busy: true, steerAvailable: false, queueAvailable: false, hasQueued: false };
  assert.deepEqual(decideLiveChatSend("steer", idle), { refuse: { code: "nothing_to_steer", message: "Nothing is running in this chat, so there is nothing to steer. Send it instead." } });
  assert.equal((decideLiveChatSend("steer", working) as { refuse: { code: string } }).refuse.code, "cannot_steer");
  assert.equal((decideLiveChatSend("queue", working) as { refuse: { code: string } }).refuse.code, "cannot_queue");
  assert.equal(decideLiveChatSend("queue", idle), "send");
  assert.equal(decideLiveChatSend("queue", { ...working, queueAvailable: true }), "queue");
});

const chats = [
  { id: "a", title: "Fix login", updatedAt: 10 },
  { id: "b", title: "Fix login page styles", updatedAt: 30 },
  { id: "c", title: "Release notes for 0.70", updatedAt: 20 },
  { id: "d", title: "Plan the offsite", updatedAt: 40 },
  { id: "e", title: "Plan the launch", updatedAt: 50 },
  { id: "f", title: "Plan the budget", updatedAt: 5 },
  { id: "g", title: "Plan the hiring", updatedAt: 1 },
];

test("find opens the one chat that clearly matches", () => {
  assert.deepEqual(findLiveChat(chats, "fix login"), { kind: "open", chat: chats[0] });
  assert.deepEqual(findLiveChat(chats, "release notes"), { kind: "open", chat: chats[2] });
  assert.deepEqual(findLiveChat(chats, "Releese notes 0.70").kind, "open", "one wrong word still finds it");
  assert.deepEqual(findLiveChat(chats, "the offsite"), { kind: "open", chat: chats[3] });
  assert.deepEqual(findLiveChat(chats, "Café menu"), { kind: "none" });
  assert.deepEqual(findLiveChat([{ id: "x", title: "Café menu", updatedAt: 1 }], "cafe menu").kind, "open");
});

test("find opens nothing when several match about equally and offers the top three, newest first", () => {
  assert.deepEqual(findLiveChat(chats, "plan"), {
    kind: "ambiguous",
    titles: ["Plan the launch", "Plan the offsite", "Plan the budget"],
  });
  const twins = [
    { id: "1", title: "Standup", updatedAt: 1 },
    { id: "2", title: "Standup", updatedAt: 2 },
  ];
  assert.deepEqual(findLiveChat(twins, "standup"), { kind: "ambiguous", titles: ["Standup", "Standup"] });
});

test("a workspace is matched by name, and an unclear name matches none", () => {
  const workspaces = [
    { id: "w1", name: "Website" },
    { id: "w2", name: "Website docs" },
    { id: "w3", name: "Mobile app" },
  ];
  assert.equal(findLiveWorkspace(workspaces, "website")?.id, "w1");
  assert.equal(findLiveWorkspace(workspaces, "mobile")?.id, "w3");
  assert.equal(findLiveWorkspace(workspaces, "web"), null);
  assert.equal(findLiveWorkspace(workspaces, "backend"), null);
  // Two workspaces with the same name: Live asks instead of picking one.
  const twins = [...workspaces, { id: "w4", name: "Mobile app" }];
  assert.equal(findLiveWorkspace(twins, "mobile app"), null);
  assert.equal(findLiveWorkspace(twins, "mobile"), null);
  assert.equal(findLiveWorkspace(twins, "website")?.id, "w1");
});

test("secret assignments and private key blocks never reach Live, while ordinary text does", () => {
  const text = [
    "DB_PASSWORD=hunter2",
    "export GITHUB_TOKEN=abc123",
    "OPENAI_API_KEY: sk-example",
    "client-secret = shh",
    "Password: letmein",
    "TOKENIZER=fast",
    "PASSAGE=keep this",
    "Note: the build passed",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAA",
    "-----END OPENSSH PRIVATE KEY-----",
    "after the key",
  ].join("\n");
  const redacted = redactLiveChatSecrets(text);
  for (const secret of ["hunter2", "abc123", "sk-example", "shh", "letmein", "b3BlbnNzaC1rZXktdjEAAAAA"]) {
    assert.ok(!redacted.includes(secret), secret);
  }
  for (const kept of ["DB_PASSWORD=", "TOKENIZER=fast", "PASSAGE=keep this", "Note: the build passed", "after the key"]) {
    assert.ok(redacted.includes(kept), kept);
  }
  // An unfinished block is hidden to the end.
  assert.equal(redactLiveChatSecrets("see\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow"), "see\n[hidden key]");
  // The read applies it.
  const read = liveChatTranscript([assistant("Set AWS_SECRET_ACCESS_KEY=wJalrXUt and retry.")]);
  assert.doesNotMatch(read.messages[0]!.text, /wJalrXUt/u);
});

test("notes are one short sentence that never carries more than the title", () => {
  assert.equal(liveChatNoteText("finished", "Fix login"), "The chat “Fix login” finished its reply.");
  assert.equal(liveChatNoteText("failed", "Fix login"), "The chat “Fix login” stopped with an error.");
  assert.equal(liveChatNoteText("approval", "Fix login"), "The chat “Fix login” is waiting for an approval.");
  const long = liveChatNoteText("question", `${"Very long title ".repeat(40)}ghp_abcdefghijklmnopqrstuvwxyz`);
  assert.ok(long.length <= LIVE_CHAT_MAX_NOTE_CHARS);
  assert.doesNotMatch(long, /ghp_/u);
});
