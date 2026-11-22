import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentStep } from "../../../renderer/shared/generation-timeline.js";
import {
  MAX_SUBAGENT_TRANSCRIPT_BYTES,
  MAX_SUBAGENT_TRANSCRIPT_ENTRIES,
  MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS,
  SUBAGENT_TRANSCRIPT_VERSION,
  trimSubagentTranscriptToBytes,
  type SubagentTranscriptChange,
  type SubagentTranscriptEntry,
  type SubagentTranscriptUpdateV1,
  type SubagentTranscriptV1,
} from "../../../renderer/shared/subagent-transcript.js";
import { GenerationTimelineProjector } from "../generation-timeline.js";
import { terminalAssistantText } from "../generation-runtime.js";
import { sanitizeSubagentWorkText } from "./subagent-work-text-filter.js";

/** About four live updates a second; the final state is always written. */
export const SUBAGENT_TRANSCRIPT_FLUSH_INTERVAL_MS = 250;

export type SubagentTranscriptFinishStatus = "completed" | "failed" | "cancelled";

export interface SubagentTranscriptSink {
  /**
   * Save the whole transcript. Called before the matching `publish`. `final`
   * is true for the helper's last state, which is worth flushing to disk.
   */
  persist(transcript: SubagentTranscriptV1, final: boolean): Promise<void>;
  /** Stream the change to open windows. Optional: Bots and the CLI only save. */
  publish?(update: SubagentTranscriptUpdateV1): void;
}

export interface SubagentTranscriptRecorderOptions {
  runId: string;
  task: string;
  sink: SubagentTranscriptSink;
  now?: () => number;
  intervalMs?: number;
  maxBytes?: number;
  /** The main chat's display filter; replaceable only in tests. */
  sanitize?: (text: string) => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

interface MessageState {
  raw: string;
  projector: GenerationTimelineProjector;
  startedAt: number;
  finishedAt?: number;
  /** Display text cache, valid while `raw` is unchanged. */
  safeFor?: string;
  safe: string;
  /** Raw offset -> display offset, valid while the raw prefix is unchanged. */
  offsets: Map<number, number>;
}

/**
 * Records one helper's conversation as it happens: the task, then each
 * message the helper writes with its tool and thinking steps. Updates are
 * batched to about four a second; each batch is saved first and then
 * streamed, so a reader that joins late can always meet the stream from the
 * saved copy. Text goes through the main chat's credential filter, which
 * hides secrets but keeps file paths readable.
 */
export class SubagentTranscriptRecorder {
  readonly runId: string;
  private readonly sink: SubagentTranscriptSink;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly maxBytes: number;
  private readonly sanitize: (text: string) => string;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private readonly task: string;
  private readonly messages: MessageState[] = [];
  private current: MessageState | null = null;
  private published: SubagentTranscriptEntry[] = [];
  private publishedJson: string[] = [];
  private lastTrimmed = false;
  private revision = 0;
  private trimmed = false;
  private dirty = true;
  private finished = false;
  private timer: unknown = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: SubagentTranscriptRecorderOptions) {
    this.runId = options.runId;
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? SUBAGENT_TRANSCRIPT_FLUSH_INTERVAL_MS;
    this.maxBytes = options.maxBytes ?? MAX_SUBAGENT_TRANSCRIPT_BYTES;
    this.sanitize = options.sanitize ?? sanitizeSubagentWorkText;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? (() => {});
    this.task = clip(this.sanitize(options.task));
    // Revision 1 is the task alone, written straight away.
    this.enqueueFlush();
  }

  /** Feed one Pi agent event from the helper. Never throws. */
  observe(event: AgentEvent): void {
    try {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") this.messageStarted();
          return;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") this.textDelta(update.delta);
          else if (update.type === "thinking_delta") this.thinkingStarted();
          else if (update.type === "toolcall_delta") this.thinkingEnded();
          return;
        }
        case "message_end":
          if (event.message.role === "assistant") this.messageEnded(terminalAssistantText(event.message));
          return;
        case "tool_execution_start":
          this.toolStarted(event.toolCallId, event.toolName, event.args);
          return;
        case "tool_execution_end":
          this.toolFinished(event.toolCallId, event.isError ? "failed" : "completed");
          return;
        default:
          return;
      }
    } catch (error) {
      this.onError(error);
    }
  }

  messageStarted(): void {
    if (this.finished) return;
    this.closeCurrent("completed");
    if (this.messages.length + 1 >= MAX_SUBAGENT_TRANSCRIPT_ENTRIES) {
      // Later messages are not kept; the transcript says something is missing.
      this.trimmed = true;
      this.current = null;
      this.changed();
      return;
    }
    const projector = new GenerationTimelineProjector("subagent-transcript", () => {}, this.now);
    projector.beginAssistantMessage();
    const message: MessageState = {
      raw: "",
      projector,
      startedAt: this.now(),
      safe: "",
      offsets: new Map(),
    };
    this.messages.push(message);
    this.current = message;
    this.changed();
  }

  textDelta(delta: string): void {
    const message = this.active();
    if (!message || !delta) return;
    message.projector.thinkingEnded();
    message.raw += delta;
    this.changed();
  }

  thinkingStarted(): void {
    const message = this.active();
    if (!message) return;
    message.projector.setContentOffset(message.raw.length);
    message.projector.thinkingStarted();
    this.changed();
  }

  thinkingEnded(): void {
    const message = this.active();
    if (!message) return;
    message.projector.thinkingEnded();
    this.changed();
  }

  /** The helper's settled text for this message replaces what streamed. */
  messageEnded(text?: string): void {
    const message = this.active();
    if (!message) return;
    message.projector.thinkingEnded();
    if (typeof text === "string" && text !== message.raw) {
      if (!text.startsWith(message.raw)) message.offsets.clear();
      message.raw = text;
    }
    this.changed();
  }

  /** Tools run after the message that asked for them, so they join it. */
  toolStarted(toolCallId: string, toolName: string, args: unknown): void {
    const message = this.active(true);
    if (!message) return;
    message.projector.setContentOffset(message.raw.length);
    message.projector.toolStarted(toolCallId, toolName, args);
    message.projector.toolRunning(toolCallId);
    this.changed();
  }

  toolFinished(toolCallId: string, status: "completed" | "failed"): void {
    if (this.finished) return;
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const projector = this.messages[index]!.projector;
      if (projector.publicToolCallId(toolCallId) === undefined) continue;
      projector.toolFinished(toolCallId, status);
      this.changed();
      return;
    }
  }

  /**
   * Close the last message, write the final state and stream it. Resolves
   * once everything queued is written; later events are ignored.
   */
  async finish(status: SubagentTranscriptFinishStatus): Promise<void> {
    if (!this.finished) {
      this.closeCurrent(status);
      for (const message of this.messages) message.projector.finish(status);
      this.finished = true;
      this.dirty = true;
      if (this.timer !== null) {
        this.clearTimer(this.timer);
        this.timer = null;
      }
      this.enqueueFlush();
    }
    await this.chain;
  }

  private active(create = false): MessageState | null {
    if (this.finished) return null;
    if (!this.current && create) this.messageStarted();
    return this.current;
  }

  private closeCurrent(status: SubagentTranscriptFinishStatus): void {
    const message = this.current;
    if (!message) return;
    message.projector.finish(status);
    message.finishedAt = this.now();
    this.current = null;
  }

  private changed(): void {
    this.dirty = true;
    if (this.finished || this.timer !== null) return;
    const wait = Math.max(0, this.lastFlushAt + this.intervalMs - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.enqueueFlush();
    }, wait);
  }

  private enqueueFlush(): void {
    this.chain = this.chain.then(() => this.flush()).catch((error: unknown) => this.onError(error));
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlushAt = this.now();
    const transcript = trimSubagentTranscriptToBytes(
      {
        version: SUBAGENT_TRANSCRIPT_VERSION,
        runId: this.runId,
        revision: this.revision + 1,
        trimmed: this.trimmed,
        entries: [{ kind: "task", text: this.task }, ...this.messages.map((message) => this.entry(message))],
      },
      this.maxBytes,
    );
    if (transcript.trimmed) this.trimmed = true;
    const changes: SubagentTranscriptChange[] = [];
    const json = transcript.entries.map((entry) => JSON.stringify(entry));
    for (const [index, entry] of transcript.entries.entries()) {
      if (json[index] !== this.publishedJson[index]) changes.push({ index, entry });
    }
    if (
      this.revision > 0 &&
      changes.length === 0 &&
      transcript.entries.length === this.published.length &&
      transcript.trimmed === this.lastTrimmed
    ) {
      return;
    }
    const baseRevision = this.revision;
    this.revision = transcript.revision;
    this.published = transcript.entries;
    this.publishedJson = json;
    this.lastTrimmed = transcript.trimmed;
    try {
      await this.sink.persist(transcript, this.finished);
    } catch (error) {
      this.onError(error);
    }
    try {
      this.sink.publish?.({
        version: SUBAGENT_TRANSCRIPT_VERSION,
        runId: this.runId,
        baseRevision,
        revision: transcript.revision,
        trimmed: transcript.trimmed,
        entryCount: transcript.entries.length,
        changes,
      });
    } catch (error) {
      this.onError(error);
    }
  }

  private entry(message: MessageState): SubagentTranscriptEntry {
    if (message.safeFor !== message.raw) {
      message.safe = clip(this.sanitize(message.raw));
      message.safeFor = message.raw;
    }
    const text = message.safe;
    let floor = 0;
    const steps = message.projector.snapshot().steps.map((step) => {
      const mapped = Math.max(floor, Math.min(text.length, this.displayOffset(message, step.contentOffset ?? 0)));
      floor = mapped;
      return { ...step, contentOffset: mapped } as AgentStep;
    });
    return {
      kind: "message",
      text,
      steps,
      startedAt: message.startedAt,
      ...(message.finishedAt === undefined ? {} : { finishedAt: Math.max(message.startedAt, message.finishedAt) }),
    };
  }

  /** Where a raw text position lands once the text is filtered for display. */
  private displayOffset(message: MessageState, rawOffset: number): number {
    const offset = Math.max(0, Math.min(rawOffset, message.raw.length));
    if (offset === 0) return 0;
    if (offset === message.raw.length) return message.safe.length;
    const cached = message.offsets.get(offset);
    if (cached !== undefined) return cached;
    const mapped = this.sanitize(message.raw.slice(0, offset)).length;
    message.offsets.set(offset, mapped);
    return mapped;
  }
}

function clip(text: string): string {
  return text.length > MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS ? text.slice(0, MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS) : text;
}
