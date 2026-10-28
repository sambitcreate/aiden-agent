// The request side of waiting out usage limits. A wrapped stream function asks
// the gate before each request, reads the status and rate-limit headers of the
// provider's response, and holds back the opening `start` event until the
// response shows content. A rejection that arrives before any content and reads
// as a usage limit is never shown: the request waits and sends again with the
// same model, context and options. Once content has streamed, a failure goes
// through as it does today, so nothing the person saw is replayed.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  classifyUsageLimit,
  decideUsageLimitWait,
  markUsageLimitFailure,
  usageLimitGiveUpNote,
  usageLimitKeys,
  usageLimitRefusedMessage,
  type ProviderResponseObservation,
  type UsageLimitDecision,
  type UsageLimitEntry,
  type UsageLimitGate,
  type UsageLimitOwner,
  type UsageLimitTicket,
} from "./usage-limit-core.js";

/**
 * Provider APIs whose adapters take a custom `fetch`, so the headers of a
 * rejected response can be read. The Google adapters refuse one.
 */
const FETCH_OBSERVABLE_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "pi-messages",
]);

/** Only rate-limit headers are kept from a response; nothing else is read. */
const RATE_LIMIT_HEADER = /^(?:retry-after(?:-ms)?|x-ratelimit-|ratelimit-|anthropic-ratelimit-|x-codex-(?:primary|secondary)-)/iu;

function rateLimitHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (RATE_LIMIT_HEADER.test(name) && typeof value === "string" && value.length <= 512) kept[name.toLowerCase()] = value;
  }
  return kept;
}

export interface UsageLimitWaitEvent {
  owner: UsageLimitOwner;
  model: Pick<Model<Api>, "provider" | "id">;
  entry?: UsageLimitEntry;
  decision?: Extract<UsageLimitDecision, { kind: "give-up" }>;
  /** Set on a give-up: the provider's name, whether the request had waited, and the longest wait then. */
  providerLabel?: string;
  waited?: boolean;
  maxWaitMs?: number;
}

export interface UsageLimitStreamOptions {
  gate: UsageLimitGate;
  owner: UsageLimitOwner;
  /** The provider's name as the person knows it, for the wait row and messages. */
  providerLabel: string;
  /** The longest wait now. Read at every hit, so a Settings change applies to waits already running. */
  maxWaitMs(): number | Promise<number>;
  /** Resolves once limits saved by an earlier run are loaded into the gate. */
  ready?: () => Promise<void>;
  /**
   * Read rejected responses through a recording `fetch`. Off for requests
   * that cross a process boundary, where a function cannot travel.
   */
  observeFetch?: boolean;
  now?: () => number;
  random?: () => number;
  onWait?(event: UsageLimitWaitEvent): void;
  onGiveUp?(event: UsageLimitWaitEvent): void;
}

type Peeked =
  | { kind: "content" | "done" | "ended"; events: AssistantMessageEvent[]; iterator: AsyncIterator<AssistantMessageEvent> }
  | { kind: "error"; events: AssistantMessageEvent[]; error: AssistantMessage };

/** Read until the response shows content or ends, keeping what was read. */
async function peek(stream: AssistantMessageEventStream): Promise<Peeked> {
  const iterator = stream[Symbol.asyncIterator]();
  const events: AssistantMessageEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { kind: "ended", events, iterator };
    const event = next.value;
    events.push(event);
    if (event.type === "start") continue;
    if (event.type === "error") return { kind: "error", events, error: event.error };
    if (event.type === "done") return { kind: "done", events, iterator };
    return { kind: "content", events, iterator };
  }
}

/** A stream that replays what was read and then forwards the rest. */
function replay(source: AssistantMessageEventStream, peeked: Peeked, replaceError?: AssistantMessage): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  for (const event of peeked.events) {
    output.push(event.type === "error" && replaceError ? { ...event, error: replaceError } : event);
  }
  if (peeked.kind === "error" || peeked.kind === "done") {
    output.end();
    return output;
  }
  if (peeked.kind === "ended") {
    output.end();
    void source.result().then((message) => output.end(message), () => {});
    return output;
  }
  const { iterator } = peeked;
  void (async () => {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        output.push(next.value);
      }
    } finally {
      output.end();
      void source.result().then((message) => output.end(message), () => {});
    }
  })();
  return output;
}

export function terminalMessage(model: Model<Api>, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export function terminalStream(message: AssistantMessage): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
  output.end();
  return output;
}

/**
 * Options that report each response's status and rate-limit headers: through
 * the response hook, and through a recording `fetch` where the adapter takes one.
 */
export function usageLimitObservedOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  observeFetch: boolean,
  record: (observation: ProviderResponseObservation) => void,
): SimpleStreamOptions {
  const hostOnResponse = options?.onResponse;
  const next: SimpleStreamOptions = {
    ...options,
    onResponse: async (response, responseModel) => {
      record({ status: response.status, headers: rateLimitHeaders(Object.entries(response.headers ?? {})) });
      await hostOnResponse?.(response, responseModel);
    },
  };
  if (observeFetch && FETCH_OBSERVABLE_APIS.has(model.api)) {
    const base = options?.fetch;
    next.fetch = async (input, init) => {
      const response = await (base ?? globalThis.fetch)(input, init);
      record({ status: response.status, headers: rateLimitHeaders(response.headers.entries()) });
      return response;
    };
  }
  return next;
}

/**
 * Send one model request through the gate, waiting out usage limits that
 * reject it before any content. Resolves to the stream the caller reads.
 * A thrown error from `call` is thrown here, as the unwrapped call would.
 */
export async function streamWaitingOutUsageLimits(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  call: (options: SimpleStreamOptions | undefined) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  limits: UsageLimitStreamOptions,
): Promise<AssistantMessageEventStream> {
  const { gate, owner, providerLabel } = limits;
  const now = limits.now ?? Date.now;
  const keys = usageLimitKeys(model.provider, model.id);
  const order = [keys.account, keys.model];
  const signal = options?.signal;
  let previous: UsageLimitTicket | undefined;
  await limits.ready?.();
  let maxWaitMs = await limits.maxWaitMs();
  // With waiting off, requests go straight through, as they did before.
  if (maxWaitMs <= 0) return call(options);
  for (;;) {
    const ticket = await gate.acquire(order, { owner, providerLabel, modelId: model.id, signal, maxWaitMs, ...(previous ? { previous } : {}) });
    if (ticket.kind === "aborted") return terminalStream(terminalMessage(model, "aborted", "Request was aborted"));
    if (ticket.kind === "too-long") {
      // A limit another request (or an earlier run) holds clears after this request's longest wait.
      const decision = { kind: "give-up", reason: "beyond-max-wait", ...(ticket.resetAt ? { resetAt: ticket.resetAt } : {}) } as const;
      const waited = previous !== undefined || ticket.waited;
      limits.onGiveUp?.({ owner, model, decision, providerLabel, waited, maxWaitMs: ticket.maxWaitMs });
      const note = usageLimitGiveUpNote(decision, { maxWaitMs: ticket.maxWaitMs, now: now() });
      return terminalStream(markUsageLimitFailure(terminalMessage(model, "error", `${providerLabel} is at its usage limit.\n\n${note}`)));
    }
    if (ticket.kind === "refused") {
      return terminalStream(
        markUsageLimitFailure(
          terminalMessage(model, "error", usageLimitRefusedMessage({ providerLabel, ...(ticket.resetAt ? { resetAt: ticket.resetAt } : {}), now: now() })),
        ),
      );
    }
    let observation: ProviderResponseObservation | undefined;
    const sent = usageLimitObservedOptions(model, options, limits.observeFetch !== false, (seen) => {
      observation = seen;
    });
    let stream: AssistantMessageEventStream;
    let peeked: Peeked;
    try {
      stream = await call(sent);
      peeked = await peek(stream);
    } catch (error) {
      gate.release(ticket);
      throw error;
    }
    if (peeked.kind !== "error") {
      if (peeked.kind === "ended") gate.release(ticket);
      else gate.answered(ticket);
      return replay(stream, peeked);
    }
    const { error } = peeked;
    if (error.stopReason === "aborted" || signal?.aborted) {
      gate.release(ticket);
      return replay(stream, peeked);
    }
    const at = now();
    const verdict = classifyUsageLimit({ errorMessage: error.errorMessage, observation, now: at });
    if (verdict.kind === "none") {
      gate.answered(ticket);
      return replay(stream, peeked);
    }
    // Turned off during the wait: fail as a request with waiting off would.
    maxWaitMs = ticket.off ? 0 : await limits.maxWaitMs();
    const accountWide = verdict.kind === "stop" || verdict.scope === "account";
    const key = accountWide ? keys.account : keys.model;
    // The test of one limit met a different one: the limit it tested is gone.
    if (ticket.testing && ticket.key !== key) gate.answered(ticket);
    const existing = gate.entry(key);
    const ownTest = ticket.testing && ticket.key === key;
    if (verdict.kind === "wait" && existing && !ownTest && maxWaitMs > 0) {
      // Another request already holds this limit (or just gave it up): wait behind its test.
      previous = ticket;
      continue;
    }
    const decision = decideUsageLimitWait({
      verdict,
      ...(existing ? { existing } : {}),
      key,
      providerId: model.provider,
      ...(accountWide ? {} : { modelId: model.id }),
      maxWaitMs,
      now: at,
      ...(limits.random ? { random: limits.random } : {}),
    });
    if (decision.kind === "give-up") {
      // Only a wait that ran out turns the line away; the rest fail one by one, as today.
      if (decision.reason === "beyond-max-wait" || decision.reason === "backoff-exhausted") {
        gate.refuse({ key, providerId: model.provider, ...(accountWide ? {} : { modelId: model.id }) }, decision.resetAt, ticket);
      } else if (decision.reason === "off" && ownTest) {
        // Waiting was turned off during the wait: the limit stops holding anyone.
        gate.answered(ticket);
      } else {
        gate.release(ticket);
      }
      limits.onGiveUp?.({ owner, model, decision, providerLabel, waited: previous !== undefined, maxWaitMs });
      const note = usageLimitGiveUpNote(decision, { maxWaitMs, now: at });
      const base = error.errorMessage?.trim() || `${providerLabel} rejected the request because of a usage limit.`;
      return replay(stream, peeked, markUsageLimitFailure(note ? { ...error, errorMessage: `${base}\n\n${note}` } : { ...error }));
    }
    gate.hold(decision.entry);
    limits.onWait?.({ owner, model, entry: decision.entry });
    previous = ticket;
  }
}

/** Wrap Pi's stream function so its requests wait out usage limits. */
export function withUsageLimitWait(streamFn: StreamFn, limits: UsageLimitStreamOptions): StreamFn {
  return (model, context, options) =>
    streamWaitingOutUsageLimits(model, options, (sent) => streamFn(model, context, sent), limits);
}

/**
 * The same for a synchronous `streamSimple`, such as a Bot's models: the stream
 * is returned at once and fills when the request is allowed to send.
 */
export function streamSimpleWaitingOutUsageLimits(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  call: (options: SimpleStreamOptions | undefined) => AssistantMessageEventStream,
  limits: UsageLimitStreamOptions,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void streamWaitingOutUsageLimits(model, options, call, limits).then(
    async (stream) => {
      for await (const event of stream) output.push(event);
      output.end();
      void stream.result().then((message) => output.end(message), () => {});
    },
    (error: unknown) => {
      const message = terminalMessage(
        model,
        options?.signal?.aborted ? "aborted" : "error",
        error instanceof Error ? error.message : String(error),
      );
      output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      output.end();
    },
  );
  return output;
}
