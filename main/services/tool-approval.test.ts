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
