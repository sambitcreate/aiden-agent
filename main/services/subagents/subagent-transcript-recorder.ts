import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentStep } from "../../../renderer/shared/generation-timeline.js";
import {
  MAX_SUBAGENT_TRANSCRIPT_BYTES,
  MAX_SUBAGENT_TRANSCRIPT_ENTRIES,
  MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS,
  SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_MARKER,
  SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_PREFIX,
  SUBAGENT_TRANSCRIPT_VERSION,
  subagentTranscriptEntryBytes,
  trimmedStepOffset,
  trimmedTextBody,
  trimSubagentTranscriptToBytes,
  type SubagentTranscriptChange,
  type SubagentTranscriptEntry,
  type SubagentTranscriptMessageEntry,
  type SubagentTranscriptUpdateV1,
  type SubagentTranscriptV1,
} from "../../../renderer/shared/subagent-transcript.js";
import { GenerationTimelineProjector, safeToolIssueDetails } from "../generation-timeline.js";
import { terminalAssistantActivityAnchors, terminalAssistantText } from "../generation-runtime.js";
import { sanitizeSubagentWorkText } from "./subagent-work-text-filter.js";

/** About four live updates a second; the final state is always written. */
export const SUBAGENT_TRANSCRIPT_FLUSH_INTERVAL_MS = 250;
/** How many times the final state is tried before the recorder gives up. */
export const SUBAGENT_TRANSCRIPT_FINAL_SAVE_ATTEMPTS = 3;
/** Repeated failed saves wait up to this many flush intervals between tries. */
const MAX_FAILURE_BACKOFF_STEPS = 20;
/**
 * After this many failed saves in a row the recorder stops retrying on its
 * own; the next change, or the final save, tries again.
 */
export const SUBAGENT_TRANSCRIPT_RETRIES_BEFORE_PAUSE = 5;
const MAX_CACHED_OFFSETS = 256;
const MAX_CACHED_STEP_TEXTS = 2_048;

export type SubagentTranscriptFinishStatus = "completed" | "failed" | "cancelled";

/** Where a message's tool and thinking steps sit in its settled text. */
export type SubagentTranscriptActivityAnchors = NonNullable<
  ReturnType<typeof terminalAssistantActivityAnchors>
>;

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
  /** The parent/helper credential filter; replaceable only in tests. */
  sanitize?: (text: string) => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

interface CachedEntry {
  version: number;
  entry: SubagentTranscriptMessageEntry;
  json: string;
  bytes: number;
}

interface MessageState {
  raw: string;
  /** Null once the size cap replaced the message with its marker. */
  projector: GenerationTimelineProjector | null;
  startedAt: number;
  finishedAt?: number;
  /** The helper has settled this message's text (message_end). */
  textSettled: boolean;
  /** Display text cache, valid while the visible raw text is unchanged. */
  safeFor?: string;
  safe: string;
  /** Raw offset -> display offset, valid while the raw prefix is unchanged. */
  offsets: Map<number, number>;
  /** Bumped on every change that can alter this message's entry. */
  version: number;
  cache?: CachedEntry;
  /** Steps the size cap removed. They stay out of every later save. */
  droppedSteps: Set<string>;
  /** Display characters the size cap removed from the front of the text. */
  droppedChars: number;
  /** Set once the size cap replaced the whole message with its marker. */
  frozen?: SubagentTranscriptMessageEntry;
}

/**
 * Records one helper's conversation as it happens: the task, then each
 * message the helper writes with its tool and thinking steps. Updates are
 * batched to about four a second, with one save in flight at a time; each
 * batch is saved first and streamed only once the save succeeded, so a reader
 * that joins late can always meet the stream from the saved copy. Text and
 * step labels go through the parent/helper credential filter, which hides
 * secrets but keeps file paths readable.
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
  private readonly taskEntry: SubagentTranscriptEntry;
  private readonly taskJson: string;
  private readonly taskBytes: number;
  private readonly messages: MessageState[] = [];
  private readonly stepTexts = new Map<string, string>();
  private current: MessageState | null = null;
  private publishedJson: string[] = [];
  private lastTrimmed = false;
  private revision = 0;
  private trimmed = false;
  private dirty = true;
  private finished = false;
  private failures = 0;
  /** Retries paused after repeated failures, until something changes. */
  private paused = false;
  /** Whether the error of the current run of failures has been reported. */
  private failureReported = false;
  /** The run is being stopped: tools that end from now on were cancelled. */
  private cancelRequested = false;
  /** Calls a permission or policy check refused before they ran. */
  private readonly blockedTools = new Set<string>();
  private timer: unknown = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private flushing: Promise<void> | null = null;
  private finishing: Promise<void> | null = null;

  constructor(options: SubagentTranscriptRecorderOptions) {
    this.runId = options.runId;
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? SUBAGENT_TRANSCRIPT_FLUSH_INTERVAL_MS;
    this.maxBytes = options.maxBytes ?? MAX_SUBAGENT_TRANSCRIPT_BYTES;
    this.sanitize = options.sanitize ?? sanitizeSubagentWorkText;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? (() => {});
    this.taskEntry = { kind: "task", text: clip(this.sanitize(options.task)) };
    this.taskJson = JSON.stringify(this.taskEntry);
    this.taskBytes = subagentTranscriptEntryBytes(this.taskEntry);
    // Revision 1 holds the task alone: the snapshot is taken here, before any
    // event can arrive, and saved straight away.
    void this.runFlush(false);
  }

  /** Feed one Pi agent event from the helper, mapped as the main chat maps it. Never throws. */
  observe(event: AgentEvent): void {
    try {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") this.messageStarted();
          return;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") this.textDelta(update.delta);
          else if (update.type === "thinking_start") this.thinkingStarted();
          else if (update.type === "thinking_end") this.thinkingEnded();
          else if (update.type === "toolcall_start") {
            // Arguments can stream for a while before the tool runs; show the
            // call as pending now, as the main chat does. Some providers send
            // an empty id first, so wait for a usable one.
            const block = update.partial.content[update.contentIndex];
            if (
              block?.type === "toolCall" &&
              typeof block.id === "string" &&
              block.id &&
              typeof block.name === "string"
            ) {
              this.toolCalled(block.id, block.name);
            }
          }
          return;
        }
        case "message_end":
          if (event.message.role === "assistant") {
            this.messageEnded(
              terminalAssistantText(event.message),
              terminalAssistantActivityAnchors(event.message) ?? undefined,
            );
          }
          return;
        case "tool_execution_start":
          this.toolStarted(event.toolCallId, event.toolName, event.args);
          return;
        case "tool_execution_update":
          this.toolRunning(event.toolCallId);
          return;
        case "tool_execution_end": {
          // The main chat's order: a stop wins, then a refusal, then the error flag.
          const blocked = this.blockedTools.delete(event.toolCallId);
          const status = this.cancelRequested
            ? "cancelled"
            : blocked
              ? "blocked"
              : event.isError
                ? "failed"
                : "completed";
          this.toolFinished(
            event.toolCallId,
            status,
            status === "completed"
              ? event.result?.details
              : safeToolIssueDetails(event.toolName, status, event.result),
          );
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this.onError(error);
    }
  }

  /** The helper is being stopped; a tool that ends from here on shows as cancelled. */
  cancelling(): void {
    this.cancelRequested = true;
  }

  /** A permission or policy check refused this call; its end shows as blocked. */
  toolBlocked(toolCallId: string): void {
    if (!this.finished) this.blockedTools.add(toolCallId);
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
      textSettled: false,
      safe: "",
      offsets: new Map(),
      version: 0,
      droppedSteps: new Set(),
      droppedChars: 0,
    };
    this.messages.push(message);
    this.current = message;
    this.changed(message);
  }

  textDelta(delta: string): void {
    const message = this.active();
    if (!message?.projector || !delta) return;
    message.raw += delta;
    message.projector.setContentOffset(message.raw.length);
    this.changed(message);
  }

  thinkingStarted(): void {
    const message = this.active();
    if (!message?.projector) return;
    message.projector.setContentOffset(message.raw.length);
    message.projector.thinkingStarted();
    this.changed(message);
  }

  thinkingEnded(): void {
    const message = this.active();
    if (!message?.projector) return;
    message.projector.thinkingEnded();
    this.changed(message);
  }

  /**
   * The helper's settled text for this message replaces what streamed, and
   * its steps move to where the settled text places them.
   */
  messageEnded(text?: string, anchors?: SubagentTranscriptActivityAnchors): void {
    const message = this.active();
    if (!message?.projector) return;
    message.projector.thinkingEnded();
    if (typeof text === "string") {
      message.projector.reconcileContentOffset(
        0,
        message.raw,
        text,
        anchors ? { stepStart: 0, textStart: 0, ...anchors } : undefined,
      );
      if (!text.startsWith(message.raw)) message.offsets.clear();
      message.raw = text;
    }
    message.textSettled = true;
    this.changed(message);
  }

  /** The model asked for a tool; its arguments may still be arriving. */
  toolCalled(toolCallId: string, toolName: string): void {
    const message = this.active(true);
    if (!message?.projector) return;
    message.projector.setContentOffset(message.raw.length);
    message.projector.toolStarted(toolCallId, toolName, {});
    this.changed(message);
  }

  /** Tools run after the message that asked for them, so they join it. */
  toolStarted(toolCallId: string, toolName: string, args: unknown): void {
    const message = this.messageForTool(toolCallId) ?? this.active(true);
    if (!message?.projector || this.finished) return;
    if (message.projector.publicToolCallId(toolCallId) === undefined) {
      message.projector.setContentOffset(message.raw.length);
    }
    message.projector.toolStarted(toolCallId, toolName, args);
    message.projector.toolRunning(toolCallId);
    this.changed(message);
  }

  toolRunning(toolCallId: string): void {
    const message = this.messageForTool(toolCallId);
    if (!message?.projector) return;
    message.projector.toolRunning(toolCallId);
    this.changed(message);
  }

  /** `details` is the tool result's own details, or safe issue details for any other outcome. */
  toolFinished(
    toolCallId: string,
    status: "completed" | "failed" | "blocked" | "cancelled",
    details?: unknown,
  ): void {
    const message = this.messageForTool(toolCallId);
    if (!message?.projector) return;
    message.projector.toolFinished(toolCallId, status, details);
    this.changed(message);
  }

  /**
   * Close the last message, write the final state and stream it. Resolves
   * once the final state is written or its tries are used up; later events
   * are ignored. Calling it again returns the same settlement.
   */
  finish(status: SubagentTranscriptFinishStatus): Promise<void> {
    if (!this.finishing) {
      this.closeCurrent(status);
      for (const message of this.messages) {
        if (!message.projector) continue;
        message.projector.finish(status);
        message.version += 1;
      }
      this.finished = true;
      this.dirty = true;
      if (this.timer !== null) {
        this.clearTimer(this.timer);
        this.timer = null;
      }
      this.finishing = this.finalFlush();
    }
    return this.finishing;
  }

  private async finalFlush(): Promise<void> {
    while (this.flushing) await this.flushing;
    // A failed final save is always reported once, even when an earlier run
    // of failed saves was already reported.
    this.failureReported = false;
    for (
      let attempt = 0;
      attempt < SUBAGENT_TRANSCRIPT_FINAL_SAVE_ATTEMPTS && this.dirty;
      attempt += 1
    ) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => {
          // The wait is bounded by flush(); it never holds the process open.
          const handle = this.setTimer(resolve, this.intervalMs * attempt) as {
            unref?: () => void;
          } | null;
          if (typeof handle?.unref === "function") handle.unref();
        });
      }
      await this.runFlush(true);
    }
  }

  private active(create = false): MessageState | null {
    if (this.finished) return null;
    if (!this.current && create) this.messageStarted();
    return this.current;
  }

  private messageForTool(toolCallId: string): MessageState | null {
    if (this.finished) return null;
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]!;
      if (message.projector?.publicToolCallId(toolCallId) !== undefined) return message;
    }
    return null;
  }

  private closeCurrent(status: SubagentTranscriptFinishStatus): void {
    const message = this.current;
    if (!message) return;
    message.projector?.finish(status);
    message.finishedAt = this.now();
    message.textSettled = true;
    message.version += 1;
    this.current = null;
  }

  private changed(message?: MessageState): void {
    if (message) message.version += 1;
    this.dirty = true;
    this.paused = false;
    this.schedule();
  }

  /** Arm the next flush, unless one is armed, running, or the run finished. */
  private schedule(): void {
    if (this.finished || this.paused || this.timer !== null || this.flushing || !this.dirty) return;
    const interval = this.intervalMs * Math.min(MAX_FAILURE_BACKOFF_STEPS, 2 ** this.failures);
    const wait = Math.max(0, this.lastFlushAt + interval - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runFlush(false);
    }, wait);
  }

  private runFlush(final: boolean): Promise<void> {
    const run = this.flush(final).catch((error: unknown) => this.onError(error));
    this.flushing = run;
    return run.finally(() => {
      if (this.flushing === run) this.flushing = null;
      this.schedule();
    });
  }

  private async flush(final: boolean): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlushAt = this.now();
    const cached = this.messages.map((message) => this.cachedEntry(message));
    const untrimmed: SubagentTranscriptV1 = {
      version: SUBAGENT_TRANSCRIPT_VERSION,
      runId: this.runId,
      revision: this.revision + 1,
      trimmed: this.trimmed,
      entries: [this.taskEntry, ...cached.map((entry) => entry.entry)],
    };
    const transcript = trimSubagentTranscriptToBytes(untrimmed, this.maxBytes, [
      this.taskBytes,
      ...cached.map((entry) => entry.bytes),
    ]);
    if (transcript !== untrimmed) {
      this.trimmed = true;
      this.keepTrim(untrimmed.entries, transcript.entries);
    }
    const json = transcript.entries.map((entry, index) =>
      index === 0
        ? this.taskJson
        : entry === untrimmed.entries[index]
          ? cached[index - 1]!.json
          : JSON.stringify(entry),
    );
    const changes: SubagentTranscriptChange[] = [];
    for (const [index, entry] of transcript.entries.entries()) {
      if (json[index] !== this.publishedJson[index]) changes.push({ index, entry });
    }
    if (
      this.revision > 0 &&
      !final &&
      changes.length === 0 &&
      transcript.entries.length === this.publishedJson.length &&
      transcript.trimmed === this.lastTrimmed
    ) {
      return;
    }
    try {
      await this.sink.persist(transcript, final);
    } catch (error) {
      // Nothing is streamed past what is saved: the change stays pending and
      // the next flush tries again with the same base revision. A run of
      // failures is reported once, and a store that keeps failing (a full
      // disk, a denied folder) is left alone until something changes.
      this.failures += 1;
      this.dirty = true;
      if (this.failures >= SUBAGENT_TRANSCRIPT_RETRIES_BEFORE_PAUSE) this.paused = true;
      if (!this.failureReported) {
        this.failureReported = true;
        this.onError(error);
      }
      return;
    }
    this.failures = 0;
    this.failureReported = false;
    this.paused = false;
    const baseRevision = this.revision;
    this.revision = transcript.revision;
    this.publishedJson = json;
    this.lastTrimmed = transcript.trimmed;
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

  /**
   * Carry what the size cap removed into the recorder's own state, so it
   * stays removed and is not measured again: dropped steps are remembered by
   * id, a cut front of the newest text by length, and a closed message that
   * became a marker gives up its text and steps.
   */
  private keepTrim(
    before: readonly SubagentTranscriptEntry[],
    after: readonly SubagentTranscriptEntry[],
  ): void {
    for (const [offset, message] of this.messages.entries()) {
      const previous = before[offset + 1];
      const next = after[offset + 1];
      if (
        !previous ||
        !next ||
        previous === next ||
        previous.kind !== "message" ||
        next.kind !== "message"
      )
        continue;
      if (next.text === SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_MARKER && message !== this.current) {
        message.frozen = next;
        message.projector = null;
        message.raw = "";
        message.safe = "";
        message.safeFor = undefined;
        message.offsets.clear();
        message.cache = undefined;
        continue;
      }
      const kept = new Set(next.steps.map((step) => step.id));
      for (const step of previous.steps) if (!kept.has(step.id)) message.droppedSteps.add(step.id);
      const cut = trimmedTextBody(previous.text).length - trimmedTextBody(next.text).length;
      if (cut > 0) message.droppedChars += cut;
      message.version += 1;
    }
  }

  private cachedEntry(message: MessageState): CachedEntry {
    if (message.frozen) {
      if (!message.cache) {
        const json = JSON.stringify(message.frozen);
        message.cache = {
          version: message.version,
          entry: message.frozen,
          json,
          bytes: utf8Bytes(json),
        };
      }
      return message.cache;
    }
    if (message.cache?.version === message.version) return message.cache;
    const entry = this.entry(message);
    const json = JSON.stringify(entry);
    message.cache = { version: message.version, entry, json, bytes: utf8Bytes(json) };
    return message.cache;
  }

  private entry(message: MessageState): SubagentTranscriptMessageEntry {
    // While text streams, the unfinished last word and an open key block wait
    // for the next update, so a secret is never shown before it can be seen whole.
    const visible = message.textSettled ? message.raw : streamingVisibleText(message.raw);
    if (message.safeFor !== visible) {
      message.safe = clip(this.sanitize(visible));
      message.safeFor = visible;
    }
    const cut = Math.min(message.droppedChars, message.safe.length);
    const text =
      cut > 0
        ? `${SUBAGENT_TRANSCRIPT_TRIMMED_TEXT_PREFIX}${message.safe.slice(cut)}`
        : message.safe;
    let floor = 0;
    let order = 0;
    const steps: AgentStep[] = [];
    for (const step of message.projector!.snapshot().steps) {
      if (message.droppedSteps.has(step.id)) continue;
      const display = this.displayOffset(message, visible, step.contentOffset ?? 0);
      const placed = cut > 0 ? trimmedStepOffset(display, cut) : display;
      const mapped = Math.max(floor, Math.min(text.length, placed));
      floor = mapped;
      steps.push(this.safeStep({ ...step, order, contentOffset: mapped } as AgentStep));
      order += 1;
    }
    return {
      kind: "message",
      text,
      steps,
      startedAt: message.startedAt,
      ...(message.finishedAt === undefined
        ? {}
        : { finishedAt: Math.max(message.startedAt, message.finishedAt) }),
    };
  }

  /** Tool labels, targets and details can quote a command or search with a secret in it. */
  private safeStep(step: AgentStep): AgentStep {
    if (step.kind !== "tool") return step;
    const label = this.safeStepText(step.label) || step.label;
    const target = step.target === undefined ? undefined : this.safeStepText(step.target);
    const detail = step.detail === undefined ? undefined : this.safeStepText(step.detail);
    const { target: _target, detail: _detail, ...rest } = step;
    return {
      ...rest,
      label,
      ...(target ? { target } : {}),
      ...(detail ? { detail } : {}),
    } as AgentStep;
  }

  private safeStepText(value: string): string {
    const cached = this.stepTexts.get(value);
    if (cached !== undefined) return cached;
    if (this.stepTexts.size >= MAX_CACHED_STEP_TEXTS) this.stepTexts.clear();
    const safe = this.sanitize(value);
    this.stepTexts.set(value, safe);
    return safe;
  }

  /** Where a raw text position lands once the visible text is filtered for display. */
  private displayOffset(message: MessageState, visible: string, rawOffset: number): number {
    const offset = Math.max(0, Math.min(rawOffset, visible.length));
    if (offset === 0) return 0;
    if (offset === visible.length) return message.safe.length;
    const cached = message.offsets.get(offset);
    if (cached !== undefined) return cached;
    if (message.offsets.size >= MAX_CACHED_OFFSETS) message.offsets.clear();
    const mapped = this.sanitize(visible.slice(0, offset)).length;
    message.offsets.set(offset, mapped);
    return mapped;
  }
}

const OPEN_BLOCK = /-----BEGIN /gu;
const CLOSE_BLOCK = /-----END [^\n]*-----/u;

/**
 * The part of still-streaming text that is safe to show: it stops before a
 * `-----BEGIN` block that has not closed yet, and before an unfinished last
 * word, which could be the first half of a key.
 */
export function streamingVisibleText(raw: string): string {
  let end = raw.length;
  let lastOpen = -1;
  for (const match of raw.matchAll(OPEN_BLOCK)) lastOpen = match.index ?? lastOpen;
  if (lastOpen >= 0 && !CLOSE_BLOCK.test(raw.slice(lastOpen))) end = lastOpen;
  // A trailing `-----BEGIN` may itself be arriving a few characters at a time.
  const dashes = /-{1,5}(?:B(?:E(?:G(?:I(?:N)?)?)?)?)?$/u.exec(raw.slice(0, end));
  if (dashes) end = dashes.index;
  const text = raw.slice(0, end);
  if (end === raw.length && /\s$/u.test(text)) return text;
  const lastSpace = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"));
  return end === raw.length ? text.slice(0, lastSpace + 1) : text;
}

function clip(text: string): string {
  return text.length > MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS
    ? text.slice(0, MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS)
    : text;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
