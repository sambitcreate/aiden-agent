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
import type { EntryRecord, SubmissionRecord, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

export type DurableTool = ToolRegistration;
export type ToolReplay = "safe" | "unsafe";
export type BotEffectAdmission<T> = { admitted: false } | { admitted: true; started: Promise<T> };

/** What a per-call tool may use of the conversation it runs in. */
export interface BotToolCall {
  /** Host-owned durable tool identity, used to end replay receipts after settlement. */
  readonly taskId?: string;
  assertRunActive?(): Promise<void>;
  /** Called by the authority fence with the actual effect, after its awaited checks. */
  admitEffect?<T>(start: () => Promise<T>): Promise<BotEffectAdmission<T>>;
  /** A stale plan permit asks/blocks under ordinary policy, without reserving another plan. */
  reauthorize?(): Promise<void>;
  readonly callId: string;
  readonly signal: AbortSignal;
  /** Committed entries of the calling conversation, newest first (the store's default scan order). */
  entries(): Promise<EntryRecord[]>;
  /** Committed submissions of the calling conversation by request id, in order (undefined when none). */
  submissions(requestIds: readonly string[]): Promise<Array<SubmissionRecord | undefined>>;
  /** Append a display/bookkeeping entry to the calling conversation. */
  appendEntry(kind: string, data: JsonValue): Promise<void>;
  /** Atomic metadata write using this task's conversation, without reopening a host or scheduling input. */
  appendEntryOnce?(requestId:string,kind:string,data:JsonValue):Promise<void>;
  /**
   * The tool task's memo: the first `candidate` for `name` is stored and
   * returned on every later call of the same task, including after a restart.
   */
  memo<T extends JsonValue>(name: string, candidate: T): Promise<T>;
  readMemo?<T extends JsonValue>(name: string): Promise<T | undefined>;
  /** Stable host identities for plan/grant binding; raw ingress remains separate. */
  runInputIds?(): Promise<readonly string[]>;
  /**
   * Request ids of the inputs the calling run serves (one per input; `undefined` for one without),
   * when the registry reads them. Preparation may precede this run, so a tool that acts
   * differently on routine or Telegram runs asks here.
   */
  runRequestIds?(): Promise<readonly (string | undefined)[]>;
}

export interface AdaptOptions {
  assertRunActive?(api: ToolExecutionApi, context: Context): Promise<void>;
  prepareExecution?(api: ToolExecutionApi, context: Context, args: unknown): Promise<void>;
  admitEffect?<T>(api: ToolExecutionApi, context: Context, args: unknown, start: () => Promise<T>): Promise<BotEffectAdmission<T>>;
  reauthorize?(api: ToolExecutionApi, context: Context, args: unknown): Promise<void>;
  settled?(api: ToolExecutionApi): void;
  replay: ToolReplay;
  /** Build the tool for one call. `tool` still supplies the name, schema and description. */
  bind?: (call: BotToolCall) => AgentTool;
  /** Reads the calling run's request ids, for `BotToolCall.runRequestIds`. */
  runRequestIds?(api: ToolExecutionApi, context: Context): Promise<readonly (string | undefined)[]>;
  runInputIds?(api: ToolExecutionApi, context: Context): Promise<readonly string[]>;
}

const ENTRY_PAGE = 500;

function callApi(api: ToolExecutionApi, context: Context, signal: AbortSignal, opts: AdaptOptions, args: unknown): BotToolCall {
  const runRequestIds = opts.runRequestIds;
  return {
    ...(opts.assertRunActive ? {assertRunActive: () => opts.assertRunActive!(api, context)} : {}),
    ...(opts.admitEffect ? { admitEffect: <T>(start: () => Promise<T>) => opts.admitEffect!(api, context, args, start) } : {}),
    ...(opts.reauthorize ? { reauthorize: () => opts.reauthorize!(api, context, args) } : {}),
    ...(runRequestIds === undefined ? {} : { runRequestIds: () => runRequestIds(api, context) }),
    ...(opts.runInputIds ? { runInputIds: () => opts.runInputIds!(api, context) } : {}),
    readMemo: <T extends JsonValue>(name: string) => api.memo<T>(name, context),
    callId: api.callId,
    taskId: String(api.taskId),
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
    submissions: (requestIds) =>
      api.commit((tx) => Promise.all(requestIds.map((requestId) => tx.submissionByRequest(api.conversationId, requestId))), context),
    appendEntry: async (kind, data) => {
      await api.commit((tx) => tx.appendEntry(api.conversationId, { kind, data }), context);
    },
    appendEntryOnce: async (requestId,kind,data) => {await api.commit(async tx=>{if(await tx.submissionByRequest(api.conversationId,requestId))return;const submission=await tx.createSubmission({conversationId:api.conversationId,requestId,type:"write",status:"queued"}),entry=await tx.appendEntry(api.conversationId,{kind,data});await tx.placeSubmission(submission.id,entry.id);},context);},
    memo: (name, candidate) => api.memo(name, candidate, context),
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
        await opts.prepareExecution?.(api, context, args);
        const target = opts.bind ? opts.bind(callApi(api, context, signal, opts, args)) : tool;
        await opts.assertRunActive?.(api, context);
        const result = await target.execute(api.callId, args, signal, createUpdateForwarder(api, context));
        const details = toJson(result.details);
        return {
          output: result.content,
          ...(details === undefined ? {} : { details }),
          ...(result.isError ? { isError: true } : {}),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.terminate ? { control: { terminate: true } } : {}),
        };
      } finally {
        opts.settled?.(api);
        dispose();
      }
    },
  };
  return registration;
}
