/**
 * Protocol-correct Pi assistant stream for one ACP turn segment.
 *
 * Adapted from pi-antigravity-acp-provider src/stream/pi-events.ts @ 07e369b
 * (MIT). Every stream emits `start`, balanced text/thinking blocks, and
 * exactly one terminal `done` or `error`.
 */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type StopReason,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";

import { errorMessage } from "./errors.js";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export class PiEventWriter {
  readonly stream: AssistantMessageEventStream;
  readonly message: AssistantMessage;
  private open: { kind: "text" | "thinking"; index: number } | undefined;
  private started = false;
  private terminal = false;

  constructor(model: Model<Api>) {
    this.stream = createAssistantMessageEventStream();
    this.message = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
  }

  get finished(): boolean {
    return this.terminal;
  }

  text(delta: string): void {
    if (!delta || this.terminal) return;
    const index = this.ensureOpen("text");
    const block = this.message.content[index];
    if (!block || block.type !== "text") return;
    block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.message });
  }

  thinking(delta: string): void {
    if (!delta || this.terminal) return;
    const index = this.ensureOpen("thinking");
    const block = this.message.content[index];
    if (!block || block.type !== "thinking") return;
    block.thinking += delta;
    this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.message });
  }

  toolCall(id: string, name: string, args: JsonObject): void {
    if (this.terminal) return;
    this.ensureStarted();
    this.closeOpen();
    const toolCall: ToolCall = { type: "toolCall", id, name, arguments: args };
    this.message.content.push(toolCall);
    const contentIndex = this.message.content.length - 1;
    this.stream.push({ type: "toolcall_start", contentIndex, partial: this.message });
    this.stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: JSON.stringify(args),
      partial: this.message,
    });
    this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.message });
  }

  done(reason: Extract<StopReason, "stop" | "length" | "toolUse">): void {
    if (this.terminal) return;
    this.ensureStarted();
    if (this.message.content.length === 0) this.ensureOpen("text");
    this.closeOpen();
    this.terminal = true;
    this.message.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.message });
    this.stream.end();
  }

  fail(cause: unknown, aborted = false): void {
    if (this.terminal) return;
    this.closeOpen();
    this.terminal = true;
    this.message.stopReason = aborted ? "aborted" : "error";
    this.message.errorMessage = errorMessage(cause);
    this.stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: this.message });
    this.stream.end();
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.stream.push({ type: "start", partial: this.message });
  }

  private ensureOpen(kind: "text" | "thinking"): number {
    if (this.open?.kind === kind) return this.open.index;
    this.closeOpen();
    this.ensureStarted();
    const index = this.message.content.length;
    if (kind === "text") {
      this.message.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex: index, partial: this.message });
    } else {
      this.message.content.push({ type: "thinking", thinking: "" });
      this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.message });
    }
    this.open = { kind, index };
    return index;
  }

  private closeOpen(): void {
    if (!this.open) return;
    const { kind, index } = this.open;
    this.open = undefined;
    const block = this.message.content[index];
    if (kind === "text" && block?.type === "text") {
      this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.message });
    } else if (kind === "thinking" && block?.type === "thinking") {
      this.stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: this.message,
      });
    }
  }
}
