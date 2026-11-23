import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalPrompt } from "./ipc";
import type {
  LiveSubagentTranscripts,
  SubagentTranscriptUpdateV1,
  SubagentTranscriptV1,
} from "../shared/subagent-transcript";
import {
  combineLiveSubagentTranscripts,
  createSubagentHelperChatStore,
  subagentHelperChatTranscript,
} from "./subagent-helper-chat-store";

function saved(runId: string, revision: number, texts: string[]): SubagentTranscriptV1 {
  return {
    version: 1,
    runId,
    revision,
    trimmed: false,
    entries: [
      { kind: "task", text: "Find the parser." },
      ...texts.map((text) => ({ kind: "message" as const, text, steps: [], startedAt: 1_000 })),
    ],
  };
}

function update(
  runId: string,
  baseRevision: number,
  revision: number,
  index: number,
  text: string,
): SubagentTranscriptUpdateV1 {
  return {
    version: 1,
    runId,
    baseRevision,
    revision,
    trimmed: false,
    entryCount: index + 1,
    changes: [{ index, entry: { kind: "message", text, steps: [], startedAt: 2_000 } }],
  };
}

const live = (...updates: SubagentTranscriptUpdateV1[]): LiveSubagentTranscripts =>
  new Map(updates.map((value) => [value.runId, value]));

function messageTexts(transcript: SubagentTranscriptV1 | null): string[] {
  return (transcript?.entries ?? []).flatMap((entry) => (entry.kind === "message" ? [entry.text] : []));
}

test("a window that joins late merges what streamed after the saved copy", () => {
  const store = createSubagentHelperChatStore();
  store.rememberSaved("chat-1", saved("run-1", 3, ["First look."]));
  store.syncLive("chat-1", live(update("run-1", 3, 4, 2, "Found it.")));

  const merged = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(merged.complete, true);
  assert.equal(merged.transcript?.revision, 4);
  assert.deepEqual(messageTexts(merged.transcript), ["First look.", "Found it."]);
});

test("a gap between the saved copy and the live updates keeps the saved copy and asks for a refetch", () => {
  const store = createSubagentHelperChatStore();
  store.rememberSaved("chat-1", saved("run-1", 3, ["First look."]));
  store.syncLive("chat-1", live(update("run-1", 6, 7, 2, "Much later.")));

  const gap = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(gap.complete, false);
  assert.deepEqual(messageTexts(gap.transcript), ["First look."]);

  // The refetched copy closes the gap, and the live update applies on top.
  store.rememberSaved("chat-1", saved("run-1", 6, ["First look.", "Midway."]));
  const closed = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(closed.complete, true);
  assert.deepEqual(messageTexts(closed.transcript), ["First look.", "Much later."]);
});

test("the conversation stays after the turn ends and its live updates are dropped", () => {
  const store = createSubagentHelperChatStore();
  const first: SubagentTranscriptUpdateV1 = {
    ...update("run-1", 0, 1, 1, "Hello"),
    changes: [
      { index: 0, entry: { kind: "task", text: "Find the parser." } },
      { index: 1, entry: { kind: "message", text: "Hello", steps: [], startedAt: 2_000 } },
    ],
  };
  store.syncLive("chat-1", live(first));
  store.syncLive("chat-1", new Map());
  const kept = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(kept.transcript?.revision, 1);
  assert.deepEqual(messageTexts(kept.transcript), ["Hello"]);
});

test("switching chats forgets the previous chat's helpers and closes the expanded chat", () => {
  const store = createSubagentHelperChatStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  store.rememberSaved("chat-1", saved("run-1", 2, ["Hi"]));
  store.expand("run-1", null);
  assert.equal(store.getState().expandedRunId, "run-1");

  store.reset("chat-2");
  assert.equal(store.getState().chatId, "chat-2");
  assert.equal(store.getState().expandedRunId, null);
  assert.equal(subagentHelperChatTranscript(store.getState(), "run-1").transcript, null);

  // A late write for the old chat cannot leak into the new one's state.
  const before = notifications;
  store.reset("chat-2");
  assert.equal(notifications, before, "resetting to the same chat is a no-op");
});

test("an answer from inside a helper chat goes to the main chat's approval handler", () => {
  const store = createSubagentHelperChatStore();
  const prompt: ApprovalPrompt = {
    approvalId: "approval-1",
    toolCallId: "call-1",
    toolName: "edit",
    summary: "Edit",
  };
  const decisions: Array<[string, string]> = [];
  store.syncApprovals("chat-1", [prompt], null, (value, decision) => {
    decisions.push([value.approvalId, decision]);
  });
  store.decide(prompt, "deny");
  assert.deepEqual(decisions, [["approval-1", "deny"]]);

  // After a chat switch the old handler is gone, so a stale click does nothing.
  store.reset("chat-2");
  store.decide(prompt, "allow");
  assert.deepEqual(decisions, [["approval-1", "deny"]]);
});

test("the chat stream and a detached run's projection combine by newest revision", () => {
  const fromStream = live(update("run-1", 0, 2, 0, "stream"), update("run-2", 0, 5, 0, "stream"));
  const fromProjection = live(update("run-1", 0, 3, 0, "projection"), update("run-2", 0, 4, 0, "projection"));
  const combined = combineLiveSubagentTranscripts(fromStream, fromProjection);
  assert.equal(combined.get("run-1")?.revision, 3);
  assert.equal(combined.get("run-2")?.revision, 5);
  assert.equal(combineLiveSubagentTranscripts(fromStream, undefined), fromStream);
});
