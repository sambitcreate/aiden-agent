import assert from "node:assert/strict";
import test from "node:test";
import { PEER_WAKE_COALESCE_MS } from "./peer-host-manager.js";
import { CREDENTIAL, FakeHost, numbered, settle, setup } from "./peer-remote-chat-test-host.js";

/**
 * The remote chat view's data path end to end: the renderer's adapter and
 * session over main's real live IPC handlers and host supervisor, against a
 * host built from the real run journal, run streams, feed and transcript
 * projection. Only the network and Electron's IPC are stand-ins.
 */

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

test("a run started on the host streams into the open chat and hands off to the persisted reply", async () => {
  const host = new FakeHost("host_b", numbered(4));
  const harness = await setup(host);
  try {
    await harness.open();
    let view = harness.transcript();
    assert.equal(view.status.availability, "online");
    assert.equal(view.stale, false);
    assert.deepEqual(view.transcript.messages.map((message) => message.id), ["m0", "m1", "m2", "m3"]);
    assert.equal(view.row.streamingText, null, "nothing is running yet");
    assert.deepEqual(host.reads, [{ throughMessageId: "m3" }], "opening the chat marks it read on the host");

    // Someone types on the host itself; this Mac only watches.
    host.append({ id: "u4", role: "user", content: "Summarize the release", createdAt: 2_000 });
    await host.start("run-1");
    await settle();
    host.runs.publish("run-1", "chat:reasoning-delta", { delta: "Reading the changelog" });
    host.runs.publish("run-1", "chat:tool", { toolName: "read_file", phase: "call" });
    host.runs.publish("run-1", "chat:approval", {
      approvalId: "ap-1",
      summary: "Run the release script",
      toolCallId: "call-1",
      toolName: "shell",
    });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(last(view.transcript.messages)?.id, "u4", "the host's user turn is read in when the run starts");
    assert.equal(view.row.streamingReasoning, "Reading the changelog");
    assert.deepEqual(
      view.run.approvals.map((prompt) => [prompt.approvalId, prompt.summary, prompt.canAllow]),
      [["ap-1", "Run the release script", true]],
      "the approval is shown with everything needed to decide it",
    );

    host.runs.publish("run-1", "chat:tool", { toolName: "read_file", phase: "result" });
    host.runs.publish("run-1", "chat:delta", { delta: "Three fixes " });
    host.runs.publish("run-1", "chat:delta", { delta: "shipped." });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(view.row.streamingText, "Three fixes shipped.");
    assert.equal(view.row.streamComplete, false);

    host.append({ id: "a5", role: "assistant", content: "Three fixes shipped.", createdAt: 3_000 });
    host.runs.publish("run-1", "chat:done", { chat: { messages: [{ id: "a5", role: "assistant" }] } });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(view.run.status, "done");
    assert.equal(last(view.transcript.messages)?.content, "Three fixes shipped.");
    assert.equal(view.row.streamingText, null, "the persisted reply replaces the streamed row");
    assert.equal(view.row.agentActivity, null);
    assert.deepEqual(last(host.reads), { throughMessageId: "a5" });

    // Nothing that reached the renderer carries the pairing secret or the address.
    const everything = JSON.stringify(harness.delivered);
    assert.equal(everything.includes(CREDENTIAL), false);
    assert.equal(everything.includes("server.example"), false);
  } finally {
    harness.close();
  }
});

test("opening a chat whose run outgrew the host's journal recovers through the gap snapshot", async () => {
  const host = new FakeHost("host_b", numbered(2), 6);
  host.append({ id: "u2", role: "user", content: "Write the migration", createdAt: 2_000 });
  host.runs.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  host.runs.publish("run-1", "chat:approval", {
    approvalId: "ap-1",
    summary: "Edit schema.sql",
    toolCallId: "call-1",
    toolName: "write_file",
  });
  for (let index = 0; index < 20; index += 1) host.runs.publish("run-1", "chat:delta", { delta: `part ${index} ` });
  const harness = await setup(host);
  try {
    await harness.open();
    let view = harness.transcript();
    assert.deepEqual(view.transcript.messages.map((message) => message.id), ["m0", "m1", "u2"]);
    assert.equal(view.run.incomplete, true, "the start of the reply is gone from the host's journal");
    assert.equal(view.row.streamingText, "", "a reply missing its start is not shown mid-sentence");
    assert.notEqual(view.row.agentActivity, null, "the run still reads as active");
    assert.deepEqual(
      view.run.approvals.map((prompt) => prompt.approvalId),
      ["ap-1"],
      "the snapshot reseeds the pending approval whose event was trimmed",
    );

    host.runs.publish("run-1", "chat:delta", { delta: "tail" });
    host.append({ id: "a3", role: "assistant", content: "Migration written.", createdAt: 3_000 });
    host.runs.publish("run-1", "chat:done", { chat: { messages: [{ id: "a3", role: "assistant" }] } });
    await settle();
    await harness.session.idle();
    view = harness.transcript();
    assert.equal(last(view.transcript.messages)?.content, "Migration written.");
    assert.equal(view.row.streamingText, null);
    assert.equal(view.error, null);
  } finally {
    harness.close();
  }
});

test("a window joining a run whose shared buffer overflowed still shows the pending approval until it resolves", async () => {
  const host = new FakeHost("host_b", numbered(2));
  const harness = await setup(host);
  let another: Awaited<ReturnType<typeof harness.openAnother>> | undefined;
  try {
    await harness.open();
    await host.start("run-1");
    await settle();
    host.runs.publish("run-1", "chat:approval", {
      approvalId: "ap-1",
      summary: "Run the release script",
      toolCallId: "call-1",
      toolName: "shell",
    });
    // A long reply streams past the approval, well beyond this Mac's shared buffer.
    for (let index = 0; index < 600; index += 1) host.runs.publish("run-1", "chat:delta", { delta: "x" });
    await settle();
    await harness.session.idle();
    assert.deepEqual(harness.transcript().run.approvals.map((prompt) => prompt.approvalId), ["ap-1"]);

    another = await harness.openAnother();
    let joined = another.read();
    assert.equal(joined.run.incomplete, true, "the reply's start is no longer buffered on this Mac");
    assert.deepEqual(
      joined.run.approvals.map((prompt) => [prompt.approvalId, prompt.canAllow]),
      [["ap-1", true]],
      "the approval the buffer dropped is still shown",
    );

    host.runs.resolveAttention("ap-1");
    await settle();
    await another.session.idle();
    await harness.session.idle();
    joined = another.read();
    assert.deepEqual(joined.run.approvals, [], "answered on the host, the prompt leaves the joining window");
    assert.deepEqual(harness.transcript().run.approvals, []);
  } finally {
    another?.dispose();
    harness.close();
  }
});

test("a large chat opens on its newest page and pages back to the start", async () => {
  const host = new FakeHost("host_b", numbered(500));
  const harness = await setup(host);
  try {
    await harness.open();
    let view = harness.transcript();
    assert.equal(view.transcript.messages.length, 50);
    assert.equal(view.transcript.messages[0]?.id, "m450");
    assert.equal(view.transcript.hasOlder, true);
    assert.equal(host.windowReads().length, 1, "opening reads one page, not the whole chat");

    for (let page = 0; page < 9; page += 1) await harness.session.loadOlder();
    view = harness.transcript();
    assert.equal(view.transcript.messages.length, 500);
    assert.deepEqual(
      view.transcript.messages.map((message) => message.id),
      numbered(500).map((message) => message.id),
      "every page lands once, in order",
    );
    assert.equal(view.transcript.hasOlder, false);
    await harness.session.loadOlder();
    assert.equal(host.windowReads().length, 10, "nothing is read past the start");
  } finally {
    harness.close();
  }
});

test("a page read across a reconnect is dropped and the newest page is read again", async () => {
  const host = new FakeHost("host_b", numbered(120));
  const harness = await setup(host);
  try {
    await harness.open();
    const before = harness.transcript();
    const generation = before.status.generation;
    assert.equal(before.transcript.messages[0]?.id, "m70");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.windowGate = () => gate;
    const older = harness.session.loadOlder();
    await settle();
    assert.equal(harness.transcript().loadingOlder, true);

    // The Mac wakes from sleep and the host connection is re-established.
    harness.manager.wake();
    harness.timers.advance(PEER_WAKE_COALESCE_MS);
    await settle();
    host.windowGate = undefined;
    release();
    await older;
    await settle();
    await harness.session.idle();

    const after = harness.transcript();
    assert.ok(after.status.generation > generation);
    assert.equal(after.status.availability, "online");
    assert.equal(after.transcript.messages[0]?.id, "m70", "the superseded page was not merged");
    assert.equal(after.transcript.messages.length, 50);
    assert.equal(after.loadingOlder, false);
    assert.equal(after.error, null);
    assert.ok(host.windowReads().length >= 3, "the newest page was read again under the new connection");
  } finally {
    harness.close();
  }
});
