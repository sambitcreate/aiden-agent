import assert from "node:assert/strict";
import test from "node:test";
import type { PeerRunEvent, PeerRunSubscription } from "../../shared/peer-host";
import type { ChatMessage } from "../types";
import {
  applyRemoteRunEvent,
  applyRemoteRunEvents,
  applyRemoteRunStreamState,
  applyRemoteRunSubscription,
  handOffRemoteRun,
  initialRemoteRunView,
  remoteRunTranscript,
  type RemoteRunView,
} from "./remote-stream-translator";

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
  streamId = "run-1",
): PeerRunEvent {
  return {
    protocolVersion: 1,
    streamId,
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    type,
    terminal: type === "done" || type === "error" || type === "cancelled" || type === "run.ended",
    payload,
  };
}

const question = {
  question: "Which branch should I use?",
  header: "Branch",
  multiSelect: false,
  options: [
    { label: "main", description: "The default branch" },
    { label: "release", description: "The release branch" },
  ],
};

function fold(events: PeerRunEvent[], from: RemoteRunView = initialRemoteRunView(null, "chat-1")) {
  return applyRemoteRunEvents(from, events);
}

const assistant = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "assistant",
  content,
  createdAt: 1,
  ...extra,
});

test("a live run streams text, reasoning and tool activity into the transcript inputs", () => {
  const { view, refetch } = fold([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1", origin: "desktop" }),
    event(2, "status", { state: "running" }),
    event(3, "reasoning_delta", { text: "Looking " }),
    event(4, "reasoning_delta", { text: "around" }),
    event(5, "tool_started", { toolId: "tool_1", name: "read_file" }),
  ]);
  assert.equal(refetch, true, "run.started brings in the persisted user turn");
  assert.equal(view.origin, "desktop");
  let transcript = remoteRunTranscript(view, []);
  assert.equal(transcript.streamingText, "");
  assert.equal(transcript.streamingReasoning, "Looking around");
  assert.equal(transcript.agentActivity?.phase, "searching");

  const writing = fold(
    [event(6, "tool_finished", { toolId: "tool_1", status: "succeeded" }), event(7, "text_delta", { text: "Hello" })],
    view,
  );
  transcript = remoteRunTranscript(writing.view, []);
  assert.equal(writing.refetch, false);
  assert.equal(transcript.streamingText, "Hello");
  assert.equal(transcript.agentActivity?.label, "Responding…");
  assert.equal(transcript.error, null);
});

test("duplicate and replayed sequences are applied once", () => {
  const events = [event(1, "run.started", { chatId: "chat-1" }), event(2, "text_delta", { text: "ab" })];
  const once = fold(events).view;
  const twice = fold([...events, ...events]).view;
  assert.equal(twice.text, "ab");
  assert.deepEqual(twice, once);
  // An older sequence arriving late changes nothing.
  assert.equal(applyRemoteRunEvent(once, event(1, "text_delta", { text: "zz" })).view, once);
});

test("run.ended repeats the terminal sequence and still settles the run exactly once", () => {
  const done = fold([
    event(1, "run.started", {}),
    event(2, "text_delta", { text: "Answer" }),
    event(3, "done", { messageId: "a-1" }),
  ]);
  assert.equal(done.refetch, true);
  assert.equal(done.view.status, "done");

  const ended = applyRemoteRunEvent(done.view, event(3, "run.ended", { state: "done" }));
  assert.equal(ended.view.ended, true);
  assert.equal(ended.refetch, false, "the done event already asked for the persisted turn");
  assert.equal(applyRemoteRunEvent(ended.view, event(3, "run.ended", { state: "done" })).view, ended.view);

  // Until the refetched window holds the persisted reply, the streamed row stays.
  assert.equal(remoteRunTranscript(ended.view, []).streamingText, "Answer");
  assert.equal(remoteRunTranscript(ended.view, []).streamComplete, true);
  assert.equal(remoteRunTranscript(ended.view, [assistant("a-1", "Answer")]).streamingText, null);
  assert.equal(remoteRunTranscript(ended.view, [assistant("a-1", "Answer")]).agentActivity, null);
});

test("a run.ended whose terminal event was missed settles from the host state and refetches", () => {
  const { view, refetch } = fold([event(1, "run.started", {}), event(4, "run.ended", { state: "cancelled" })]);
  assert.equal(view.status, "cancelled");
  assert.equal(view.ended, true);
  assert.equal(refetch, true);
});

test("a reset snapshot restarts the reply without dropping prompts", () => {
  const { view } = fold([
    event(1, "run.started", {}),
    event(2, "text_delta", { text: "first try" }),
    event(3, "approval_required", { approvalId: "ap-1", summary: "Run tests", toolCallId: "c1", toolName: "shell" }),
    event(4, "snapshot", { reason: "reset", nextSequence: 5 }),
    event(5, "text_delta", { text: "second" }),
  ]);
  assert.equal(view.text, "second");
  assert.equal(view.approvals.length, 1);
});

test("a gap snapshot reseeds pending prompts from the host and waits for the persisted transcript", () => {
  const before = fold([event(1, "run.started", {}), event(2, "text_delta", { text: "partial" })]).view;
  const gap = applyRemoteRunEvent(
    before,
    event(40, "snapshot", {
      reason: "gap",
      state: "needs_input",
      approvals: [{ approvalId: "ap-9", summary: "Write file", toolCallId: "c9", toolName: "write_file" }],
      questions: [{ promptId: "q-1", toolCallId: "c2", questions: [question] }],
      nextSequence: 41,
    }),
  );
  assert.equal(gap.refetch, true);
  assert.equal(gap.view.incomplete, true);
  assert.equal(gap.view.cursor, 40);
  assert.deepEqual(gap.view.approvals.map((prompt) => [prompt.approvalId, prompt.canAllow, prompt.source]), [
    ["ap-9", false, "remote"],
  ]);
  assert.equal(gap.view.questions[0]?.streamId, "run-1");

  // Text after the gap would start mid-sentence, so the row shows activity only.
  const resumed = applyRemoteRunEvent(gap.view, event(41, "text_delta", { text: "tail" })).view;
  const transcript = remoteRunTranscript(resumed, []);
  assert.equal(transcript.streamingText, "");
  assert.equal(transcript.agentActivity?.phase, "waiting");

  const answered = fold([event(42, "approval_resolved", { approvalId: "ap-9" })], resumed).view;
  assert.equal(remoteRunTranscript(answered, []).agentActivity?.label, "Waiting for an answer");
});

test("a gap snapshot that reports a finished run settles it", () => {
  const { view, refetch } = fold([
    event(1, "run.started", {}),
    event(90, "snapshot", { reason: "gap", state: "done", approvals: [], questions: [] }),
  ]);
  assert.equal(view.status, "done");
  assert.equal(view.incomplete, false);
  assert.equal(refetch, true);
  assert.equal(remoteRunTranscript(view, []).agentActivity, null);
});

test("events from a newer run on the same chat start a fresh view", () => {
  const first = fold([
    event(1, "run.started", {}),
    event(2, "text_delta", { text: "old" }),
    event(3, "done", { messageId: "a-1" }),
  ]).view;
  const next = applyRemoteRunEvent(first, event(1, "run.started", { origin: "device" }, "run-2"));
  assert.equal(next.view.runId, "run-2");
  assert.equal(next.view.text, "");
  assert.equal(next.view.status, "running");
  assert.equal(next.view.chatId, "chat-1");
});

test("terminal outcomes surface the right transcript state", () => {
  const failed = fold([event(1, "run.started", {}), event(2, "error", { code: "internal_error", message: "Provider down" })]);
  assert.equal(failed.refetch, true);
  assert.equal(remoteRunTranscript(failed.view, []).error, "Provider down");
  // Once the failed turn is persisted it renders its own notice instead.
  const persistedFailure = assistant("a-2", "", {
    providerFailure: { version: 1, category: "service_unavailable", attempts: 1, retryExhausted: false },
  });
  assert.equal(remoteRunTranscript(failed.view, [persistedFailure]).error, null);

  const cancelled = fold([event(1, "run.started", {}), event(2, "text_delta", { text: "x" }), event(3, "cancelled", { source: "device" })]);
  const transcript = remoteRunTranscript(cancelled.view, []);
  assert.equal(transcript.streamingText, null);
  assert.equal(transcript.agentActivity, null);
  assert.equal(transcript.error, null);

  // Nothing but run.ended applies after a terminal event.
  assert.equal(applyRemoteRunEvent(cancelled.view, event(4, "text_delta", { text: "late" })).view, cancelled.view);
});

test("a truncated subscription waits for the transcript before applying its buffered events", () => {
  const subscription: PeerRunSubscription = {
    subscriptionId: "s1",
    key: "chat:chat-1",
    runId: "run-1",
    chatId: "chat-1",
    state: "streaming",
    events: [event(600, "text_delta", { text: "middle" }), event(601, "tool_started", { toolId: "tool_9", name: "edit" })],
    truncated: true,
  };
  const step = applyRemoteRunSubscription(initialRemoteRunView(null, "chat-1"), subscription);
  assert.equal(step.refetch, true);
  assert.equal(step.view.incomplete, true);
  assert.equal(step.view.cursor, 601);
  assert.equal(step.view.status, "running");
  assert.equal(remoteRunTranscript(step.view, []).streamingText, "");
  assert.equal(remoteRunTranscript(step.view, []).agentActivity?.label, "edit");
});

test("a chat with no current run subscribes idle, and a gone stream settles the run", () => {
  const idle = applyRemoteRunSubscription(initialRemoteRunView(null, "chat-1"), {
    subscriptionId: "s1",
    key: "chat:chat-1",
    runId: null,
    chatId: "chat-1",
    state: "idle",
    events: [],
    truncated: false,
  });
  assert.equal(idle.refetch, false);
  assert.equal(remoteRunTranscript(idle.view, []).streamingText, null);

  const running = fold([event(1, "run.started", {}), event(2, "text_delta", { text: "hi" })]).view;
  const gone = applyRemoteRunStreamState(running, "gone");
  assert.equal(gone.refetch, true);
  assert.equal(gone.view.ended, true);
  assert.equal(remoteRunTranscript(gone.view, []).agentActivity, null);
  assert.equal(applyRemoteRunStreamState(running, "waiting").view, running);
});

test("a settled reply hands off to the persisted transcript even when its message id is unknown", () => {
  // The host names a synthetic id when its done payload carries no assistant message.
  const synthetic = fold([
    event(1, "run.started", {}),
    event(2, "text_delta", { text: "Answer" }),
    event(3, "done", { messageId: "assistant_turn-1" }),
  ]).view;
  const persisted = [assistant("a-1", "Answer")];
  assert.equal(remoteRunTranscript(synthetic, []).streamingText, "Answer", "the row waits for the window read");
  assert.equal(remoteRunTranscript(synthetic, persisted).streamingText, "Answer");
  const handed = handOffRemoteRun(synthetic);
  assert.equal(remoteRunTranscript(handed, persisted).streamingText, null, "the window read after done owns the reply");
  assert.equal(remoteRunTranscript(handed, persisted).agentActivity, null);

  // A run whose done event was missed settles from run.ended alone.
  const endedOnly = fold([event(1, "run.started", {}), event(2, "text_delta", { text: "Answer" }), event(4, "run.ended", { state: "done" })]).view;
  assert.equal(endedOnly.doneMessageId, null);
  assert.equal(remoteRunTranscript(handOffRemoteRun(endedOnly), persisted).streamingText, null);

  // A window read while the run is still going hands nothing off.
  const running = fold([event(1, "run.started", {}), event(2, "text_delta", { text: "Ans" })]).view;
  assert.equal(handOffRemoteRun(running), running);
  assert.equal(remoteRunTranscript(handOffRemoteRun(running), []).streamingText, "Ans");
  // A newer run starts without the previous hand-off.
  const next = applyRemoteRunEvent(handed, event(1, "text_delta", { text: "Next" }, "run-2")).view;
  assert.equal(remoteRunTranscript(next, persisted).streamingText, "Next");
});
