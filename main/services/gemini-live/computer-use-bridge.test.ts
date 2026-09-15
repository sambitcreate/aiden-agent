import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ComputerUseApprovalDescriptor,
  ComputerUseResultDetails,
} from "../computer-use/controller.js";
import type { ComputerUseArgs } from "../computer-use/schema.js";
import {
  GEMINI_LIVE_COMPUTER_USE_MAX_QUEUE,
  GeminiLiveComputerUseBridge,
  geminiLiveComputerUseResponse,
  type GeminiLiveComputerUseController,
} from "./computer-use-bridge.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function result(
  action: ComputerUseArgs["action"],
  options: { capturedAfter?: boolean; image?: string } = {},
): AgentToolResult<ComputerUseResultDetails> {
  return {
    content: [
      { type: "text", text: JSON.stringify({ ok: true, action }) },
      ...(options.image
        ? [{ type: "image" as const, data: options.image, mimeType: "image/png" as const }]
        : []),
    ],
    details: { action, capturedAfter: options.capturedAfter },
  };
}

class FakeController implements GeminiLiveComputerUseController {
  approvals: ComputerUseArgs[] = [];
  authorizations: string[] = [];
  executions: string[] = [];
  closed = false;
  executeCall: (
    id: string,
    args: ComputerUseArgs,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<ComputerUseResultDetails>> = async (_id, args) =>
    result(args.action);

  async approvalFor(args: ComputerUseArgs): Promise<ComputerUseApprovalDescriptor | null> {
    if (["capture", "wait", "list_apps", "list_windows"].includes(args.action)) return null;
    this.approvals.push(args);
    return {
      toolName: "computer_use",
      summary: `${args.action} exact target${args.delivery_mode === "foreground" ? " foreground" : ""}`,
      target: { pid: 7, windowId: 11 },
      grant: {} as ComputerUseApprovalDescriptor["grant"],
    };
  }

  authorize(id: string): void {
    this.authorizations.push(id);
  }

  async execute(
    id: string,
    args: ComputerUseArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>> {
    this.executions.push(id);
    return this.executeCall(id, args, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function harness(overrides: {
  controller?: FakeController;
  authorized?: () => boolean | Promise<boolean>;
  approve?: (signal: AbortSignal, summary: string) => Promise<boolean>;
} = {}) {
  const controller = overrides.controller ?? new FakeController();
  const responses: Array<{ id: string; response: Record<string, unknown> }> = [];
  const approvalSummaries: string[] = [];
  const bridge = new GeminiLiveComputerUseBridge({
    sessionId: "session-1",
    controller,
    isAuthorized: overrides.authorized ?? (() => true),
    requestApproval: ({ signal, summary }) => {
      approvalSummaries.push(summary);
      return overrides.approve?.(signal, summary) ?? Promise.resolve(true);
    },
    sendResult: ({ id, response }) => responses.push({ id, response }),
  });
  return { bridge, controller, responses, approvalSummaries };
}

test("Live bridge rejects unknown tools and fields before the controller", async () => {
  const h = harness();
  h.bridge.enqueue({ id: "wrong", name: "shell", args: {} });
  h.bridge.enqueue({
    id: "fields",
    name: "computer_use",
    args: { action: "list_apps", api_key: "secret" },
  });
  await tick();
  assert.deepEqual(h.controller.executions, []);
  assert.deepEqual(
    h.responses.map(({ id, response }) => [id, (response.error as { code: string }).code]),
    [
      ["wrong", "unknown_tool"],
      ["fields", "invalid_arguments"],
    ],
  );
});

test("capture is read-only while every mutation gets a fresh approval", async () => {
  const h = harness();
  h.bridge.enqueue({
    id: "capture",
    name: "computer_use",
    args: { action: "capture", app: "Notes" },
  });
  await tick();
  h.bridge.enqueue({
    id: "click",
    name: "computer_use",
    args: { action: "click", coordinate: [10, 20] },
  });
  await tick();
  h.bridge.enqueue({
    id: "foreground",
    name: "computer_use",
    args: {
      action: "type",
      text: "hello",
      delivery_mode: "foreground",
      bring_to_front: true,
    },
  });
  await tick();
  assert.deepEqual(h.controller.authorizations, ["click", "foreground"]);
  assert.equal(h.approvalSummaries.length, 2);
  assert.match(h.approvalSummaries[1]!, /foreground/u);
});

test("coordinate mutations require a current capture and post-capture is target-specific", async () => {
  const h = harness();
  h.controller.executeCall = async (_id, args) =>
    result(args.action, { capturedAfter: args.capture_after === true });
  h.bridge.enqueue({
    id: "before",
    name: "computer_use",
    args: { action: "click", coordinate: [1, 2] },
  });
  await tick();
  assert.equal((h.responses[0]!.response.error as { code: string }).code, "computer_use_rejected");
  assert.deepEqual(h.controller.approvals, []);

  h.bridge.enqueue({
    id: "capture",
    name: "computer_use",
    args: { action: "capture", pid: 7, window_id: 11 },
  });
  await tick();
  h.bridge.enqueue({
    id: "with-post",
    name: "computer_use",
    args: { action: "click", coordinate: [1, 2], capture_after: true },
  });
  await tick();
  h.bridge.enqueue({
    id: "after-post",
    name: "computer_use",
    args: { action: "click", coordinate: [3, 4] },
  });
  await tick();
  assert.deepEqual(h.controller.authorizations, ["with-post", "after-post"]);
});

test("compound calls stay sequential and the session queue is bounded", async () => {
  const h = harness();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.controller.executeCall = async (_id, args) => {
    if (args.action === "list_apps") await held;
    return result(args.action);
  };
  h.bridge.enqueue({ id: "active", name: "computer_use", args: { action: "list_apps" } });
  await tick();
  for (let index = 1; index < GEMINI_LIVE_COMPUTER_USE_MAX_QUEUE; index += 1) {
    assert.equal(
      h.bridge.enqueue({
        id: `queued-${index}`,
        name: "computer_use",
        args: { action: "wait", seconds: 0 },
      }),
      true,
    );
  }
  assert.equal(
    h.bridge.enqueue({ id: "overflow", name: "computer_use", args: { action: "wait" } }),
    false,
  );
  assert.equal(h.controller.executions.length, 1);
  assert.equal(
    (h.responses.find(({ id }) => id === "overflow")!.response.error as { code: string }).code,
    "queue_full",
  );
  release();
  await tick();
  await tick();
  assert.equal(h.controller.executions.length, GEMINI_LIVE_COMPUTER_USE_MAX_QUEUE);
});

test("server cancellation and interruption abort pending approval before execution", async () => {
  let approvalAborted = 0;
  const h = harness({
    approve: (signal) =>
      new Promise<boolean>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            approvalAborted += 1;
            resolve(false);
          },
          { once: true },
        );
      }),
  });
  h.bridge.enqueue({
    id: "capture",
    name: "computer_use",
    args: { action: "capture", app: "Notes" },
  });
  await tick();
  h.bridge.enqueue({
    id: "click",
    name: "computer_use",
    args: { action: "click", element: 0 },
  });
  await tick();
  h.bridge.cancel("click");
  await tick();
  assert.equal(approvalAborted, 1);
  assert.deepEqual(h.controller.executions, ["capture"]);

  h.bridge.enqueue({
    id: "type",
    name: "computer_use",
    args: { action: "type", text: "hello" },
  });
  await tick();
  h.bridge.interrupt();
  await tick();
  assert.equal(approvalAborted, 2);
  assert.deepEqual(h.controller.executions, ["capture"]);
});

test("Stop closes the controller and gate withdrawal fails closed", async () => {
  let authorized = true;
  const h = harness({ authorized: () => authorized });
  authorized = false;
  h.bridge.enqueue({ id: "apps", name: "computer_use", args: { action: "list_apps" } });
  await tick();
  assert.deepEqual(h.controller.executions, []);
  assert.equal((h.responses[0]!.response.error as { code: string }).code, "computer_use_rejected");
  h.bridge.close();
  await tick();
  assert.equal(h.controller.closed, true);
  assert.equal(
    h.bridge.enqueue({ id: "late", name: "computer_use", args: { action: "list_apps" } }),
    false,
  );
});

test("tool response keeps only bounded transient screenshots and has no persistence field", () => {
  const small = geminiLiveComputerUseResponse(result("capture", { image: "a".repeat(100) }));
  assert.deepEqual((small.screenshot as { mime_type: string }).mime_type, "image/png");
  assert.equal("path" in small, false);
  assert.equal("history" in small, false);
  const large = geminiLiveComputerUseResponse(
    result("capture", { image: "a".repeat(12_001) }),
  );
  assert.equal("screenshot" in large, false);
});
