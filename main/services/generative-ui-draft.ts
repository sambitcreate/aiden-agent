import type { ChatArtifactEventV1 } from "../../renderer/shared/chat-artifacts.js";
import {
  GENERATIVE_UI_DRAFT_THROTTLE_MS,
  RENDER_ARTIFACT_TOOL_NAME,
  isHtmlArtifactTitle,
} from "../../renderer/shared/generative-ui.js";
import { isGenerativeUiDraftAcceptable } from "./generative-ui-html.js";
import { openGenerativeUiDraftStream } from "./generative-ui-preview-store.js";

/**
 * Turns successive partially parsed `render_artifact` arguments into stream
 * operations: open a draft once HTML appears, append only the new suffix, and
 * restart if the model's HTML stops being a prefix of what was sent.
 */
export type DraftAction =
  | { kind: "open"; toolCallId: string; title?: string }
  | { kind: "append"; toolCallId: string; chunk: string }
  | { kind: "restart"; toolCallId: string; title?: string };

export function createGenerativeUiDraftTracker() {
  const sentByCall = new Map<string, string>();
  return {
    update(toolCallId: string, args: unknown): DraftAction | undefined {
      if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
      const record = args as Record<string, unknown>;
      if (typeof record.path === "string" || typeof record.html !== "string" || !record.html) {
        return undefined;
      }
      const title = typeof record.title === "string" ? record.title : undefined;
      const html = record.html;
      const sent = sentByCall.get(toolCallId);
      if (sent === undefined) {
        sentByCall.set(toolCallId, "");
        return { kind: "open", toolCallId, title };
      }
      if (!html.startsWith(sent)) {
        sentByCall.set(toolCallId, "");
        return { kind: "restart", toolCallId, title };
      }
      const chunk = html.slice(sent.length);
      if (!chunk) return undefined;
      sentByCall.set(toolCallId, html);
      return { kind: "append", toolCallId, chunk };
    },
    end(toolCallId: string): void {
      sentByCall.delete(toolCallId);
    },
  };
}

export const isDraftHtmlAcceptable = isGenerativeUiDraftAcceptable;

export interface DraftStreamHandle {
  src: string;
  append(chunk: string): void;
  close(): void;
}

export interface GenerativeUiDraftSessionOptions {
  /** False when render_artifact is not registered this turn: every call is a no-op. */
  enabled?: boolean;
  /** Pi's raw tool-call id → the timeline's public `call-N` id. */
  publicToolCallId: (rawToolCallId: string) => string | undefined;
  send: (event: ChatArtifactEventV1) => void;
  open?: (title: string) => DraftStreamHandle;
  schedule?: (run: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  throttleMs?: number;
}

interface DraftCall {
  latestArgs?: unknown;
  timer?: unknown;
  stream?: DraftStreamHandle;
  publicId?: string;
  /** The draft event last announced for the open stream, re-sent when layout changes. */
  label?: string;
  wide: boolean;
  /** Accumulated HTML already admitted, for prefix admission checks. */
  admitted: string;
  stopped: boolean;
}

/**
 * Streams one generation's in-flight `render_artifact` calls to draft
 * previews. Deltas are coalesced per call; `end` finishes a call's document
 * and leaves the draft showing until the presented artifact replaces it;
 * `cancel`/`dispose` retract drafts that will never be presented.
 */
function requestsWide(args: unknown): boolean {
  return Boolean(args && typeof args === "object" && (args as { layout?: unknown }).layout === "wide");
}

export function createGenerativeUiDraftSession(options: GenerativeUiDraftSessionOptions) {
  const open = options.open ?? ((title: string) => openGenerativeUiDraftStream(title, undefined));
  const schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  const cancelScheduled =
    options.cancelScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const throttleMs = options.throttleMs ?? GENERATIVE_UI_DRAFT_THROTTLE_MS;
  const tracker = createGenerativeUiDraftTracker();
  const calls = new Map<string, DraftCall>();

  const stop = (rawToolCallId: string, call: DraftCall, retract: boolean) => {
    if (call.timer !== undefined) cancelScheduled(call.timer);
    call.timer = undefined;
    call.stream?.close();
    call.stopped = true;
    tracker.end(rawToolCallId);
    if (retract && call.publicId) {
      options.send({ version: 1, operation: "draft_end", toolCallId: call.publicId });
    }
  };

  const announce = (call: DraftCall) => {
    if (!call.stream) return;
    options.send({
      version: 1,
      operation: "draft",
      toolCallId: call.publicId!,
      ...(call.label ? { title: call.label } : {}),
      src: call.stream.src,
      ...(call.wide ? { layout: "wide" as const } : {}),
    });
  };

  const openStream = (call: DraftCall, title: string | undefined) => {
    call.stream?.close();
    call.admitted = "";
    call.label = title && isHtmlArtifactTitle(title) ? title : undefined;
    call.stream = open(call.label ?? "Visualizing");
    call.wide = requestsWide(call.latestArgs);
    announce(call);
  };

  /** The layout can stream in after the HTML has started; the open draft follows it. */
  const followLayout = (call: DraftCall) => {
    const wide = requestsWide(call.latestArgs);
    if (!call.stream || wide === call.wide) return;
    call.wide = wide;
    announce(call);
  };

  const apply = (rawToolCallId: string) => {
    const call = calls.get(rawToolCallId);
    if (!call || call.stopped) return;
    call.timer = undefined;
    call.publicId ??= options.publicToolCallId(rawToolCallId);
    if (!call.publicId) return;
    // Opening (or restarting) yields no chunk; ask again for the first append.
    for (let step = 0; step < 2; step += 1) {
      const action = tracker.update(rawToolCallId, call.latestArgs);
      if (!action) {
        followLayout(call);
        return;
      }
      if (action.kind === "open" || action.kind === "restart") {
        openStream(call, action.title);
        continue;
      }
      const next = call.admitted + action.chunk;
      if (!isGenerativeUiDraftAcceptable(next)) {
        stop(rawToolCallId, call, true);
        return;
      }
      call.admitted = next;
      call.stream?.append(action.chunk);
      followLayout(call);
      return;
    }
  };

  return {
    delta(rawToolCallId: string, toolName: string, args: unknown): void {
      if (options.enabled === false || toolName !== RENDER_ARTIFACT_TOOL_NAME) return;
      let call = calls.get(rawToolCallId);
      if (!call) {
        call = { admitted: "", stopped: false, wide: false };
        calls.set(rawToolCallId, call);
      }
      if (call.stopped) return;
      call.latestArgs = args;
      if (call.timer === undefined) {
        call.timer = schedule(() => apply(rawToolCallId), throttleMs);
      }
    },
    /** Arguments are complete: write the rest and finish the document. */
    end(rawToolCallId: string): void {
      const call = calls.get(rawToolCallId);
      if (!call || call.stopped) return;
      if (call.timer !== undefined) cancelScheduled(call.timer);
      apply(rawToolCallId);
      stop(rawToolCallId, call, false);
    },
    /** The call will not present an artifact (error or abort): retract its draft. */
    cancel(rawToolCallId: string): void {
      const call = calls.get(rawToolCallId);
      if (!call) return;
      stop(rawToolCallId, call, true);
      calls.delete(rawToolCallId);
    },
    dispose(): void {
      for (const [rawToolCallId, call] of calls) stop(rawToolCallId, call, true);
      calls.clear();
    },
  };
}
