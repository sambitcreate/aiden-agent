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
 * of its message list, the replayable options and a hash of the model. It
 * never keeps credentials, headers or callbacks, never logs content and never
 * persists anything. Its caller sends the continuation with the side call's
 * own credentials and signal, and never executes a tool call in the reply.
 */
import { createHash } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ModelsSimpleStreamOptions,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
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
}

/**
 * Identifies the model a request went to, without keeping its headers. Two
 * runtimes with equal keys render the same request body for the same context.
 */
export function sideCallModelKey(model: Model<Api>): string {
  const { headers: _headers, ...identity } = model as Model<Api> & { headers?: unknown };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export interface SideCallPrefixLedger {
  /**
   * Called when a foreground request is dispatched. Returns the callback for
   * its reply. A request that cannot be replayed clears the chat's entry.
   */
  begin(chatKey: string, model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): (message: AssistantMessage) => void;
  /** The chat's last completed request while its cache is still live. */
  latest(chatKey: string): SideCallPrefix | undefined;
  forget(chatKey: string): void;
}

interface PendingEntry extends Omit<SideCallPrefix, "response"> {
  response?: AssistantMessage;
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
  settings: { maxChats?: number; now?: () => number; ttlMs?: (model: Model<Api>) => number } = {},
): SideCallPrefixLedger {
  const maxChats = settings.maxChats ?? 8;
  const now = settings.now ?? Date.now;
  const ttlMs = settings.ttlMs ?? promptCacheTtlMs;
  const entries = new Map<string, PendingEntry>();

  return {
    begin(chatKey, model, context, options) {
      entries.delete(chatKey);
      const ttl = ttlMs(model);
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
        context: { ...context, messages: [...context.messages] },
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
    latest(chatKey) {
      const entry = entries.get(chatKey);
      if (!entry?.response) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(chatKey);
        return undefined;
      }
      return entry as SideCallPrefix;
    },
    forget(chatKey) {
      entries.delete(chatKey);
    },
  };
}

/** Records each foreground request on the ledger as it is dispatched. */
export function withSideCallPrefixLedger(
  streamFn: StreamFn,
  { ledger, chatKey }: { ledger: SideCallPrefixLedger; chatKey: string },
): StreamFn {
  return async (model, context, options) => {
    let finished: (message: AssistantMessage) => void = () => {};
    try {
      finished = ledger.begin(chatKey, model, context, options);
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
  /** Overrides the parent's reasoning; a different level shares only tools and system. */
  reasoning?: SimpleStreamOptions["reasoning"];
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
      cacheRetention: replay.cacheRetention ?? "short",
      disableContinuation: true,
      ...(call.reasoning ?? replay.reasoning ? { reasoning: call.reasoning ?? replay.reasoning } : {}),
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
