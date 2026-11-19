/**
 * Side calls on the parent's cached prefix, and the one helper every one-off
 * call uses so it never writes a cache nobody reads.
 *
 * A side call (btw, the same-model advisor) is sent as a continuation of the
 * chat's last foreground request: the same model, tools, system, message
 * prefix, `tool_choice` and reasoning, with the parent's reply and the side
 * call's own instruction appended. The provider then reads the prefix the
 * parent already cached instead of writing a new one.
 *
 * The ledger keeps only the latest request per chat, in memory: a shallow copy
 * of its message list with tools reduced to their declarations, the
 * replayable options and a hash of the model. It never keeps credentials,
 * headers or tool implementations, never logs content and never persists
 * anything. A prefix that states memory facts is handed out only while every
 * one of them is still approved, so a fact the person removed or turned off
 * is never sent again through a side call. Its caller sends the continuation
 * with the side call's own credentials and signal, and never executes a tool
 * call in the reply.
 */
import { createHash } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  CacheRetention,
  Message,
  Model,
  ModelsSimpleStreamOptions,
  SimpleStreamOptions,
  Tool,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { memoryLines } from "./chat-frozen-state.js";
import { promptCacheTtlMs } from "./prompt-cache-lifetimes.js";

/**
 * Options for a call that runs once. Its prompt is never sent again, so a
 * cache write would only cost more; every one-off call goes through here.
 */
export function oneOffCallOptions<T extends object>(options: T): Omit<T, "cacheRetention"> & { cacheRetention: "none" } {
  return { ...options, cacheRetention: "none" };
}

/** Request fields that shape the cached prefix and are safe to replay. */
export type SideCallReplayOptions = Pick<
  SimpleStreamOptions,
  "sessionId" | "reasoning" | "thinkingBudgets" | "cacheRetention" | "temperature" | "transport" | "toolChoice"
>;

/** The chat's last completed foreground request, read by a side call. */
export interface SideCallPrefix {
  /** The conversation id the parent's runtime was resolved with (the chat id). */
  readonly conversationId: string;
  /** Hash of the model's endpoint and configuration; see `sideCallModelKey`. */
  readonly modelKey: string;
  readonly provider: string;
  readonly modelId: string;
  /** The parent's request context, with a copied message list. */
  readonly context: TranscriptContext;
  readonly options: SideCallReplayOptions;
  readonly requestStartedAt: number;
  /** When the provider's documented short-retention cache would lapse. */
  readonly expiresAt: number;
  /** The parent's reply to that request. */
  readonly response: AssistantMessage;
  /** Reads the facts the chat may be told now, when the request was recorded with it. */
  readonly approvedMemoryFacts?: ApprovedMemoryFacts;
}

/**
 * Identifies the model a request went to, without keeping its headers. Two
 * runtimes with equal keys render the same request body for the same context.
 */
export function sideCallModelKey(model: Model<Api>): string {
  const { headers: _headers, ...identity } = model as Model<Api> & { headers?: unknown };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/**
 * Reads the memory fact lines the chat may still be told now, rendered as
 * the always-on block renders them. Empty when memory is off.
 */
export type ApprovedMemoryFacts = () => Promise<readonly string[]>;

export interface SideCallPrefixLedger {
  /**
   * Called when a foreground request is dispatched. Returns the callback for
   * its reply. A request that cannot be replayed clears the chat's entry.
   * `approvedMemoryFacts` is how a later side call confirms the memory facts
   * the request states; without it, a request that states one is never
   * handed out.
   */
  begin(
    chatKey: string,
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
    approvedMemoryFacts?: ApprovedMemoryFacts,
  ): (message: AssistantMessage) => void;
  /**
   * The chat's last completed request while its cache is still live and every
   * memory fact it states is still approved.
   */
  latest(chatKey: string): Promise<SideCallPrefix | undefined>;
  forget(chatKey: string): void;
}

interface PendingEntry extends Omit<SideCallPrefix, "response"> {
  response?: AssistantMessage;
  /** The memory fact lines the request states, in system or a user message. */
  memoryFacts: readonly string[];
}

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    const candidate = part as { type?: unknown; text?: unknown } | null;
    return candidate?.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

/**
 * Every memory fact line the request states: in system (its text and
 * sections) and in user messages, where a `<state_update>` names the facts
 * added since the head. Tool results are not scanned; a recall result is the
 * tool's output, not the state phase 3 scrubs.
 */
export function memoryFactLinesIn(context: TranscriptContext): string[] {
  const texts: string[] = [];
  const systemPrompt = (context as { systemPrompt?: unknown }).systemPrompt;
  if (typeof systemPrompt === "string") texts.push(systemPrompt);
  for (const message of context.messages) {
    if (message.role === "system") {
      texts.push(...textsOf(message.content));
      for (const section of Object.values(message.sections ?? {})) if (typeof section === "string") texts.push(section);
    } else if (message.role === "user") {
      texts.push(...textsOf(message.content));
    }
  }
  return [...new Set(texts.flatMap(memoryLines))];
}

/** A tool as the provider renders it: no implementation or runtime state. */
function declaration(tool: Tool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
  };
}

/** The context with its message list copied and every tool reduced to its declaration. */
function declarationsOnly(context: TranscriptContext): TranscriptContext {
  const messages = context.messages.map((message) =>
    message.role === "system" && message.toolsAdded
      ? { ...message, toolsAdded: message.toolsAdded.map(declaration) }
      : message,
  );
  const tools = (context as { tools?: unknown }).tools;
  return {
    ...context,
    messages,
    ...(Array.isArray(tools) ? { tools: (tools as Tool[]).map(declaration) } : {}),
  } as TranscriptContext;
}

async function factsStillApproved(entry: PendingEntry): Promise<boolean> {
  if (entry.memoryFacts.length === 0) return true;
  if (!entry.approvedMemoryFacts) return false;
  try {
    const approved = new Set(await entry.approvedMemoryFacts());
    return entry.memoryFacts.every((line) => approved.has(line));
  } catch {
    // A store that cannot be read confirms nothing.
    return false;
  }
}

/**
 * Whether a request can be replayed faithfully without retaining callbacks,
 * headers or opaque authority. Matches the cache-warming rule.
 */
function replayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
  if (!options) return true;
  return !(
    options.cacheRetention === "none" ||
    options.headers ||
    options.onPayload ||
    (options as ModelsSimpleStreamOptions).transformHeaders ||
    options.samplingParams ||
    options.metadata ||
    options.env ||
    options.deferred ||
    model.samplingParams
  );
}

export function createSideCallPrefixLedger(
  settings: { maxChats?: number; now?: () => number; ttlMs?: (model: Model<Api>, retention?: CacheRetention) => number } = {},
): SideCallPrefixLedger {
  const maxChats = settings.maxChats ?? 8;
  const now = settings.now ?? Date.now;
  const ttlMs = settings.ttlMs ?? promptCacheTtlMs;
  const entries = new Map<string, PendingEntry>();
  const sweep = () => {
    const at = now();
    for (const [key, entry] of entries) if (at >= entry.expiresAt) entries.delete(key);
  };

  return {
    begin(chatKey, model, context, options, approvedMemoryFacts) {
      entries.delete(chatKey);
      sweep();
      // The parent's entry lives as long as the retention it was written with.
      const ttl = ttlMs(model, options?.cacheRetention);
      // Without a documented lifetime there is no way to tell a warm prefix
      // from a cold one, and a cold continuation costs more than the
      // isolated call it replaces.
      if (!Number.isFinite(ttl) || ttl <= 0 || options?.signal?.aborted || !replayable(model, options)) return () => {};
      const requestStartedAt = now();
      const entry: PendingEntry = {
        conversationId: chatKey,
        modelKey: sideCallModelKey(model),
        provider: model.provider,
        modelId: model.id,
        context: declarationsOnly(context),
        memoryFacts: memoryFactLinesIn(context),
        ...(approvedMemoryFacts ? { approvedMemoryFacts } : {}),
        options: {
          sessionId: options?.sessionId,
          reasoning: options?.reasoning,
          thinkingBudgets: options?.thinkingBudgets ? structuredClone(options.thinkingBudgets) : undefined,
          cacheRetention: options?.cacheRetention,
          temperature: options?.temperature,
          transport: options?.transport,
          toolChoice: options?.toolChoice ? structuredClone(options.toolChoice) : undefined,
        },
        requestStartedAt,
        expiresAt: requestStartedAt + ttl,
      };
      entries.set(chatKey, entry);
      while (entries.size > maxChats) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return (message) => {
        if (entries.get(chatKey) !== entry) return;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          entries.delete(chatKey);
          return;
        }
        entry.response = message;
      };
    },
    async latest(chatKey) {
      sweep();
      const entry = entries.get(chatKey);
      if (!entry?.response) return undefined;
      if (!(await factsStillApproved(entry))) {
        // A removed fact never comes back, so neither can this request.
        if (entries.get(chatKey) === entry) entries.delete(chatKey);
        return undefined;
      }
      // The chat may have moved on, or the cache lapsed, during the read.
      if (entries.get(chatKey) !== entry || now() >= entry.expiresAt) return undefined;
      const { memoryFacts: _facts, ...prefix } = entry;
      return prefix as SideCallPrefix;
    },
    forget(chatKey) {
      entries.delete(chatKey);
    },
  };
}

/** Records each foreground request on the ledger as it is dispatched. */
export function withSideCallPrefixLedger(
  streamFn: StreamFn,
  { ledger, chatKey, approvedMemoryFacts }: {
    ledger: SideCallPrefixLedger;
    chatKey: string;
    approvedMemoryFacts?: ApprovedMemoryFacts;
  },
): StreamFn {
  return async (model, context, options) => {
    let finished: (message: AssistantMessage) => void = () => {};
    try {
      finished = ledger.begin(chatKey, model, context, options, approvedMemoryFacts);
    } catch {
      ledger.forget(chatKey);
    }
    try {
      const stream = await streamFn(model, context, options);
      void stream.result().then(finished).catch(() => ledger.forget(chatKey));
      return stream;
    } catch (error) {
      ledger.forget(chatKey);
      throw error;
    }
  };
}

/** One ledger per process, for the desktop's foreground chats. */
export const chatSideCallPrefixes: SideCallPrefixLedger = createSideCallPrefixLedger();

export interface SideCallContinuationOptions {
  signal?: AbortSignal;
  apiKey?: string;
  headers?: SimpleStreamOptions["headers"];
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  /**
   * Side calls always ask for the default retention, even after a parent that
   * kept its cache for an hour: the call reads the parent's entry, and only
   * the few tokens it adds are written, at the cheaper short-lived price.
   */
  cacheRetention?: "short";
}

/**
 * The request a side call sends: the parent's context and reply with
 * `append` after them, and the parent's replayable options. It does not
 * replace the conversation's server-side continuation state.
 */
export function sideCallContinuation(
  prefix: SideCallPrefix,
  append: readonly Message[],
  call: SideCallContinuationOptions,
): { context: TranscriptContext; options: SimpleStreamOptions } {
  const replay = prefix.options;
  return {
    context: {
      ...prefix.context,
      messages: [...prefix.context.messages, prefix.response, ...append],
    },
    options: {
      ...(replay.sessionId === undefined ? {} : { sessionId: replay.sessionId }),
      ...(replay.thinkingBudgets ? { thinkingBudgets: structuredClone(replay.thinkingBudgets) } : {}),
      ...(replay.temperature === undefined ? {} : { temperature: replay.temperature }),
      ...(replay.transport === undefined ? {} : { transport: replay.transport }),
      ...(replay.toolChoice === undefined ? {} : { toolChoice: structuredClone(replay.toolChoice) }),
      cacheRetention: call.cacheRetention ?? "short",
      disableContinuation: true,
      ...(replay.reasoning ? { reasoning: replay.reasoning } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.apiKey === undefined ? {} : { apiKey: call.apiKey }),
      ...(call.headers ? { headers: call.headers } : {}),
      ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
      ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
      ...(call.maxRetries === undefined ? {} : { maxRetries: call.maxRetries }),
      ...(call.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: call.maxRetryDelayMs }),
    },
  };
}
