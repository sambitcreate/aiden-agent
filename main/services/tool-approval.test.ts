import assert from "node:assert/strict";
import test from "node:test";
import { ToolApprovalCoordinator } from "./tool-approval.js";

function trackedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let listeners = 0;
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    if (args[0] === "abort") listeners += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    if (args[0] === "abort") listeners -= 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];
  return { controller, signal, listenerCount: () => listeners };
}

test("approval decisions are one-shot and remove abort listeners", async () => {
  const prompts: Array<{ approvalId: string }> = [];
  const approvals = new ToolApprovalCoordinator((prompt) => prompts.push(prompt));
  const tracked = trackedSignal();
  const pending = approvals.request(
    {
      streamId: "stream",
      toolCallId: "call-one",
      toolName: "computer_use",
      summary: "click element 0",
    },
    tracked.signal,
  );
  assert.equal(approvals.pendingCount, 1);
  assert.equal(tracked.listenerCount(), 1);
  assert.equal(approvals.decide(prompts[0].approvalId, true), true);
  assert.equal(await pending, "allowed");
  assert.equal(approvals.pendingCount, 0);
  assert.equal(tracked.listenerCount(), 0);
  assert.equal(approvals.decide(prompts[0].approvalId, true), false);
});

test("deny, abort, stream cancellation, and shutdown leave no pending state", async () => {
  const prompts: Array<{ approvalId: string; streamId: string }> = [];
  const approvals = new ToolApprovalCoordinator((prompt) => prompts.push(prompt));

  const denied = approvals.request({
    streamId: "deny",
    toolCallId: "call-deny",
    toolName: "write_file",
    summary: "write",
  });
  approvals.decide(prompts[prompts.length - 1]!.approvalId, false);
  assert.equal(await denied, "denied");

  const abortedSignal = trackedSignal();
  const aborted = approvals.request(
    { streamId: "abort", toolCallId: "call-abort", toolName: "computer_use", summary: "type" },
    abortedSignal.signal,
  );
  abortedSignal.controller.abort();
  assert.equal(await aborted, "cancelled");
  assert.equal(abortedSignal.listenerCount(), 0);

  const cancelled = approvals.request({
    streamId: "cancel",
    toolCallId: "call-cancel",
    toolName: "edit_file",
    summary: "edit",
  });
  approvals.cancelStream("cancel");
  assert.equal(await cancelled, "cancelled");

  const shutdown = approvals.request({
    streamId: "shutdown",
    toolCallId: "call-shutdown",
    toolName: "run_command",
    summary: "run",
  });
  approvals.shutdown();
  assert.equal(await shutdown, "cancelled");
  assert.equal(approvals.pendingCount, 0);
});

test("an already-aborted request publishes nothing", async () => {
  let publications = 0;
  const approvals = new ToolApprovalCoordinator(() => {
    publications += 1;
  });
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await approvals.request(
      {
        streamId: "stream",
        toolCallId: "call-aborted",
        toolName: "computer_use",
        summary: "click",
      },
      controller.signal,
    ),
    "cancelled",
  );
  assert.equal(publications, 0);
  assert.equal(approvals.pendingCount, 0);
});

test("only the renderer document that received a prompt can decide it", async () => {
  const prompts: Array<{ approvalId: string }> = [];
  const approvals = new ToolApprovalCoordinator((prompt) => prompts.push(prompt));
  const pending = approvals.request(
    {
      streamId: "stream",
      toolCallId: "call-owned",
      toolName: "computer_use",
      summary: "click",
    },
    undefined,
    "document-one",
  );

  assert.equal(approvals.decide(prompts[0].approvalId, true, "document-two"), false);
  assert.equal(approvals.pendingCount, 1);
  assert.equal(approvals.decide(prompts[0].approvalId, true, "document-one"), true);
  assert.equal(await pending, "allowed");
});

test("detaching a renderer denies pending and future approvals without aborting the stream", async () => {
  const prompts: Array<{ approvalId: string }> = [];
  const approvals = new ToolApprovalCoordinator((prompt) => prompts.push(prompt));
  const pending = approvals.request({
    streamId: "detached",
    toolCallId: "call-pending",
    toolName: "write_file",
    summary: "write",
  });

  approvals.detachStream("detached");
  assert.equal(await pending, "detached");
  assert.equal(approvals.pendingCount, 0);
  assert.equal(
    await approvals.request({
      streamId: "detached",
      toolCallId: "call-future",
      toolName: "run_command",
      summary: "run",
    }),
    "detached",
  );
  assert.equal(prompts.length, 1);

  approvals.releaseStream("detached");
  const resumed = approvals.request({
    streamId: "detached",
    toolCallId: "call-released",
    toolName: "edit_file",
    summary: "edit",
  });
  assert.equal(prompts.length, 2);
  approvals.decide(prompts[1]!.approvalId, true);
  assert.equal(await resumed, "allowed");
});

test("publication failures are distinct from user denial", async () => {
  const approvals = new ToolApprovalCoordinator(() => {
    throw new Error("renderer unavailable");
  });
  assert.equal(
    await approvals.request({
      streamId: "unavailable",
      toolCallId: "call-unavailable",
      toolName: "share_image",
      summary: "share",
    }),
    "unavailable",
  );
  assert.equal(approvals.pendingCount, 0);
});

test("abort withdraws a published Live approval immediately", async () => {
  const published: string[] = [];
  const withdrawn: string[] = [];
  const coordinator = new ToolApprovalCoordinator(
    (prompt) => published.push(prompt.approvalId),
    (approvalId) => withdrawn.push(approvalId),
  );
  const abort = new AbortController();
  const decision = coordinator.request(
    {
      streamId: "live:session-1",
      toolCallId: "call-1",
      toolName: "computer_use",
      summary: "click exact target",
    },
    abort.signal,
    "document-1",
  );
  assert.equal(published.length, 1);
  abort.abort();
  assert.equal(await decision, "cancelled");
  assert.deepEqual(withdrawn, published);
  assert.equal(coordinator.pendingCount, 0);
});

test("owner loss still settles when the withdrawal channel is gone", async () => {
  const coordinator = new ToolApprovalCoordinator(
    () => undefined,
    () => {
      throw new Error("renderer document gone");
    },
  );
  const abort = new AbortController();
  const decision = coordinator.request(
    {
      streamId: "live:session-1",
      toolCallId: "call-1",
      toolName: "computer_use",
      summary: "click exact target",
    },
    abort.signal,
    "document-1",
  );
  abort.abort();
  assert.equal(await decision, "cancelled");
  assert.equal(coordinator.pendingCount, 0);
});

const delayedApproval = {
  streamId: "cancelled-generation",
  toolCallId: "delayed-child-call",
  toolName: "write_file",
  summary: "write after asynchronous preparation",
};

test("stream cancellation rejects delayed child approvals with a fresh signal", async () => {
  const prompts: string[] = [];
  const coordinator = new ToolApprovalCoordinator((prompt) => prompts.push(prompt.approvalId));
  const first = coordinator.request(delayedApproval);
  coordinator.cancelStream(delayedApproval.streamId);
  assert.equal(await first, "cancelled");

  const child = trackedSignal();
  const delayed = coordinator.request(delayedApproval, child.signal, "owner");
  assert.equal(prompts.length, 1, "cancellation must close admission, not only drain pending prompts");
  assert.equal(await delayed, "cancelled");
  assert.equal(child.listenerCount(), 0);
  assert.equal(coordinator.pendingCount, 0);
  assert.equal(coordinator.decide(prompts[0]!, true), false);
});

test("cancelling before the first approval still closes that stream only", async () => {
  const prompts: string[] = [];
  const coordinator = new ToolApprovalCoordinator((prompt) => prompts.push(prompt.approvalId));
  coordinator.cancelStream(delayedApproval.streamId);
  const delayed = coordinator.request(delayedApproval);
  assert.equal(prompts.length, 0);
  assert.equal(await delayed, "cancelled");

  const other = coordinator.request({ ...delayedApproval, streamId: "other-generation" });
  assert.equal(prompts.length, 1);
  assert.equal(coordinator.decide(prompts[0]!, true), true);
  assert.equal(await other, "allowed");
});

test("renderer detachment cannot downgrade a cancelled stream", async () => {
  let publications = 0;
  const coordinator = new ToolApprovalCoordinator(() => { publications += 1; });
  coordinator.cancelStream(delayedApproval.streamId);
  coordinator.detachStream(delayedApproval.streamId);
  assert.equal(await coordinator.request(delayedApproval), "cancelled");
  assert.equal(publications, 0);
});

test("release removes a cancelled stream fence after generation settlement", async () => {
  const prompts: string[] = [];
  const coordinator = new ToolApprovalCoordinator((prompt) => prompts.push(prompt.approvalId));
  coordinator.cancelStream(delayedApproval.streamId);
  coordinator.releaseStream(delayedApproval.streamId);
  const next = coordinator.request(delayedApproval);
  assert.equal(prompts.length, 1);
  coordinator.decide(prompts[0]!, false);
  assert.equal(await next, "denied");
});

test("shutdown rejects future requests even after stream release", async () => {
  let publications = 0;
  const coordinator = new ToolApprovalCoordinator(() => { publications += 1; });
  coordinator.detachStream(delayedApproval.streamId);
  coordinator.shutdown();
  coordinator.releaseStream(delayedApproval.streamId);
  coordinator.shutdown();
  const child = trackedSignal();
  const delayed = coordinator.request(delayedApproval, child.signal);
  assert.equal(publications, 0);
  assert.equal(await delayed, "cancelled");
  assert.equal(child.listenerCount(), 0);
  assert.equal(coordinator.pendingCount, 0);
});

for (const boundary of ["cancelStream", "shutdown"] as const) {
  test(`${boundary} closes admission before withdrawal callbacks can reenter`, async () => {
    const prompts: string[] = [];
    let reentrant: Promise<string> | undefined;
    const coordinator = new ToolApprovalCoordinator(
      (prompt) => prompts.push(prompt.approvalId),
      () => { reentrant = coordinator.request(delayedApproval); },
    );
    const tracked = trackedSignal();
    const pending = coordinator.request(delayedApproval, tracked.signal);
    if (boundary === "cancelStream") coordinator.cancelStream(delayedApproval.streamId);
    else coordinator.shutdown();
    assert.equal(prompts.length, 1);
    assert.equal(await pending, "cancelled");
    assert.equal(await reentrant, "cancelled");
    assert.equal(coordinator.pendingCount, 0);
    assert.equal(tracked.listenerCount(), 0);
  });
}

test("aborting one tool request does not close its generation", async () => {
  const prompts: string[] = [];
  const coordinator = new ToolApprovalCoordinator((prompt) => prompts.push(prompt.approvalId));
  const abort = new AbortController();
  const first = coordinator.request(delayedApproval, abort.signal);
  abort.abort();
  assert.equal(await first, "cancelled");
  const next = coordinator.request({ ...delayedApproval, toolCallId: "next-call" });
  assert.equal(prompts.length, 2);
  coordinator.decide(prompts[1]!, true);
  assert.equal(await next, "allowed");
});
