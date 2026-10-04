import assert from "node:assert/strict";
import test from "node:test";
import { HostRunRegistry } from "./host-run-registry.js";
import { PEER_WAKE_COALESCE_MS } from "./peer-host-manager.js";
import { FakeHost, hostControls, numbered, settle, setup, type FakeHostEffects } from "./peer-remote-chat-test-host.js";
import { ChatSessionControl } from "../../renderer/lib/hosts/chat-session-control.js";
import { HostChatControlError, isOutcomeUnknown } from "../../renderer/lib/hosts/host-chat-adapter.js";
import { LocalHostAdapter } from "../../renderer/lib/hosts/local-host-adapter.js";

/**
 * Controlling a chat on another Mac end to end: the pane's session control
 * over the renderer adapter, main's real live IPC handlers and host
 * supervisor, and a host whose turns, run controls and replay ledger are the
 * real host services. Only the network, Electron's IPC and the generation
 * itself are stand-ins.
 */

const APPROVAL = { approvalId: "ap-1", summary: "Run the release script", toolCallId: "call-1", toolName: "shell" };
const QUESTION = {
  version: 1,
  promptId: "q-1",
  streamId: "run-1",
  toolCallId: "call-q",
  questions: [
    {
      question: "Which branch should I target?",
      header: "Branch",
      options: [
        { label: "main", description: "The default branch." },
        { label: "release", description: "The release branch." },
      ],
    },
  ],
};

function controlFor(harness: Awaited<ReturnType<typeof setup>>) {
  const control = new ChatSessionControl(harness.adapter, { hostId: harness.adapter.hostId, chatId: "chat-1" });
  control.attach();
  return control;
}

function code(expected: string) {
  return (error: unknown) => error instanceof HostChatControlError && error.code === expected;
}

/** How often `text` appears in the chat as a window opened now reads it. */
async function sentCopies(harness: Awaited<ReturnType<typeof setup>>, text: string): Promise<number> {
  const window = await harness.openAnother();
  try {
    return window.read().transcript.messages.filter((message) => message.content === text).length;
  } finally {
    window.dispose();
  }
}

test("a lost send acknowledgement retried with the same key starts exactly one turn", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await harness.open();
    const control = controlFor(harness);

    // The host starts the turn, but its answer never reaches this Mac.
    host.dropAcks = 1;
    await assert.rejects(control.send("Ship the release"), isOutcomeUnknown);
    assert.deepEqual(host.turns, ["Ship the release"]);
    const unresolved = control.getSnapshot().unresolved;
    assert.equal(unresolved?.kind, "send");
    assert.equal(unresolved?.text, "Ship the release", "the text is kept for the retry");

    // Nothing new is sent while the first message's fate is unknown.
    await assert.rejects(control.send("Another thought"), code("unresolved"));
    assert.equal(host.turnRequests().length, 1);

    await control.retryUnresolved();
    assert.equal(host.turnRequests().length, 2, "the retry reached the host");
    assert.deepEqual(host.turns, ["Ship the release"], "the host replayed the original turn instead of starting another");
    assert.equal(control.getSnapshot().unresolved, null);

    assert.equal(await sentCopies(harness, "Ship the release"), 1, "the chat shows the message once");

    // Once resolved, the next message is a new turn with a new key.
    host.runs.publish("run-turn-1", "chat:done", {});
    await control.send("Another thought");
    assert.deepEqual(host.turns, ["Ship the release", "Another thought"]);
  } finally {
    harness.close();
  }
});

test("an answer that lands after the connection changed is fenced, and its same-key retry starts no second turn", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await harness.open();
    const control = controlFor(harness);
    const generation = harness.adapter.status().generation;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.turnGate = () => gate;
    const sent = control.send("Summarize the changelog");
    await settle();
    assert.deepEqual(host.turns, ["Summarize the changelog"], "the host already started the turn");

    // The Mac wakes from sleep and reconnects before the host's answer arrives.
    harness.manager.wake();
    harness.timers.advance(PEER_WAKE_COALESCE_MS);
    await settle();
    host.turnGate = undefined;
    release();
    await assert.rejects(sent, isOutcomeUnknown);
    assert.ok(harness.adapter.status().generation > generation, "the connection was replaced");
    assert.equal(control.getSnapshot().unresolved?.text, "Summarize the changelog");

    await control.retryUnresolved();
    assert.deepEqual(host.turns, ["Summarize the changelog"], "exactly one turn");
    assert.equal(control.getSnapshot().unresolved, null);
  } finally {
    harness.close();
  }
});

test("stopping a run that was started on the host ends it there", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await host.start("run-1");
    host.runs.publish("run-1", "chat:delta", { delta: "Drafting the notes" });
    await harness.open();
    const control = controlFor(harness);
    const observed = harness.session.getSnapshot().run;
    assert.equal(observed.runId, "run-1");
    assert.equal(observed.status, "running");

    assert.equal(await control.cancel("run-1"), true);
    assert.deepEqual(host.effects.cancels, ["run-1"]);
    assert.equal(host.runs.summary("run-1")?.state, "cancelled");
    assert.equal(control.getSnapshot().stopping, false);

    await settle();
    await harness.session.idle();
    const after = harness.session.getSnapshot().run;
    assert.equal(after.status, "cancelled", "this Mac sees the run stop");
    assert.equal(after.ended, true);
  } finally {
    harness.close();
  }
});

test("two Macs answering the same approval resolve it exactly once, and the loser learns who won", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const first = await setup(host, "desktop-a");
  const second = await setup(host, "desktop-c");
  try {
    await host.start("run-1");
    host.runs.publish("run-1", "chat:approval", APPROVAL);
    await first.open();
    await second.open();
    assert.equal(first.session.getSnapshot().run.approvals.length, 1);
    const a = controlFor(first);
    const c = controlFor(second);

    const [fromA, fromC] = await Promise.all([
      a.respondApproval({ runId: "run-1", approvalId: "ap-1", decision: "allow" }),
      c.respondApproval({ runId: "run-1", approvalId: "ap-1", decision: "deny" }),
    ]);

    assert.equal(host.effects.approvals.length, 1, "the host applied one decision");
    const resolutions = [fromA?.resolution, fromC?.resolution].sort();
    assert.deepEqual(resolutions, ["applied", "elsewhere"]);
    const winner = host.effects.approvals[0]!.split(":")[1];
    const [loserResult, loser] = fromA?.resolution === "elsewhere" ? [fromA, a] : [fromC, c];
    assert.equal(loserResult?.resolution === "elsewhere" && loserResult.decision, winner, "the loser is told the winning decision");
    assert.deepEqual(loser.getSnapshot().elsewhere, { kind: "approval", id: "ap-1", decision: winner });
    const winnerControl = loser === a ? c : a;
    assert.equal(winnerControl.getSnapshot().elsewhere, null);

    await settle();
    await first.session.idle();
    await second.session.idle();
    assert.deepEqual(first.session.getSnapshot().run.approvals, [], "the approval is gone on both Macs");
    assert.deepEqual(second.session.getSnapshot().run.approvals, []);
  } finally {
    first.close();
    second.close();
  }
});

test("a command too long to show in full can be denied from this Mac but not allowed", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await host.start("run-1");
    const command = `Run command: echo ${"x".repeat(2_100)}; rm -rf ~/work`;
    host.runs.publish("run-1", "chat:approval", { ...APPROVAL, summary: command, toolName: "run_command" });
    await harness.open();
    const [shown] = harness.session.getSnapshot().run.approvals;
    assert.equal(shown?.summary.includes("rm -rf"), false, "this Mac never saw the end of the command");
    assert.equal(shown?.canAllow, false);

    const control = controlFor(harness);
    await assert.rejects(control.respondApproval({ runId: "run-1", approvalId: "ap-1", decision: "allow" }));
    assert.deepEqual(host.effects.approvals, [], "the host refused the allow");
    const denied = await control.respondApproval({ runId: "run-1", approvalId: "ap-1", decision: "deny" });
    assert.equal(denied?.resolution, "applied");
    assert.deepEqual(host.effects.approvals, ["ap-1:deny"]);
  } finally {
    harness.close();
  }
});

test("answers and steering from this Mac reach the run on the host", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await host.start("run-1");
    host.runs.publish("run-1", "chat:questionnaire", QUESTION);
    await harness.open();
    const control = controlFor(harness);

    const answered = await control.answerQuestion({
      runId: "run-1",
      promptId: "q-1",
      response: { version: 1, promptId: "q-1", cancelled: false, answers: [{ questionIndex: 0, kind: "option", answer: "main" }] },
    });
    assert.equal(answered?.status, "answered");
    assert.equal(host.effects.answers.length, 1);
    assert.match(host.effects.answers[0]!, /"answer":"main"/);

    const steered = await control.submitInput("run-1", "steer", "Use tables");
    assert.equal(steered.admitted, true);
    assert.equal(steered.queue, "steer");
    assert.deepEqual(host.effects.inputs, ["run-1:steer:Use tables"]);
  } finally {
    harness.close();
  }
});

test("a chat renamed from this Mac can be deleted from it next, and a stale delete rereads instead of overwriting", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await harness.open();
    const control = controlFor(harness);
    // The pane guards each change with the revision of the transcript it shows.
    const shown = () => harness.session.getSnapshot().transcript.revision ?? undefined;
    const reread = async () => {
      await settle();
      await harness.session.idle();
    };

    await control.rename("Release checklist", shown());
    assert.equal(host.chat.title, "Release checklist");
    await reread();

    // Someone renames it on the host before this Mac deletes it.
    host.chat = { ...host.chat, title: "Renamed on the host", updatedAt: host.chat.updatedAt + 1 };
    const stale = shown();
    await assert.rejects(
      control.remove(stale),
      (error: unknown) => error instanceof HostChatControlError && error.remoteCode === "revision_conflict",
    );
    assert.equal(host.removed, false, "a delete against an older revision is refused, not forced");
    await reread();
    assert.notEqual(shown(), stale, "the open chat reread the host's current revision");

    await control.remove(shown());
    assert.equal(host.removed, true);
  } finally {
    harness.close();
  }
});

test("an unreachable host refuses every mutation, and nothing is sent once it is back", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await host.start("run-1");
    await harness.open();
    const control = controlFor(harness);

    // The connection drops (sleep, network change) and the host can't be reached.
    host.down = true;
    harness.manager.wake();
    harness.timers.advance(PEER_WAKE_COALESCE_MS);
    await settle();
    assert.notEqual(harness.adapter.status().availability, "online");
    assert.notEqual(control.refusal("send"), null);
    await assert.rejects(control.send("Are you there?"), code("host_unavailable"));
    await assert.rejects(control.cancel("run-1"), code("host_unavailable"));
    await assert.rejects(control.submitInput("run-1", "steer", "Use tables"), code("host_unavailable"));

    host.down = false;
    harness.manager.reconnect(host.id);
    await settle();
    await harness.adapter.ready();
    assert.equal(harness.adapter.status().availability, "online");
    assert.deepEqual(host.turnRequests(), [], "no message was queued for later");
    assert.deepEqual(host.effects, { cancels: [], approvals: [], answers: [], inputs: [] });
  } finally {
    harness.close();
  }
});

/** The pane's control sequence for a run waiting on an approval. */
async function approveSteerStop(control: ChatSessionControl) {
  const approval = await control.respondApproval({ runId: "run-1", approvalId: "ap-1", decision: "allow" });
  const input = await control.submitInput("run-1", "steer", "Use tables");
  const stopped = await control.cancel("run-1");
  return { approval, admitted: input.admitted, queue: input.queue, stopped };
}

function hostOutcome(runs: HostRunRegistry, effects: FakeHostEffects) {
  const approval = runs.resolution("ap-1");
  return { state: runs.summary("run-1")?.state, approval: approval?.kind === "approval" ? approval.decision : undefined, effects };
}

test("the same session control drives a chat on this Mac and one on another Mac to the same outcome", async () => {
  // This Mac: the local adapter over its own chat APIs, backed by a run on this Mac.
  const localRuns = new HostRunRegistry({ now: () => 5_000, epoch: "runs_local" });
  const localEffects: FakeHostEffects = { cancels: [], approvals: [], answers: [], inputs: [] };
  const local = hostControls(localRuns, localEffects);
  const unused = async () => {
    throw new Error("not part of this flow");
  };
  const localAdapter = new LocalHostAdapter({
    rename: unused,
    remove: unused,
    markRead: unused,
    answerQuestionnaire: unused,
    respondRemoteApproval: unused,
    approve: async (approvalId, decision, options) => {
      local.approve({ runId: localRuns.runForPrompt(approvalId)!, chatId: "chat-1", approvalId, decision, scope: options?.scope });
    },
    stop: async (runId) => local.cancel(runId),
    admitRunInput: (streamId, input) => local.admitInput({ streamId, chatId: "chat-1", mode: input.mode, text: input.text }),
  });
  localRuns.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  localRuns.publish("run-1", "chat:approval", APPROVAL);
  const localControl = new ChatSessionControl(localAdapter, { hostId: localAdapter.hostId, chatId: "chat-1" });
  localControl.attach();

  // Another Mac: the remote adapter over the peer connection.
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  try {
    await host.start("run-1");
    host.runs.publish("run-1", "chat:approval", APPROVAL);
    await harness.open();
    const remoteControl = controlFor(harness);

    const here = await approveSteerStop(localControl);
    const there = await approveSteerStop(remoteControl);
    assert.deepEqual(there, here);
    assert.deepEqual(here, { approval: { resolution: "applied" }, admitted: true, queue: "steer", stopped: true });
    assert.deepEqual(hostOutcome(host.runs, host.effects), hostOutcome(localRuns, localEffects));
    assert.deepEqual(hostOutcome(host.runs, host.effects), {
      state: "cancelled",
      approval: "allow",
      effects: { cancels: ["run-1"], approvals: ["ap-1:allow"], answers: [], inputs: ["run-1:steer:Use tables"] },
    });
  } finally {
    harness.close();
  }
});
