// Adapts Aiden's pi-agent-core `AgentTool`s into Pi Durable tool
// registrations, so Bots reuse the existing tool implementations (TypeBox
// schemas, Bot authority wrappers) unchanged.
//
// - Arguments: the harness validates them against the same TypeBox schema
//   before `execute()`; `prepareArguments` is passed through.
// - Cancellation: the chord context's abort signal is mapped onto the
//   `AbortSignal` the Aiden tool receives.
// - Progress: `onUpdate` snapshots become appended `api.output()` chunks and
//   `api.details()` values.
// - Replay: declared per adaptation. Only read-only or idempotent tools may be
//   `safe`; an interrupted `unsafe` call becomes an `interrupted` error result.
// - Call binding: a tool that needs the conversation (to read attachment
//   snapshots or append entries) is built per call by `bind`, so nothing it
//   depends on lives in a closure that a restart would lose.

import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { EntryRecord, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

export type DurableTool = ToolRegistration;
export type ToolReplay = "safe" | "unsafe";

/** What a per-call tool may use of the conversation it runs in. */
export interface BotToolCall {
  readonly callId: string;
  readonly signal: AbortSignal;
  /** Committed entries of the calling conversation, oldest first. */
  entries(): Promise<EntryRecord[]>;
  /** Append a display/bookkeeping entry to the calling conversation. */
  appendEntry(kind: string, data: JsonValue): Promise<void>;
}

export interface AdaptOptions {
  replay: ToolReplay;
  /** Build the tool for one call. `tool` still supplies the name, schema and description. */
  bind?: (call: BotToolCall) => AgentTool;
}

const ENTRY_PAGE = 500;

function callApi(api: ToolExecutionApi, context: Context, signal: AbortSignal): BotToolCall {
  return {
    callId: api.callId,
    signal,
    entries: () =>
      api.commit(async (tx) => {
        const entries: EntryRecord[] = [];
        let cursor: Parameters<typeof tx.scanEntries>[2];
        do {
          const page = await tx.scanEntries({ conversationId: api.conversationId }, ENTRY_PAGE, cursor);
          entries.push(...page.items);
          cursor = page.next;
        } while (cursor !== undefined);
        return entries;
      }, context),
    appendEntry: async (kind, data) => {
      await api.commit((tx) => tx.appendEntry(api.conversationId, { kind, data }), context);
    },
  };
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Plain JSON copy of `value`, or `undefined` when it cannot be represented. */
function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : (JSON.parse(serialized) as JsonValue);
  } catch {
    return undefined;
  }
}

/** A signal that aborts when the chord context is cancelled. */
function linkedSignal(context: Context): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const parent = context.abortSignal;
  if (parent === undefined) return { signal: controller.signal, dispose: () => undefined };
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return { signal: controller.signal, dispose: () => parent.removeEventListener("abort", onAbort) };
}

/**
 * Forward `onUpdate` snapshots as appended output. Aiden tools report the
 * whole partial result each time, so only the new suffix is appended; a
 * snapshot that does not extend the previous one starts a new line.
 */
function createUpdateForwarder(api: ToolExecutionApi, context: Context) {
  let shown = "";
  return (partial: AgentToolResult<unknown>) => {
    const text = textOf(partial);
    if (text.length > 0 && text !== shown) {
      if (text.startsWith(shown)) {
        api.output(text.slice(shown.length));
      } else {
        api.output(shown.length > 0 ? `\n${text}` : text);
      }
      shown = text;
    }
    const details = toJson(partial.details);
    if (details !== undefined) void api.details(details, context).catch(() => undefined);
  };
}

export function adaptAidenTool(tool: AgentTool, opts: AdaptOptions): DurableTool {
  const registration: DurableTool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: opts.replay,
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    ...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const { signal, dispose } = linkedSignal(context);
      try {
        const target = opts.bind ? opts.bind(callApi(api, context, signal)) : tool;
        const result = await target.execute(api.callId, args, signal, createUpdateForwarder(api, context));
        const details = toJson(result.details);
        return {
          content: result.content,
          ...(details === undefined ? {} : { details }),
          ...(result.isError ? { isError: true } : {}),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.terminate ? { control: { terminate: true } } : {}),
        };
      } finally {
        dispose();
      }
    },
  };
  return registration;
}
