import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalPrompt } from "./ipc.js";
import { LiveActivityStore } from "./live-activity.js";
import {
  LiveChatApprovalsStore,
  LiveChatVoiceApprovals,
  liveApprovalVoiceAnswerable,
} from "./live-chat-approvals.js";
import { LiveOpenChatStore } from "./live-open-chat.js";
import { LiveSessionBus } from "./live-session-bus.js";

const runTests: ApprovalPrompt = {
  approvalId: "a1",
  toolCallId: "t1",
  toolName: "run_command",
  summary: "Run command: npm test",
  preview: { kind: "command", command: "npm test" },
  scopes: ["once", "chat", "always"],
};

const editReadme: ApprovalPrompt = {
  approvalId: "a2",
  toolCallId: "t2",
  toolName: "edit_file",
  summary: "Edit file: docs/README.md",
};

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * The real Live seams with a stand-in chat pane: its decide records the answer
 * and, like the pane, drops the approval from its list once it is answered.
 */
function harness(options: { session?: boolean; enabled?: boolean } = {}) {
  const bus = new LiveSessionBus();
  const notes: string[] = [];
  const transport = {
    toolResult: async () => true,
    note: async (_sessionId: string, text: string) => {
      notes.push(text);
      return true;
    },
  };
  if (options.session !== false) bus.setSession("s1", transport);
  const openChat = new LiveOpenChatStore();
  const approvals = new LiveChatApprovalsStore();
  const activity = new LiveActivityStore();
  const decisions: Array<{ approvalId: string; decision: "allow" | "deny"; extra: number }> = [];
  const pane = Symbol("pane");
  let list: ApprovalPrompt[] = [];
  let chatId = "c1";
  const decide = async (prompt: ApprovalPrompt, decision: "allow" | "deny", ...extra: unknown[]) => {
    decisions.push({ approvalId: prompt.approvalId, decision, extra: extra.filter((value) => value !== undefined).length });
    list = list.filter((candidate) => candidate.approvalId !== prompt.approvalId);
    approvals.publish(pane, { chatId, approvals: list, decide });
  };
  const controller = new LiveChatVoiceApprovals({ bus, openChat, approvals, activity });
  controller.setEnabled(options.enabled !== false);
  const stop = controller.start();
  const showChat = (id: string, title: string) => {
    chatId = id;
    list = [];
    openChat.publish(pane, { chatId: id, title, workspaceId: null, busy: true, streamId: `stream-${id}` });
    approvals.publish(pane, { chatId: id, approvals: list, decide });
  };
  const raise = (...prompts: ApprovalPrompt[]) => {
    list = [...list, ...prompts];
    approvals.publish(pane, { chatId, approvals: list, decide });
  };
  const say = (text: string) => bus.publishVoiceInput(text);
  return { bus, transport, notes, activity, approvals, decide, decisions, controller, stop, showChat, raise, say, pending: () => list };
}

test("an approval in the open chat is read out, shown on the ribbon, and a later “allow” allows it once", async () => {
  const live = harness();
  live.showChat("c1", "Fix login");
  live.raise(runTests);
  await settle();
  assert.deepEqual(live.notes, ["Tell the user: The chat “Fix login” wants to run npm test. Say allow or deny."]);
  const shown = live.activity.get();
  assert.equal(shown?.kind, "approval");
  assert.equal(shown?.kind === "approval" && shown.voice, true);
  assert.equal(shown?.kind === "approval" && shown.title, "Run npm test");
  assert.equal(shown?.kind === "approval" && shown.chatTitle, "Fix login");
  assert.equal(live.controller.voiceHint("a1"), "voice");

  live.say("Allow.");
  await settle();
  assert.deepEqual(live.decisions, [{ approvalId: "a1", decision: "allow", extra: 0 }], "allow once: no wider scope");
  assert.equal(live.activity.get(), null, "the ribbon clears once the card is answered");
  assert.equal(live.controller.voiceHint("a1"), null);
});

test("allow phrases in other languages answer too, and deny denies", async () => {
  for (const [phrase, decision] of [
    ["permitir", "allow"],
    ["अनुमति दो", "allow"],
    ["許可します", "allow"],
    ["Deny it!", "deny"],
    ["拒绝", "deny"],
  ] as const) {
    const live = harness();
    live.showChat("c1", "Fix login");
    live.raise(runTests);
    live.say(phrase);
    await settle();
    assert.deepEqual(live.decisions, [{ approvalId: "a1", decision, extra: 0 }], phrase);
    live.stop();
  }
});

test("speech before the read-out, longer sentences, bare yes and Live's own words answer nothing", async () => {
  const live = harness();
  live.showChat("c1", "Fix login");
  live.say("allow");
  live.raise(runTests);
  live.say("yes");
  live.say("allow it to run the tests please");
  live.say("go ahead");
  // Live's spoken output is a caption in the other direction; only the
  // user's finalized input reaches the voice bus, and notes are Live's words.
  await live.bus.note("Say allow or deny.");
  await settle();
  assert.deepEqual(live.decisions, []);
  assert.equal(live.pending().length, 1);
  assert.equal(live.activity.get()?.kind, "approval");
});

test("approvals are answered one at a time, in order, each read out before speech counts", async () => {
  const live = harness();
  live.showChat("c1", "Fix login");
  live.raise(runTests, editReadme);
  await settle();
  assert.equal(live.notes.length, 1);
  live.say("deny");
  await settle();
  assert.deepEqual(live.decisions.map((entry) => entry.approvalId), ["a1"]);
  assert.equal(live.notes[1], "Tell the user: The chat “Fix login” wants to edit README.md. Say allow or deny.");
  const shown = live.activity.get();
  assert.equal(shown?.kind === "approval" && shown.id, "a2");
  live.say("allow");
  await settle();
  assert.deepEqual(live.decisions, [
    { approvalId: "a1", decision: "deny", extra: 0 },
    { approvalId: "a2", decision: "allow", extra: 0 },
  ]);
});

test("a tap on the card clears the ribbon and later speech is ignored", async () => {
  const live = harness();
  live.showChat("c1", "Fix login");
  live.raise(runTests);
  await settle();
  // The card's Allow once button calls the pane's decide directly.
  await live.decide(runTests, "allow");
  assert.equal(live.activity.get(), null);
  assert.equal(live.controller.voiceHint("a1"), null);
  live.say("deny");
  await settle();
  assert.deepEqual(live.decisions, [{ approvalId: "a1", decision: "allow", extra: 0 }]);
});

test("the ribbon's buttons answer through the same decide", async () => {
  const live = harness();
  live.showChat("c1", "Fix login");
  live.raise(runTests);
  const shown = live.activity.get();
  assert.ok(shown?.kind === "approval");
  shown.deny();
  await settle();
  assert.deepEqual(live.decisions, [{ approvalId: "a1", decision: "deny", extra: 0 }]);
});

test("an approval in a chat that is not on screen is not voice-answerable; Live says it is waiting", async () => {
  const live = harness();
  live.showChat("c1", "Fix login");
  live.raise(runTests);
  await settle();
  live.showChat("c2", "Plan trip");
  await settle();
  assert.equal(live.activity.get(), null);
  assert.equal(
    live.notes[live.notes.length - 1],
    "Tell the user: The chat “Fix login” is still waiting for an approval. Open it to answer.",
  );
  live.say("allow");
  await settle();
  assert.deepEqual(live.decisions, []);
});

test("approvals published under a chat other than the one on screen are ignored", async () => {
  const live = harness();
  live.showChat("c1", "Fix login");
  live.approvals.publish(Symbol("stale pane"), { chatId: "c9", approvals: [runTests], decide: live.decide });
  live.say("allow");
  await settle();
  assert.deepEqual(live.notes, []);
  assert.equal(live.activity.get(), null);
  assert.deepEqual(live.decisions, []);
});

test("tap-only approvals are announced but speech never answers them", async () => {
  const tapOnly: ApprovalPrompt[] = [
    { ...runTests, approvalId: "p1", summary: "Run command: security find-generic-password -s github", preview: { kind: "command", command: "security find-generic-password -s github" } },
    { ...runTests, approvalId: "p2", toolName: "browser_type", summary: "Enter text in Aiden's browser\nhttps://shop.example" },
    { ...runTests, approvalId: "p3", toolName: "generate_image", summary: "Send an image prompt (may incur charges)" },
    { ...runTests, approvalId: "p4", toolName: "computer_use", details: { kind: "computer-use-access" }, scopes: ["chat", "always"] },
    { ...runTests, approvalId: "p5", canAllow: false },
    { ...runTests, approvalId: "p6", toolName: "notion_create_page", summary: "Create a page" },
    { ...runTests, approvalId: "p7", details: { kind: "subagent-shell" } as unknown as ApprovalPrompt["details"] },
    { ...runTests, approvalId: "p8", scopes: ["chat"] },
  ];
  for (const prompt of tapOnly) {
    assert.equal(liveApprovalVoiceAnswerable(prompt), false, prompt.approvalId);
    const live = harness();
    live.showChat("c1", "Fix login");
    live.raise(prompt);
    await settle();
    assert.match(live.notes[0] ?? "", /This one needs a tap\.$/u, prompt.approvalId);
    const shown = live.activity.get();
    assert.equal(shown?.kind === "approval" && shown.voice, false, prompt.approvalId);
    assert.equal(live.controller.voiceHint(prompt.approvalId), "tap");
    live.say("allow");
    live.say("deny");
    await settle();
    assert.deepEqual(live.decisions, [], prompt.approvalId);
    live.stop();
  }
});

test("with the setting off or no Live session, nothing is read out or answered", async () => {
  for (const options of [{ enabled: false }, { session: false }]) {
    const live = harness(options);
    live.showChat("c1", "Fix login");
    live.raise(runTests);
    live.say("allow");
    await settle();
    assert.deepEqual(live.notes, []);
    assert.equal(live.activity.get(), null);
    assert.deepEqual(live.decisions, []);
    live.stop();
  }
});

test("turning the setting off mid-approval clears it; a session that starts later reads it out", async () => {
  const live = harness({ session: false });
  live.showChat("c1", "Fix login");
  live.raise(runTests);
  live.bus.setSession("s1", live.transport);
  await settle();
  assert.equal(live.notes.length, 1);
  assert.equal(live.activity.get()?.kind, "approval");
  live.controller.setEnabled(false);
  assert.equal(live.activity.get(), null);
  live.say("allow");
  await settle();
  assert.deepEqual(live.decisions, []);
});
