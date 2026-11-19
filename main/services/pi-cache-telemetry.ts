import { createHash, randomBytes } from "node:crypto";
import { toToolDeclaration, type CacheRetention, type Message, type SystemMessage, type Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { promptCacheTtlMs } from "./prompt-cache-lifetimes.js";

/**
 * Prompt-cache miss telemetry, shared by the desktop chat runtime and
 * `aiden serve`.
 *
 * Miss detection follows Pi's `detectCacheMiss()` (pi-coding-agent's
 * `core/cache-stats`): a request counts as a miss when it re-billed more than
 * the noise floor of the previous request's prompt tokens. Pi's function is
 * not reachable through the package exports and the desktop does not depend
 * on pi-coding-agent, so its rules live here and a CLI test checks this copy
 * against Pi's file.
 *
 * Attribution compares a fingerprint of each request's normalized transcript
 * with the previous request in the same chat and names the first section
 * that differed, in the order a provider caches them: tools, then each
 * leading system section, then the message history. Only hashes, section
 * names, counts and timings are kept; never text.
 */

/**
 * Pi's prompt-cache TTL, used when the model has no documented lifetime: idle
 * gaps at least this long explain a miss on their own.
 */
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
/** Pi's noise floor: misses at or below this are cache breakpoint granularity. */
export const PROMPT_CACHE_MISS_NOISE_FLOOR_TOKENS = 1024;

/**
 * Where a miss came from. `system:<name>` names a leading system section
 * (`system:base` is the base prompt text); `unknown` means every hashed
 * section matched and the cache had not expired.
 */
export type PromptCacheMissSource = "model" | "retention" | "tools" | `system:${string}` | "messages" | "ttl" | "unknown";

export interface PromptCacheModelRef {
  provider: string;
  id: string;
  /** Catalog cost per million tokens; only `cacheRead` is read. */
  cost?: { cacheRead?: number };
}

/** The part of an assistant response the miss rules read. */
export interface PromptCacheResponse {
  provider: string;
  model: string;
  timestamp: number;
  usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite"> & { cost: Pick<Usage["cost"], "input" | "cacheRead" | "cacheWrite"> };
}

export interface PromptCacheMissMeasurement {
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
}

/** Pi's per-chat "previous request" state. */
export interface PromptCachePreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

function promptTokensOf(usage: PromptCacheResponse["usage"]): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Pi's `detectMiss`, one response against the previous request. */
export function measurePromptCacheMiss(
  previous: PromptCachePreviousRequest | undefined,
  message: PromptCacheResponse,
  catalogCacheReadPerMillion?: number,
): PromptCacheMissMeasurement | undefined {
  const usage = message.usage;
  const promptTokens = promptTokensOf(usage);
  if (!previous || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !previous.reportedCache)) return undefined;
  const missedTokens = Math.min(previous.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= PROMPT_CACHE_MISS_NOISE_FLOOR_TOKENS) return undefined;
  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const readPerToken = usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : (catalogCacheReadPerMillion ?? 0) / 1_000_000;
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, message.timestamp - previous.timestamp),
    modelChanged: `${message.provider}/${message.model}` !== previous.modelKey,
  };
}

/** Pi's `asPreviousRequest`: undefined keeps the earlier state. */
export function nextPromptCachePreviousRequest(
  previous: PromptCachePreviousRequest | undefined,
  message: PromptCacheResponse,
): PromptCachePreviousRequest | undefined {
  const usage = message.usage;
  const promptTokens = promptTokensOf(usage);
  if (promptTokens <= 0) return previous;
  return {
    promptTokens,
    modelKey: `${message.provider}/${message.model}`,
    timestamp: message.timestamp,
    reportedCache: (previous?.reportedCache ?? false) || usage.cacheRead + usage.cacheWrite > 0,
  };
}

/** Section hashes of one request. Hashes are short sha256 prefixes. */
export interface PromptPrefixFingerprint {
  model: string;
  retention: string;
  tools: string;
  /** Leading system sections in wire order; `base` is the prompt text. */
  system: { name: string; hash: string }[];
  /** One hash per message after the leading system message. */
  messages: { role: string; hash: string }[];
}

export interface PromptPrefixDifference {
  source: Exclude<PromptCacheMissSource, "ttl" | "unknown">;
  /** Index into the full transcript, for `messages`. */
  messageIndex?: number;
  messageRole?: string;
  previousHash: string;
  currentHash: string;
}

// A per-process salt: a 12-hex prefix of an unsalted hash of a short,
// guessable section would confirm its text to anyone who sees the log line.
const HASH_SALT = randomBytes(16);

function shortHash(value: unknown): string {
  return createHash("sha256")
    .update(HASH_SALT)
    .update(typeof value === "string" ? value : JSON.stringify(value) ?? "")
    .digest("hex")
    .slice(0, 12);
}

// The history is the same message objects request after request, so each one
// is serialized and hashed once. Messages are never edited after they enter
// the history; an edit replaces the object.
const messageHashes = new WeakMap<object, string>();

function messageHash(message: Message): string {
  let hash = messageHashes.get(message);
  if (hash === undefined) {
    hash = shortHash(messageWireShape(message));
    messageHashes.set(message, hash);
  }
  return hash;
}

/** Section names can carry a per-generation nonce; a label keeps only the stable stem. */
export function promptSectionLabel(name: string): string {
  return name.replace(/-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, "") || "section";
}

function systemWireShape(message: SystemMessage): unknown {
  return {
    content: message.content,
    sections: message.sections ?? null,
    toolsAdded: (message.toolsAdded ?? []).map(toToolDeclaration),
    toolsRemoved: message.toolsRemoved ?? [],
  };
}

/** The fields of a message a provider serializes; usage, timestamps and details are left out. */
function messageWireShape(message: Message): unknown {
  switch (message.role) {
    case "system":
      return systemWireShape(message);
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content };
    case "toolResult":
      return { role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, content: message.content };
    default:
      return message;
  }
}

/** Fingerprint a normalized request transcript. */
export function fingerprintPromptPrefix(input: {
  messages: readonly Message[];
  model: Pick<PromptCacheModelRef, "provider" | "id">;
  cacheRetention?: CacheRetention | string;
}): PromptPrefixFingerprint {
  const [first, ...rest] = input.messages;
  const leading = first?.role === "system" ? first : undefined;
  const history = leading ? rest : input.messages;
  const system = leading
    ? [
        { name: "base", hash: shortHash(leading.content) },
        ...Object.entries(leading.sections ?? {}).map(([name, value]) => ({ name: promptSectionLabel(name), hash: shortHash(value) })),
      ]
    : [];
  return {
    model: `${input.model.provider}/${input.model.id}`,
    retention: input.cacheRetention ?? "default",
    tools: shortHash((leading?.toolsAdded ?? []).map(toToolDeclaration)),
    system,
    messages: history.map((message) => ({ role: message.role, hash: messageHash(message) })),
  };
}

/** The first section, in cache order, where `current` stopped extending `previous`. */
export function diffPromptPrefix(previous: PromptPrefixFingerprint, current: PromptPrefixFingerprint): PromptPrefixDifference | undefined {
  if (previous.model !== current.model) return { source: "model", previousHash: shortHash(previous.model), currentHash: shortHash(current.model) };
  if (previous.retention !== current.retention) return { source: "retention", previousHash: previous.retention, currentHash: current.retention };
  if (previous.tools !== current.tools) return { source: "tools", previousHash: previous.tools, currentHash: current.tools };
  const sections = Math.max(previous.system.length, current.system.length);
  for (let index = 0; index < sections; index += 1) {
    const before = previous.system[index];
    const after = current.system[index];
    if (before?.name === after?.name && before?.hash === after?.hash) continue;
    return { source: `system:${(after ?? before)!.name}`, previousHash: before?.hash ?? "", currentHash: after?.hash ?? "" };
  }
  const offset = current.system.length > 0 || previous.system.length > 0 ? 1 : 0;
  for (let index = 0; index < previous.messages.length; index += 1) {
    const before = previous.messages[index]!;
    const after = current.messages[index];
    // A request that ends earlier still reuses the shared prefix.
    if (!after) break;
    if (before.hash === after.hash) continue;
    return { source: "messages", messageIndex: index + offset, messageRole: after.role, previousHash: before.hash, currentHash: after.hash };
  }
  return undefined;
}

export interface PromptCacheMissReport extends PromptCacheMissMeasurement {
  source: PromptCacheMissSource;
  messageIndex?: number;
  messageRole?: string;
  previousHash?: string;
  currentHash?: string;
  /** When the response that paid for the miss was observed. */
  at: number;
}

/** One log line of labels, hashes and counts. Never content. */
export function formatPromptCacheMissLog(report: PromptCacheMissReport): string {
  const parts = [`source=${report.source}`];
  if (report.messageIndex !== undefined) parts.push(`index=${report.messageIndex}`, `role=${report.messageRole ?? "?"}`);
  if (report.previousHash !== undefined) parts.push(`hash=${report.previousHash || "-"}->${report.currentHash || "-"}`);
  parts.push(`missed=${report.missedTokens}`, `idleMs=${report.idleMs}`);
  if (report.modelChanged) parts.push("modelChanged");
  return `Prompt cache miss: ${parts.join(" ")}`;
}

interface ChatState {
  previous?: PromptCachePreviousRequest;
  fingerprint?: PromptPrefixFingerprint;
  lastMiss?: PromptCacheMissReport;
}

export interface PromptCacheRequestObservation {
  /** Feed the request's response. Returns the miss it paid for, if any. */
  complete(message: PromptCacheResponse): PromptCacheMissReport | undefined;
}

export interface PromptCacheRequest {
  messages: readonly Message[];
  model: PromptCacheModelRef;
  cacheRetention?: CacheRetention | string;
  /**
   * The provider's documented cache lifetime for this model (see
   * `promptCacheTtlMs`); 0 or absent falls back to `PROMPT_CACHE_TTL_MS`.
   */
  cacheTtlMs?: number;
}

export interface PromptCacheTelemetry {
  /** Record a request just before dispatch. */
  beginRequest(chatKey: string, request: PromptCacheRequest): PromptCacheRequestObservation;
  /**
   * A cache-warming read restarts the cache lifetime, like Pi's `cache_warm`
   * usage entry. A warm no later than the latest recorded request is already
   * accounted for and is ignored, so callers may feed the same warm again.
   */
  observeWarm(chatKey: string, message: PromptCacheResponse): void;
  /** Compaction legitimately rewrites the prefix; the next request starts fresh. */
  reset(chatKey: string): void;
  forget(chatKey: string): void;
  /** The latest miss, until a later request reads from the cache or the chat is reset. */
  lastMiss(chatKey: string): PromptCacheMissReport | undefined;
}

const DEFAULT_MAX_CHATS = 256;

export function createPromptCacheTelemetry(options: { now?: () => number; maxChats?: number } = {}): PromptCacheTelemetry {
  const now = options.now ?? Date.now;
  const maxChats = options.maxChats ?? DEFAULT_MAX_CHATS;
  const chats = new Map<string, ChatState>();
  const stateFor = (chatKey: string): ChatState => {
    let state = chats.get(chatKey);
    if (state) {
      chats.delete(chatKey);
    } else {
      state = {};
      if (chats.size >= maxChats) chats.delete(chats.keys().next().value!);
    }
    chats.set(chatKey, state);
    return state;
  };
  return {
    beginRequest(chatKey, request) {
      const fingerprint = fingerprintPromptPrefix(request);
      const catalogCacheRead = request.model.cost?.cacheRead;
      const ttlMs = request.cacheTtlMs && request.cacheTtlMs > 0 ? request.cacheTtlMs : PROMPT_CACHE_TTL_MS;
      let completed = false;
      return {
        complete(message) {
          if (completed) return undefined;
          completed = true;
          const state = stateFor(chatKey);
          const measured = measurePromptCacheMiss(state.previous, message, catalogCacheRead);
          let report: PromptCacheMissReport | undefined;
          if (measured) {
            const difference = state.fingerprint ? diffPromptPrefix(state.fingerprint, fingerprint) : undefined;
            report = {
              ...measured,
              source: difference?.source ?? (measured.idleMs >= ttlMs ? "ttl" : "unknown"),
              ...(difference?.messageIndex !== undefined ? { messageIndex: difference.messageIndex, messageRole: difference.messageRole } : {}),
              ...(difference ? { previousHash: difference.previousHash, currentHash: difference.currentHash } : {}),
              at: now(),
            };
            state.lastMiss = report;
          } else if (message.usage.cacheRead > 0) {
            // The cache is serving this chat again, so the earlier miss is history.
            state.lastMiss = undefined;
          }
          const next = nextPromptCachePreviousRequest(state.previous, message);
          if (next !== state.previous) {
            state.previous = next;
            state.fingerprint = fingerprint;
          }
          return report;
        },
      };
    },
    observeWarm(chatKey, message) {
      const promptTokens = promptTokensOf(message.usage);
      if (promptTokens <= 0) return;
      const state = stateFor(chatKey);
      if (state.previous && message.timestamp <= state.previous.timestamp) return;
      state.previous = { promptTokens, modelKey: `${message.provider}/${message.model}`, timestamp: message.timestamp, reportedCache: true };
    },
    reset(chatKey) {
      const state = chats.get(chatKey);
      if (!state) return;
      state.previous = undefined;
      state.fingerprint = undefined;
      state.lastMiss = undefined;
    },
    forget(chatKey) {
      chats.delete(chatKey);
    },
    lastMiss(chatKey) {
      return chats.get(chatKey)?.lastMiss;
    },
  };
}

/** The fields of a Pi session entry that the warm scan reads. */
export interface PromptCacheSessionEntry {
  type: string;
  kind?: string;
  provider?: string;
  model?: string;
  usage?: PromptCacheResponse["usage"];
  timestamp?: string;
  message?: { role?: string };
}

/**
 * Pi's `cache_warm` usage entries written since the session's latest
 * response or compaction, oldest first, as `observeWarm` takes them. Earlier
 * warms were superseded by a later request in Pi's own scan.
 */
export function promptCacheWarmsSinceLastResponse(entries: readonly PromptCacheSessionEntry[]): PromptCacheResponse[] {
  const warms: PromptCacheResponse[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "compaction" || entry.type === "branch_summary") break;
    if (entry.type === "message" && entry.message?.role === "assistant") break;
    if (entry.type !== "usage" || entry.kind !== "cache_warm" || !entry.usage || !entry.provider || !entry.model) continue;
    const timestamp = Date.parse(entry.timestamp ?? "");
    if (!Number.isFinite(timestamp)) continue;
    warms.push({ provider: entry.provider, model: entry.model, timestamp, usage: entry.usage });
  }
  return warms.reverse();
}

/**
 * Observe every request a Pi stream function sends for one chat. Pi calls the
 * stream function once per model response with the final transcript, so the
 * fingerprint is the request as sent. Telemetry never fails the request.
 */
export function withPromptCacheTelemetry(
  streamFn: StreamFn,
  options: {
    telemetry: PromptCacheTelemetry;
    chatKey: string;
    onMiss?: (report: PromptCacheMissReport) => void;
    /** A request read from the cache after a miss, so `lastMiss` is now empty. */
    onMissCleared?: () => void;
    onError?: (error: unknown) => void;
  },
): StreamFn {
  return async (model, context, streamOptions) => {
    let observation: PromptCacheRequestObservation | undefined;
    try {
      observation = options.telemetry.beginRequest(options.chatKey, {
        messages: context.messages,
        model,
        cacheRetention: streamOptions?.cacheRetention,
        cacheTtlMs: promptCacheTtlMs(model, streamOptions?.cacheRetention),
      });
    } catch (error) {
      options.onError?.(error);
    }
    const stream = await streamFn(model, context, streamOptions);
    if (observation) {
      const pending = observation;
      void stream
        .result()
        .then((message) => {
          const hadMiss = options.telemetry.lastMiss(options.chatKey) !== undefined;
          const miss = pending.complete(message);
          if (miss) options.onMiss?.(miss);
          else if (hadMiss && options.telemetry.lastMiss(options.chatKey) === undefined) options.onMissCleared?.();
        })
        .catch((error: unknown) => options.onError?.(error));
    }
    return stream;
  };
}
