import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ComputerUseApprovalDescriptor, ComputerUseResultDetails } from "../computer-use/controller.js";
import type { ComputerUseArgs } from "../computer-use/schema.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import { computerUseNeedsApproval, normalizeComputerUseArgs } from "../computer-use/safety.js";

export const GEMINI_LIVE_COMPUTER_USE_MAX_QUEUE = 8;
const MAX_TEXT_CHARS = 16_000;
const MAX_SCREENSHOT_BASE64_CHARS = 12_000;

export interface GeminiLiveComputerUseController {
  approvalFor(
    args: ComputerUseArgs,
    signal?: AbortSignal,
  ): Promise<ComputerUseApprovalDescriptor | null>;
  authorize(
    toolCallId: string,
    args: ComputerUseArgs,
    approval: ComputerUseApprovalDescriptor,
  ): void;
  execute(
    toolCallId: string,
    args: ComputerUseArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ComputerUseResultDetails>>;
  close(): Promise<void>;
}

export interface GeminiLiveComputerUseCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiLiveComputerUseBridgeOptions {
  sessionId: string;
  controller: GeminiLiveComputerUseController;
  isAuthorized(): boolean | Promise<boolean>;
  requestApproval(input: {
    streamId: string;
    toolCallId: string;
    toolName: typeof COMPUTER_USE_TOOL_NAME;
    summary: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  sendResult(result: {
    id: string;
    name: string;
    response: Record<string, unknown>;
  }): void;
}

interface QueueEntry {
  call: GeminiLiveComputerUseCall;
  args: ComputerUseArgs;
  controller: AbortController;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Computer Use rejected this request.";
  return message.replace(/\0/gu, "").slice(0, 1_000) || "Computer Use rejected this request.";
}

function parseTextPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, MAX_TEXT_CHARS);
  }
}

/** Convert Pi's transient tool parts to one bounded Live-only response object. */
export function geminiLiveComputerUseResponse(
  result: AgentToolResult<ComputerUseResultDetails>,
): Record<string, unknown> {
  const text = result.content.find((part) => part.type === "text");
  const image = result.content.find((part) => part.type === "image");
  const response: Record<string, unknown> = {
    ok: true,
    action: result.details.action,
    result: text?.type === "text" ? parseTextPayload(text.text.slice(0, MAX_TEXT_CHARS)) : null,
    ...(result.details.target ? { target: result.details.target } : {}),
    ...(result.details.capturedAfter === true ? { captured_after: true } : {}),
  };
  // Screenshots are never written to chat history. A small image may ride only
  // this synchronous provider response; larger captures remain represented by
  // their bounded structured observation and dimensions.
  if (
    image?.type === "image" &&
    image.data.length <= MAX_SCREENSHOT_BASE64_CHARS &&
    (image.mimeType === "image/png" || image.mimeType === "image/jpeg")
  ) {
    response.screenshot = { mime_type: image.mimeType, data: image.data };
  }
  return response;
}

function failedResponse(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message: message.slice(0, 1_000) } };
}

/**
 * Session-owned sequential adapter. Closing or interrupting it synchronously
 * revokes every queued signal before controller or provider teardown proceeds.
 */
export class GeminiLiveComputerUseBridge {
  private readonly queue: QueueEntry[] = [];
  private readonly calls = new Map<string, "queued" | "running" | "complete" | "cancelled">();
  private active: QueueEntry | null = null;
  private closed = false;
  private currentCapture = false;

  constructor(private readonly options: GeminiLiveComputerUseBridgeOptions) {}

  enqueue(call: GeminiLiveComputerUseCall): boolean {
    if (this.closed || this.calls.has(call.id)) return false;
    if (call.name !== COMPUTER_USE_TOOL_NAME) {
      this.calls.set(call.id, "complete");
      this.send(call, failedResponse("unknown_tool", "Only Aiden computer_use is available."));
      return false;
    }
    let args: ComputerUseArgs;
    try {
      args = normalizeComputerUseArgs(call.args as ComputerUseArgs);
    } catch (error) {
      this.calls.set(call.id, "complete");
      this.send(call, failedResponse("invalid_arguments", safeMessage(error)));
      return false;
    }
    if (this.queue.length + (this.active ? 1 : 0) >= GEMINI_LIVE_COMPUTER_USE_MAX_QUEUE) {
      this.calls.set(call.id, "complete");
      this.send(call, failedResponse("queue_full", "The attended Computer Use queue is full."));
      return false;
    }
    const entry = { call, args, controller: new AbortController() };
    this.calls.set(call.id, "queued");
    this.queue.push(entry);
    void this.drain();
    return true;
  }

  cancel(toolCallId: string): void {
    if (this.active?.call.id === toolCallId) {
      this.calls.set(toolCallId, "cancelled");
      this.active.controller.abort(new Error("The Live tool call was cancelled."));
      return;
    }
    const index = this.queue.findIndex((entry) => entry.call.id === toolCallId);
    if (index < 0) return;
    const [entry] = this.queue.splice(index, 1);
    this.calls.set(toolCallId, "cancelled");
    entry?.controller.abort(new Error("The Live tool call was cancelled."));
  }

  interrupt(): void {
    this.invalidate("The Live turn was interrupted.");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.invalidate("The Live session stopped.");
    // close() revokes the controller lifecycle synchronously before its first
    // await, which is the ordering guarantee required before socket close.
    void this.options.controller.close().catch(() => undefined);
  }

  get pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  private invalidate(reason: string): void {
    this.currentCapture = false;
    if (this.active) {
      this.calls.set(this.active.call.id, "cancelled");
      this.active.controller.abort(new Error(reason));
    }
    for (const entry of this.queue.splice(0)) {
      this.calls.set(entry.call.id, "cancelled");
      entry.controller.abort(new Error(reason));
    }
  }

  private async drain(): Promise<void> {
    if (this.closed || this.active) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry;
    this.calls.set(entry.call.id, "running");
    try {
      if (!(await this.options.isAuthorized())) {
        throw new Error("Computer Use is no longer enabled for this Assistant conversation.");
      }
      const coordinateMutation =
        computerUseNeedsApproval(entry.args) &&
        ("coordinate" in entry.args || "from_coordinate" in entry.args || "to_coordinate" in entry.args);
      if (coordinateMutation && !this.currentCapture) {
        throw new Error("Capture the current target before using coordinates.");
      }
      const approval = await this.options.controller.approvalFor(
        entry.args,
        entry.controller.signal,
      );
      if (approval) {
        const allowed = await this.options.requestApproval({
          streamId: `live:${this.options.sessionId}`,
          toolCallId: entry.call.id,
          toolName: COMPUTER_USE_TOOL_NAME,
          summary: approval.summary,
          signal: entry.controller.signal,
        });
        if (!allowed) throw new Error("The user did not allow this Computer Use action.");
        if (!(await this.options.isAuthorized()) || entry.controller.signal.aborted) {
          throw new Error("Computer Use approval is stale.");
        }
        this.options.controller.authorize(entry.call.id, entry.args, approval);
      }
      const result = await this.options.controller.execute(
        entry.call.id,
        entry.args,
        entry.controller.signal,
      );
      if (this.calls.get(entry.call.id) === "cancelled" || entry.controller.signal.aborted) return;
      this.calls.set(entry.call.id, "complete");
      if (entry.args.action === "capture") this.currentCapture = true;
      else if (computerUseNeedsApproval(entry.args)) {
        this.currentCapture = result.details.capturedAfter === true;
      }
      this.send(entry.call, geminiLiveComputerUseResponse(result));
    } catch (error) {
      if (this.calls.get(entry.call.id) !== "cancelled" && !entry.controller.signal.aborted) {
        this.calls.set(entry.call.id, "complete");
        this.send(entry.call, failedResponse("computer_use_rejected", safeMessage(error)));
      }
    } finally {
      if (this.active === entry) this.active = null;
      if (!this.closed) void this.drain();
    }
  }

  private send(call: GeminiLiveComputerUseCall, response: Record<string, unknown>): void {
    if (this.closed) return;
    this.options.sendResult({ id: call.id, name: call.name, response });
  }
}
