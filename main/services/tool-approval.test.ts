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
  assert.equal(await pending, true);
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
  assert.equal(await denied, false);

  const abortedSignal = trackedSignal();
  const aborted = approvals.request(
    { streamId: "abort", toolCallId: "call-abort", toolName: "computer_use", summary: "type" },
    abortedSignal.signal,
  );
  abortedSignal.controller.abort();
  assert.equal(await aborted, false);
  assert.equal(abortedSignal.listenerCount(), 0);

  const cancelled = approvals.request({
    streamId: "cancel",
    toolCallId: "call-cancel",
    toolName: "edit_file",
    summary: "edit",
  });
  approvals.cancelStream("cancel");
  assert.equal(await cancelled, false);

  const shutdown = approvals.request({
    streamId: "shutdown",
    toolCallId: "call-shutdown",
    toolName: "run_command",
    summary: "run",
  });
  approvals.shutdown();
  assert.equal(await shutdown, false);
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
    false,
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
  assert.equal(await pending, true);
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
  assert.equal(await decision, false);
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
  assert.equal(await decision, false);
  assert.equal(coordinator.pendingCount, 0);
});
