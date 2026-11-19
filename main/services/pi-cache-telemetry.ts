import { createHash } from "node:crypto";
import { toToolDeclaration, type CacheRetention, type Message, type SystemMessage, type Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

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

/** Pi's prompt-cache TTL: idle gaps longer than this explain a miss on their own. */
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

function shortHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "").digest("hex").slice(0, 12);
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
    messages: history.map((message) => ({ role: message.role, hash: shortHash(messageWireShape(message)) })),
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

export interface PromptCacheTelemetry {
  /** Record a request just before dispatch. */
  beginRequest(
    chatKey: string,
    request: { messages: readonly Message[]; model: PromptCacheModelRef; cacheRetention?: CacheRetention | string },
  ): PromptCacheRequestObservation;
  /** A cache-warming read restarts the cache lifetime, like Pi's `cache_warm` usage entry. */
  observeWarm(chatKey: string, message: PromptCacheResponse): void;
  /** Compaction legitimately rewrites the prefix; the next request starts fresh. */
  reset(chatKey: string): void;
  forget(chatKey: string): void;
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
              source: difference?.source ?? (measured.idleMs >= PROMPT_CACHE_TTL_MS ? "ttl" : "unknown"),
              ...(difference?.messageIndex !== undefined ? { messageIndex: difference.messageIndex, messageRole: difference.messageRole } : {}),
              ...(difference ? { previousHash: difference.previousHash, currentHash: difference.currentHash } : {}),
              at: now(),
            };
            state.lastMiss = report;
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
      state.previous = { promptTokens, modelKey: `${message.provider}/${message.model}`, timestamp: message.timestamp, reportedCache: true };
    },
    reset(chatKey) {
      const state = chats.get(chatKey);
      if (!state) return;
      state.previous = undefined;
      state.fingerprint = undefined;
    },
    forget(chatKey) {
      chats.delete(chatKey);
    },
    lastMiss(chatKey) {
      return chats.get(chatKey)?.lastMiss;
    },
  };
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
          const miss = pending.complete(message);
          if (miss) options.onMiss?.(miss);
        })
        .catch((error: unknown) => options.onError?.(error));
    }
    return stream;
  };
}
