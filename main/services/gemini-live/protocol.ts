import { Modality } from "@google/genai";
import type {
  Content,
  FunctionResponse,
  LiveConnectConfig,
  LiveConnectParameters,
  LiveSendClientContentParameters,
  LiveSendRealtimeInputParameters,
  LiveSendToolResponseParameters,
  LiveServerMessage,
  Session,
} from "@google/genai";

export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24_000;
export const GEMINI_LIVE_PCM_BYTES_PER_SAMPLE = 2;
export const GEMINI_LIVE_MIN_AUDIO_CHUNK_MS = 20;
export const GEMINI_LIVE_MAX_AUDIO_CHUNK_MS = 40;
export const GEMINI_LIVE_VIDEO_INTERVAL_MS = 1_000;

// The worklet emits 20 ms packets (nominally 50/second). A rolling window with
// the same hard ceiling rejects valid capture whenever device-clock jitter
// briefly bunches packet 51 inside one wall-clock second. Keep a small bounded
// burst allowance while independently limiting the admitted PCM byte rate.
const MAX_AUDIO_PACKETS_PER_SECOND = 60;
const MAX_INPUT_AUDIO_BYTES_PER_SECOND = 38_400;
const MAX_SERVER_EVENTS_PER_SECOND = 100;
const MAX_OUTPUT_AUDIO_BYTES_PER_PART = 384_000;
const MAX_OUTPUT_AUDIO_BYTES_PER_EVENT = 512_000;
const MAX_OUTPUT_AUDIO_BYTES_PER_SECOND = 768_000;
const MAX_DECODED_SERVER_EVENT_BYTES = 640_000;
export const GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES = 96_000;
const MAX_JPEG_BYTES = 1_500_000;
const MAX_TEXT_BYTES = 16_384;
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_BYTES = 65_536;
const MAX_IGNORED_METADATA_BYTES = 32_768;
const MAX_PROVIDER_IDENTIFIER_BYTES = 4_096;
const MAX_TURN_COMPLETE_REASON_BYTES = 256;
const MAX_SERVER_PARTS = 32;
const MAX_TRANSCRIPTION_WORDS = 256;
const MAX_TOOL_CALLS_PER_EVENT = 8;
export const GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS = 256;
const MAX_TOOL_ARGUMENT_BYTES = 32_768;
const MAX_TOOL_RESULT_BYTES = 32_768;
const MAX_RESUMPTION_HANDLE_BYTES = 4_096;
const FUNCTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u;
const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/u;
const DURATION_PATTERN = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,9})?s$/u;
const SUPPORTED_SERVER_MESSAGE_KEYS = new Set([
  "setupComplete",
  "serverContent",
  "toolCall",
  "toolCallCancellation",
  "usageMetadata",
  "sessionResumptionUpdate",
  "goAway",
  "voiceActivity",
  "voiceActivityDetectionSignal",
]);

export type GeminiLiveProtocolState =
  | "idle"
  | "connecting"
  | "open"
  | "resuming"
  | "closing"
  | "closed"
  | "failed"
  | "disconnected";

export type GeminiLiveProtocolErrorCode =
  | "cancelled"
  | "connect_timeout"
  | "idle_timeout"
  | "malformed_server_event"
  | "provider_rate_limit"
  | "resumption_unavailable"
  | "transport_error"
  | "unexpected_disconnect";

export type GeminiLiveMalformedStage =
  | "message"
  | "setup_complete"
  | "server_content_shape"
  | "server_content_metadata"
  | "server_content_reason"
  | "server_content_interrupted"
  | "server_content_model_turn"
  | "server_content_completion_flags"
  | "server_content_interaction_status"
  | "message_no_meaningful_members"
  | "server_part"
  | "transcription"
  | "tool_call"
  | "tool_cancellation"
  | "usage"
  | "resumption"
  | "go_away"
  | "voice_activity";

export type GeminiLiveProtocolDiagnosticDetail =
  | "interaction_turn_absent_status_official"
  | "interaction_turn_absent_status_invalid"
  | "interaction_turn_false_status_official"
  | "interaction_turn_false_status_invalid"
  | "interaction_turn_invalid_status_official"
  | "interaction_turn_invalid_status_invalid"
  | "interaction_turn_true_status_invalid";

export type GeminiLiveProtocolEvent =
  | { type: "state"; state: GeminiLiveProtocolState }
  | { type: "ready" }
  | {
      type: "audio";
      pcm: Uint8Array;
      sampleRate: typeof GEMINI_LIVE_OUTPUT_SAMPLE_RATE;
    }
  | { type: "playback_flush" }
  | {
      type: "caption";
      direction: "input" | "output";
      final: boolean;
      text: string;
    }
  | { type: "model_text"; text: string }
  | { type: "turn"; state: "generation_complete" | "turn_complete" | "waiting" }
  | {
      type: "function_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: "function_cancel"; id: string }
  | { type: "resumption"; resumable: boolean }
  | { type: "go_away"; timeLeft?: string }
  | {
      type: "usage";
      promptTokens: number;
      responseTokens: number;
      totalTokens: number;
    }
  | {
      type: "error";
      code: GeminiLiveProtocolErrorCode;
      message: string;
      diagnostic?: GeminiLiveMalformedStage;
      diagnosticDetail?: GeminiLiveProtocolDiagnosticDetail;
    }
  | {
      type: "reconnect_required";
      reason:
        "resumption_unavailable" | "resume_failed" | "unexpected_disconnect";
    };

export interface GeminiLiveHistoryTurn {
  role: "model" | "user";
  text: string;
}

export interface GeminiLiveToolResult {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export type GeminiLiveWireSession = Pick<
  Session,
  "close" | "sendClientContent" | "sendRealtimeInput" | "sendToolResponse"
>;

/**
 * Gemini 3.1 requires this setup field before client-content history is used.
 * @google/genai 2.16.0 declares it on LiveClientSetup but omits it from the
 * public LiveConnectConfig shape and its setup serializer.
 */
export interface GeminiLiveConnectConfig extends LiveConnectConfig {
  historyConfig?: { initialHistoryInClientContent?: boolean };
}

export interface GeminiLiveConnectParameters extends Omit<
  LiveConnectParameters,
  "config"
> {
  config?: GeminiLiveConnectConfig;
}

export type GeminiLiveConnector = (
  params: GeminiLiveConnectParameters,
) => Promise<GeminiLiveWireSession>;

export interface GeminiLiveClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface GeminiLiveProtocolOptions {
  clock?: GeminiLiveClock;
  connectTimeoutMs?: number;
  connector: GeminiLiveConnector;
  idleTimeoutMs?: number;
  model: string;
  onEvent: (event: GeminiLiveProtocolEvent) => void;
  signal?: AbortSignal;
  /** Exact Aiden custom declarations admitted by the main-owned session gate. */
  tools?: LiveConnectConfig["tools"];
}

const systemClock: GeminiLiveClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const SAFE_ERROR_MESSAGES: Record<GeminiLiveProtocolErrorCode, string> = {
  cancelled: "The Live session was cancelled.",
  connect_timeout: "The Live connection timed out.",
  idle_timeout: "The Live connection stopped responding.",
  malformed_server_event: "The Live provider sent an invalid event.",
  provider_rate_limit: "The Live provider exceeded the session safety budget.",
  resumption_unavailable: "The Live session cannot be resumed safely.",
  transport_error: "The Live connection failed.",
  unexpected_disconnect: "The Live connection closed unexpectedly.",
};

export class GeminiLiveProtocolFailure extends Error {
  constructor(
    readonly code: GeminiLiveProtocolErrorCode,
    readonly diagnostic?: GeminiLiveMalformedStage,
    readonly diagnosticDetail?: GeminiLiveProtocolDiagnosticDetail,
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function keys(...values: string[]): ReadonlySet<string> {
  return new Set(values);
}

function interactionStatusDiagnostic(
  turnComplete: unknown,
  interactionStatus: unknown,
): GeminiLiveProtocolDiagnosticDetail {
  const status =
    typeof interactionStatus === "string" &&
    INTERACTION_STATUSES.has(interactionStatus)
      ? "official"
      : "invalid";
  if (turnComplete === true) return "interaction_turn_true_status_invalid";
  if (turnComplete === false)
    return `interaction_turn_false_status_${status}`;
  if (turnComplete === undefined)
    return `interaction_turn_absent_status_${status}`;
  return `interaction_turn_invalid_status_${status}`;
}

const SETUP_COMPLETE_KEYS = keys("sessionId", "voiceConsentSignature");
const SERVER_CONTENT_KEYS = keys(
  "interrupted",
  "modelTurn",
  "interimInputTranscription",
  "inputTranscription",
  "outputTranscription",
  "generationComplete",
  "turnComplete",
  "turnCompleteReason",
  "waitingForInput",
  "interactionStatus",
  "groundingMetadata",
  "urlContextMetadata",
);
const MODEL_TURN_KEYS = keys("parts", "role");
const SERVER_PART_KEYS = keys(
  "audioTranscription",
  "inlineData",
  "mediaResolution",
  "partMetadata",
  "text",
  "thought",
  "thoughtSignature",
);
const INLINE_DATA_KEYS = keys("data", "displayName", "mimeType");
const SERVER_PART_IGNORED_METADATA_KEYS = [
  "audioTranscription",
  "mediaResolution",
  "partMetadata",
] as const;
const TRANSCRIPTION_KEYS = keys(
  "text",
  "finished",
  "languageCode",
  "speakerLabel",
  "words",
);
const TOOL_CALL_KEYS = keys("functionCalls");
const FUNCTION_CALL_KEYS = keys("id", "name", "args");
const TOOL_CANCELLATION_KEYS = keys("ids");
const USAGE_KEYS = keys(
  "promptTokenCount",
  "responseTokenCount",
  "totalTokenCount",
  "responseTokensDetails",
  "cacheTokensDetails",
  "cachedContentTokenCount",
  "promptTokensDetails",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
  "toolUsePromptTokensDetails",
  "trafficType",
  "serviceTier",
);
const RESUMPTION_KEYS = keys(
  "resumable",
  "newHandle",
  "lastConsumedClientMessageIndex",
);
const GO_AWAY_KEYS = keys("timeLeft");
const VOICE_CONSENT_KEYS = keys("signature");
const VOICE_ACTIVITY_KEYS = keys("voiceActivityType", "audioOffset");
const VAD_SIGNAL_KEYS = keys("vadSignalType");
const WORD_INFO_KEYS = keys("word", "startOffset", "endOffset");
const VOICE_ACTIVITY_TYPES = new Set([
  "TYPE_UNSPECIFIED",
  "ACTIVITY_START",
  "ACTIVITY_END",
]);
const VAD_SIGNAL_TYPES = new Set([
  "VAD_SIGNAL_TYPE_UNSPECIFIED",
  "VAD_SIGNAL_TYPE_SOS",
  "VAD_SIGNAL_TYPE_EOS",
]);
const INTERACTION_STATUSES = new Set([
  "INTERACTION_STATUS_UNSPECIFIED",
  "IN_PROGRESS",
  "REQUIRES_ACTION",
]);

function boundedOptionalString(value: unknown, maxBytes: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && utf8Bytes(value) <= maxBytes)
  );
}

function validDuration(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && DURATION_PATTERN.test(value))
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function cloneJsonRecord(
  value: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> | null {
  try {
    const serialized = JSON.stringify(value);
    if (utf8Bytes(serialized) > maxBytes) return null;
    const cloned: unknown = JSON.parse(serialized);
    return isRecord(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function finiteCount(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedJsonBytes(value: unknown, maxBytes: number): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    const bytes = utf8Bytes(serialized);
    return bytes <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return false;
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4
  )
    return null;
  if (!validBase64(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maxBytes) return null;
  if (decoded.toString("base64") !== value) return null;
  return new Uint8Array(decoded);
}

function audioChunkDurationMs(bytes: number): number {
  return (
    (bytes * 1_000) /
    (GEMINI_LIVE_INPUT_SAMPLE_RATE * GEMINI_LIVE_PCM_BYTES_PER_SAMPLE)
  );
}

function validJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes.length <= MAX_JPEG_BYTES &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function safeHistory(turns: readonly GeminiLiveHistoryTurn[]): Content[] {
  if (turns.length > MAX_HISTORY_TURNS)
    throw new Error("Live history exceeds its turn limit.");
  let totalBytes = 0;
  return turns.map((turn) => {
    if (turn.role !== "user" && turn.role !== "model") {
      throw new Error("Live history contains an invalid role.");
    }
    if (typeof turn.text !== "string" || turn.text.length === 0) {
      throw new Error("Live history contains empty text.");
    }
    totalBytes += utf8Bytes(turn.text);
    if (totalBytes > MAX_HISTORY_BYTES)
      throw new Error("Live history exceeds its size limit.");
    return { role: turn.role, parts: [{ text: turn.text }] };
  });
}

function validToolIdentity(id: unknown, name: unknown): id is string {
  return (
    typeof id === "string" &&
    TOOL_CALL_ID_PATTERN.test(id) &&
    typeof name === "string" &&
    FUNCTION_NAME_PATTERN.test(name)
  );
}

function liveConnectConfig(
  signal: AbortSignal,
  handle?: string,
  tools?: LiveConnectConfig["tools"],
): GeminiLiveConnectConfig {
  return {
    abortSignal: signal,
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    ...(handle
      ? {}
      : { historyConfig: { initialHistoryInClientContent: true } }),
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: handle ? { handle } : {},
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

/**
 * Production-inert Phase-0 Live protocol core. Credentials, Electron IPC,
 * capture admission, and Computer Use intentionally remain outside this class.
 */
export class GeminiLiveProtocol {
  private readonly clock: GeminiLiveClock;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private phase: GeminiLiveProtocolState = "idle";
  private generation = 0;
  private wire: GeminiLiveWireSession | null = null;
  private attemptController: AbortController | null = null;
  private idleTimer: unknown = null;
  private frameTimer: unknown = null;
  private pendingFrame: Uint8Array | null = null;
  private lastFrameAt: number | null = null;
  private lastProviderActivityAt = 0;
  private audioPackets: Array<{ bytes: number; time: number }> = [];
  private serverEventTimes: number[] = [];
  private outputAudioTimes: Array<{ at: number; bytes: number }> = [];
  private decodedAudioBytesThisEvent = 0;
  private readonly toolCalls = new Map<
    string,
    { name: string; status: "issued" | "completed" | "cancelled" }
  >();
  private seeded = false;
  private resumptionHandle: string | null = null;
  private resumptionInFlight = false;
  private removeParentAbort: (() => void) | null = null;
  private transactionEvents: GeminiLiveProtocolEvent[] | null = null;
  private transactionEffects: Array<() => void> | null = null;
  private transactionMeaningfulMembers = 0;
  private transactionDecodedBytes = 0;
  private malformedStage: GeminiLiveMalformedStage = "message";

  constructor(private readonly options: GeminiLiveProtocolOptions) {
    this.clock = options.clock ?? systemClock;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    // Google documents connections lasting around ten minutes and does not
    // promise an application message during quiet listening. Keep this
    // fail-safe beyond that provider-managed window so silence is not treated
    // as a dead connection before GoAway/session resumption can occur.
    this.idleTimeoutMs = options.idleTimeoutMs ?? 11 * 60_000;
    if (!FUNCTION_NAME_PATTERN.test(options.model.replace(/\//gu, "."))) {
      throw new Error("Live model identifier is invalid.");
    }
    if (this.connectTimeoutMs <= 0 || this.idleTimeoutMs <= 0) {
      throw new Error("Live deadlines must be positive.");
    }
  }

  get state(): GeminiLiveProtocolState {
    return this.phase;
  }

  async start(history: readonly GeminiLiveHistoryTurn[] = []): Promise<void> {
    if (this.phase !== "idle")
      throw new Error("Live protocol has already started.");
    safeHistory(history);
    if (this.options.signal?.aborted) {
      this.stop("cancelled");
      throw new GeminiLiveProtocolFailure("cancelled");
    }
    if (this.options.signal) {
      const onAbort = () => this.stop("cancelled");
      this.options.signal.addEventListener("abort", onAbort, { once: true });
      this.removeParentAbort = () =>
        this.options.signal?.removeEventListener("abort", onAbort);
    }
    await this.openConnection(undefined, "connecting");
    this.seedHistory(history);
  }

  seedHistory(turns: readonly GeminiLiveHistoryTurn[]): void {
    this.requireOpen();
    if (this.seeded) throw new Error("Live history may only be seeded once.");
    const content = safeHistory(turns);
    const params: LiveSendClientContentParameters =
      content.length > 0
        ? { turns: content, turnComplete: true }
        : { turnComplete: true };
    this.dispatch(() => this.wire!.sendClientContent(params));
    this.seeded = true;
  }

  sendText(text: string): void {
    this.requireOpenAndSeeded();
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      utf8Bytes(text) > MAX_TEXT_BYTES
    ) {
      throw new Error("Live text is empty or exceeds its size limit.");
    }
    const params: LiveSendRealtimeInputParameters = { text };
    this.dispatch(() => this.wire!.sendRealtimeInput(params));
  }

  sendAudio(pcm: Uint8Array): void {
    this.requireOpenAndSeeded();
    if (
      !(pcm instanceof Uint8Array) ||
      pcm.byteLength % GEMINI_LIVE_PCM_BYTES_PER_SAMPLE !== 0
    ) {
      throw new Error("Live audio must be signed 16-bit PCM.");
    }
    const duration = audioChunkDurationMs(pcm.byteLength);
    if (
      duration < GEMINI_LIVE_MIN_AUDIO_CHUNK_MS ||
      duration > GEMINI_LIVE_MAX_AUDIO_CHUNK_MS
    ) {
      throw new Error(
        "Live audio chunks must be between 20 and 40 milliseconds.",
      );
    }
    const now = this.clock.now();
    this.audioPackets = this.audioPackets.filter(
      (packet) => packet.time > now - 1_000,
    );
    if (
      this.audioPackets.length >= MAX_AUDIO_PACKETS_PER_SECOND ||
      this.audioPackets.reduce((total, packet) => total + packet.bytes, 0) +
        pcm.byteLength >
        MAX_INPUT_AUDIO_BYTES_PER_SECOND
    ) {
      throw new Error("Live audio exceeded its packet-rate limit.");
    }
    this.audioPackets.push({ bytes: pcm.byteLength, time: now });
    const bytes = copyBytes(pcm);
    this.dispatch(() =>
      this.wire!.sendRealtimeInput({
        audio: {
          data: Buffer.from(bytes).toString("base64"),
          mimeType: `audio/pcm;rate=${GEMINI_LIVE_INPUT_SAMPLE_RATE}`,
        },
      }),
    );
  }

  endAudio(): void {
    this.requireOpenAndSeeded();
    this.dispatch(() => this.wire!.sendRealtimeInput({ audioStreamEnd: true }));
  }

  sendJpeg(frame: Uint8Array): "queued" | "replaced" | "sent" {
    this.requireOpenAndSeeded();
    if (!(frame instanceof Uint8Array) || !validJpeg(frame)) {
      throw new Error("Live screen frames must be bounded JPEG images.");
    }
    const next = copyBytes(frame);
    const now = this.clock.now();
    if (
      this.lastFrameAt === null ||
      now - this.lastFrameAt >= GEMINI_LIVE_VIDEO_INTERVAL_MS
    ) {
      this.sendFrameNow(next);
      return "sent";
    }
    const replaced = this.pendingFrame !== null;
    this.pendingFrame = next;
    if (this.frameTimer === null) {
      const delay = GEMINI_LIVE_VIDEO_INTERVAL_MS - (now - this.lastFrameAt);
      this.frameTimer = this.clock.setTimeout(() => {
        this.frameTimer = null;
        const pending = this.pendingFrame;
        this.pendingFrame = null;
        if (pending && this.phase === "open") {
          try {
            this.sendFrameNow(pending);
          } catch {
            // dispatch() already failed the owned transport safely.
          }
        }
      }, delay);
    }
    return replaced ? "replaced" : "queued";
  }

  sendToolResult(result: GeminiLiveToolResult): void {
    this.requireOpenAndSeeded();
    if (
      !validToolIdentity(result.id, result.name) ||
      !isRecord(result.response)
    ) {
      throw new Error("Live tool result has an invalid identity or response.");
    }
    const safeResponse = cloneJsonRecord(
      result.response,
      MAX_TOOL_RESULT_BYTES,
    );
    if (!safeResponse) {
      throw new Error("Live tool result exceeds its size limit.");
    }
    const issued = this.toolCalls.get(result.id);
    if (!issued || issued.name !== result.name) {
      throw new Error("Live tool result does not match an issued call.");
    }
    if (issued.status !== "issued") {
      throw new Error(`Live tool call is already ${issued.status}.`);
    }
    const response: FunctionResponse = {
      id: result.id,
      name: result.name,
      response: safeResponse,
    };
    const params: LiveSendToolResponseParameters = {
      functionResponses: response,
    };
    this.dispatch(() => this.wire!.sendToolResponse(params));
    issued.status = "completed";
  }

  stop(reason: "cancelled" | "user" = "user"): void {
    if (
      this.phase === "closed" ||
      this.phase === "failed" ||
      this.phase === "disconnected"
    )
      return;
    this.setState("closing");
    this.generation += 1;
    this.attemptController?.abort();
    this.attemptController = null;
    this.clearTimersAndQueues();
    const wire = this.wire;
    this.wire = null;
    try {
      wire?.close();
    } catch {
      // Local close is best-effort after authority and queues are already revoked.
    }
    this.removeParentAbort?.();
    this.removeParentAbort = null;
    this.setState("closed");
    if (reason === "cancelled") this.emitError("cancelled");
  }

  private async openConnection(
    handle: string | undefined,
    nextState: "connecting" | "resuming",
  ): Promise<void> {
    this.setState(nextState);
    const generation = ++this.generation;
    const controller = new AbortController();
    this.attemptController = controller;
    let connected = false;
    let rejectTransport!: (error: Error) => void;
    const transportFailure = new Promise<never>((_resolve, reject) => {
      rejectTransport = reject;
    });
    const callbacks: LiveConnectParameters["callbacks"] = {
      onopen: () => undefined,
      onmessage: (message) => {
        if (generation !== this.generation) return;
        try {
          this.handleServerMessage(message);
        } catch (error) {
          if (error instanceof GeminiLiveProtocolFailure)
            this.failTransport(
              error.code,
              error.diagnostic,
              error.diagnosticDetail,
            );
          else this.failTransport("malformed_server_event");
        }
      },
      onerror: (event) => {
        if (generation !== this.generation) return;
        if (!connected) {
          const error =
            event &&
            typeof event === "object" &&
            "error" in event &&
            event.error instanceof Error &&
            event.error.name === "GeminiLiveConnectionError"
              ? event.error
              : new GeminiLiveProtocolFailure("transport_error");
          rejectTransport(error);
        } else this.failTransport("transport_error");
      },
      onclose: () => {
        if (generation !== this.generation) return;
        if (!connected) {
          rejectTransport(
            new GeminiLiveProtocolFailure("unexpected_disconnect"),
          );
        } else {
          this.unexpectedDisconnect();
        }
      },
    };
    const params: LiveConnectParameters = {
      model: this.options.model,
      callbacks,
      config: liveConnectConfig(controller.signal, handle, this.options.tools),
    };
    let timeoutTimer: unknown = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = this.clock.setTimeout(
        () => reject(new GeminiLiveProtocolFailure("connect_timeout")),
        this.connectTimeoutMs,
      );
    });
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(new GeminiLiveProtocolFailure("cancelled"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const connecting = Promise.resolve().then(() =>
      this.options.connector(params),
    );
    void connecting.then(
      (lateWire) => {
        if (generation !== this.generation || controller.signal.aborted) {
          try {
            lateWire.close();
          } catch {
            // A stale connector cannot regain ownership even if close itself fails.
          }
        }
      },
      () => undefined,
    );
    try {
      const wire = await Promise.race([
        connecting,
        transportFailure,
        timeout,
        aborted,
      ]);
      if (generation !== this.generation || controller.signal.aborted) {
        wire.close();
        throw new GeminiLiveProtocolFailure("cancelled");
      }
      connected = true;
      this.wire = wire;
      this.lastProviderActivityAt = this.clock.now();
      this.setState("open");
      this.armIdleDeadline();
    } catch (error) {
      controller.abort();
      if (generation === this.generation && this.phase !== "closed") {
        const code =
          error instanceof GeminiLiveProtocolFailure
            ? error.code
            : "transport_error";
        this.failTransport(code);
      }
      throw error;
    } finally {
      if (timeoutTimer !== null) this.clock.clearTimeout(timeoutTimer);
      controller.signal.removeEventListener("abort", onAbort);
      // Keep these closures live only for the race above.
      rejectTransport = () => undefined;
    }
  }

  private handleServerMessage(message: LiveServerMessage): void {
    this.malformedStage = "message";
    if (!isRecord(message)) throw new Error("Invalid Live server message.");
    const keys = Object.keys(message);
    if (
      keys.length === 0 ||
      keys.some((key) => !SUPPORTED_SERVER_MESSAGE_KEYS.has(key))
    ) {
      this.malformed();
    }
    const toolSnapshot = new Map(
      [...this.toolCalls].map(([id, call]) => [id, { ...call }]),
    );
    const resumptionSnapshot = this.resumptionHandle;
    const serverEventTimesSnapshot = [...this.serverEventTimes];
    const outputAudioTimesSnapshot = [...this.outputAudioTimes];
    this.transactionEvents = [];
    this.transactionEffects = [];
    this.transactionMeaningfulMembers = 0;
    this.transactionDecodedBytes = 0;
    this.decodedAudioBytesThisEvent = 0;
    try {
      this.admitServerEvent();
      if (message.setupComplete !== undefined) {
        this.malformedStage = "setup_complete";
        if (
          !isRecord(message.setupComplete) ||
          !hasOnlyKeys(message.setupComplete, SETUP_COMPLETE_KEYS)
        ) {
          this.malformed();
        }
        if (
          !boundedOptionalString(
            message.setupComplete.sessionId,
            MAX_PROVIDER_IDENTIFIER_BYTES,
          ) ||
          (message.setupComplete.voiceConsentSignature !== undefined &&
            (!isRecord(message.setupComplete.voiceConsentSignature) ||
              !hasOnlyKeys(
                message.setupComplete.voiceConsentSignature,
                VOICE_CONSENT_KEYS,
              ) ||
              !boundedOptionalString(
                message.setupComplete.voiceConsentSignature.signature,
                MAX_IGNORED_METADATA_BYTES,
              )))
        ) {
          this.malformed();
        }
        const setupBytes = boundedJsonBytes(
          message.setupComplete,
          MAX_IGNORED_METADATA_BYTES,
        );
        if (setupBytes === null) this.malformed();
        this.chargeDecodedBytes(setupBytes ?? 0);
        this.markMeaningful();
        this.emit({ type: "ready" });
      }
      if (message.serverContent !== undefined) {
        this.malformedStage = "server_content_shape";
        this.handleServerContent(message.serverContent);
      }
      if (message.toolCall !== undefined) {
        this.malformedStage = "tool_call";
        this.handleToolCalls(message.toolCall);
      }
      if (message.toolCallCancellation !== undefined) {
        this.malformedStage = "tool_cancellation";
        this.handleToolCallCancellation(message.toolCallCancellation);
      }
      if (message.usageMetadata !== undefined) {
        this.malformedStage = "usage";
        this.handleUsage(message.usageMetadata);
      }
      if (message.sessionResumptionUpdate !== undefined) {
        this.malformedStage = "resumption";
        this.handleResumptionUpdate(message.sessionResumptionUpdate);
      }
      if (message.goAway !== undefined) {
        this.malformedStage = "go_away";
        this.handleGoAway(message.goAway);
      }
      for (const field of [
        "voiceActivity",
        "voiceActivityDetectionSignal",
      ] as const) {
        const metadata: unknown = message[field];
        if (metadata === undefined) continue;
        this.malformedStage = "voice_activity";
        if (!isRecord(metadata)) {
          this.malformed();
          continue;
        }
        if (field === "voiceActivity") {
          if (
            !hasOnlyKeys(metadata, VOICE_ACTIVITY_KEYS) ||
            (metadata.voiceActivityType !== undefined &&
              (typeof metadata.voiceActivityType !== "string" ||
                !VOICE_ACTIVITY_TYPES.has(metadata.voiceActivityType))) ||
            !validDuration(metadata.audioOffset)
          )
            this.malformed();
        } else if (
          !hasOnlyKeys(metadata, VAD_SIGNAL_KEYS) ||
          (metadata.vadSignalType !== undefined &&
            (typeof metadata.vadSignalType !== "string" ||
              !VAD_SIGNAL_TYPES.has(metadata.vadSignalType)))
        ) {
          this.malformed();
        }
        const bytes = boundedJsonBytes(metadata, MAX_IGNORED_METADATA_BYTES);
        if (bytes === null) this.malformed();
        this.chargeDecodedBytes(bytes ?? 0);
        this.markMeaningful();
      }
      if (this.transactionMeaningfulMembers === 0) {
        this.malformedStage = "message_no_meaningful_members";
        this.malformed();
      }

      const events = this.transactionEvents;
      const effects = this.transactionEffects;
      this.transactionEvents = null;
      this.transactionEffects = null;
      for (const event of events) this.emit(event);
      this.touchProviderActivity();
      for (const effect of effects) effect();
    } catch (error) {
      this.toolCalls.clear();
      for (const [id, call] of toolSnapshot) this.toolCalls.set(id, call);
      this.resumptionHandle = resumptionSnapshot;
      this.serverEventTimes = serverEventTimesSnapshot;
      this.outputAudioTimes = outputAudioTimesSnapshot;
      this.transactionEvents = null;
      this.transactionEffects = null;
      this.transactionMeaningfulMembers = 0;
      this.transactionDecodedBytes = 0;
      this.decodedAudioBytesThisEvent = 0;
      throw error;
    }
  }

  private handleServerContent(
    content: NonNullable<LiveServerMessage["serverContent"]>,
  ): void {
    if (!isRecord(content) || !hasOnlyKeys(content, SERVER_CONTENT_KEYS)) {
      this.malformed();
      return;
    }
    // Gemini's Developer API can serialize a serverContent envelope with all
    // optional protobuf fields omitted. Treat that exact shape as a bounded,
    // rate-limited provider no-op; empty top-level messages still fail closed.
    if (Object.keys(content).length === 0) {
      this.markMeaningful();
      return;
    }
    this.malformedStage = "server_content_metadata";
    for (const field of ["groundingMetadata", "urlContextMetadata"] as const) {
      if (content[field] === undefined) continue;
      const bytes = boundedJsonBytes(
        content[field],
        MAX_IGNORED_METADATA_BYTES,
      );
      if (bytes === null) this.malformed();
      this.chargeDecodedBytes(bytes ?? 0);
      this.markMeaningful();
    }
    this.malformedStage = "server_content_reason";
    if (content.turnCompleteReason !== undefined) {
      if (
        typeof content.turnCompleteReason !== "string" ||
        utf8Bytes(content.turnCompleteReason) > MAX_TURN_COMPLETE_REASON_BYTES
      ) {
        this.malformed();
      }
      this.chargeDecodedBytes(
        typeof content.turnCompleteReason === "string"
          ? utf8Bytes(content.turnCompleteReason)
          : 0,
      );
      this.markMeaningful();
    }
    this.malformedStage = "server_content_interrupted";
    if (
      content.interrupted !== undefined &&
      typeof content.interrupted !== "boolean"
    )
      this.malformed();
    if (content.interrupted !== undefined) this.markMeaningful();
    if (content.interrupted === true) {
      this.emit({ type: "playback_flush" });
    }
    const modelTurn = content.modelTurn;
    if (modelTurn !== undefined) {
      this.malformedStage = "server_content_model_turn";
      if (
        !isRecord(modelTurn) ||
        !hasOnlyKeys(modelTurn, MODEL_TURN_KEYS) ||
        (modelTurn.role !== undefined && modelTurn.role !== "model")
      ) {
        this.malformed();
      } else {
        const parts = modelTurn.parts;
        if (
          !Array.isArray(parts) ||
          parts.length === 0 ||
          parts.length > MAX_SERVER_PARTS
        ) {
          this.malformed();
        } else {
          this.markMeaningful();
          for (const part of parts) this.handleServerPart(part);
        }
      }
    }
    this.handleCaption("input", content.interimInputTranscription, false);
    this.handleCaption("input", content.inputTranscription, true);
    this.handleCaption("output", content.outputTranscription, true);
    this.malformedStage = "server_content_completion_flags";
    for (const field of [
      "generationComplete",
      "turnComplete",
      "waitingForInput",
    ] as const) {
      if (content[field] === undefined) continue;
      if (typeof content[field] !== "boolean") this.malformed();
      this.markMeaningful();
    }
    this.malformedStage = "server_content_interaction_status";
    if (
      content.interactionStatus !== undefined &&
      (content.turnComplete !== true ||
        typeof content.interactionStatus !== "string" ||
        !INTERACTION_STATUSES.has(content.interactionStatus))
    ) {
      this.malformed(
        interactionStatusDiagnostic(
          content.turnComplete,
          content.interactionStatus,
        ),
      );
    }
    if (content.generationComplete === true) {
      this.emit({ type: "turn", state: "generation_complete" });
    }
    if (content.turnComplete === true) {
      this.emit({ type: "turn", state: "turn_complete" });
    }
    if (content.waitingForInput === true) {
      this.emit({ type: "turn", state: "waiting" });
    }
  }

  private handleServerPart(part: unknown): void {
    this.malformedStage = "server_part";
    if (!isRecord(part) || !hasOnlyKeys(part, SERVER_PART_KEYS)) {
      this.malformed();
      return;
    }
    const hasText = part.text !== undefined;
    const hasInlineData = part.inlineData !== undefined;
    if (Number(hasText) + Number(hasInlineData) !== 1) {
      this.malformed();
      return;
    }
    if (part.thought !== undefined && typeof part.thought !== "boolean") {
      this.malformed();
      return;
    }
    if (
      part.thoughtSignature !== undefined &&
      (typeof part.thoughtSignature !== "string" ||
        part.thoughtSignature.length === 0 ||
        utf8Bytes(part.thoughtSignature) > MAX_IGNORED_METADATA_BYTES)
    ) {
      this.malformed();
      return;
    }
    if (typeof part.thoughtSignature === "string")
      this.chargeDecodedBytes(utf8Bytes(part.thoughtSignature));
    for (const field of SERVER_PART_IGNORED_METADATA_KEYS) {
      if (part[field] === undefined) continue;
      const bytes = boundedJsonBytes(part[field], MAX_IGNORED_METADATA_BYTES);
      if (bytes === null) {
        this.malformed();
        return;
      }
      this.chargeDecodedBytes(bytes);
    }
    if (hasText) {
      if (
        typeof part.text !== "string" ||
        (part.text.length === 0 &&
          !(
            typeof part.thoughtSignature === "string" &&
            part.thoughtSignature.length > 0
          )) ||
        utf8Bytes(part.text) > MAX_TEXT_BYTES
      ) {
        this.malformed();
        return;
      }
      this.chargeDecodedBytes(utf8Bytes(part.text));
      if (part.thought === true || part.text.length === 0) return;
      this.emit({ type: "model_text", text: part.text });
      return;
    }
    if (
      !isRecord(part.inlineData) ||
      !hasOnlyKeys(part.inlineData, INLINE_DATA_KEYS)
    ) {
      this.malformed();
      return;
    }
    if (
      part.inlineData.displayName !== undefined &&
      !boundedOptionalString(
        part.inlineData.displayName,
        MAX_PROVIDER_IDENTIFIER_BYTES,
      )
    ) {
      this.malformed();
      return;
    }
    if (typeof part.inlineData.displayName === "string")
      this.chargeDecodedBytes(utf8Bytes(part.inlineData.displayName));
    if (
      part.inlineData.mimeType !==
      `audio/pcm;rate=${GEMINI_LIVE_OUTPUT_SAMPLE_RATE}`
    ) {
      this.malformed();
      return;
    }
    const pcm = decodeBase64(
      part.inlineData.data,
      MAX_OUTPUT_AUDIO_BYTES_PER_PART,
    );
    if (!pcm || pcm.byteLength % GEMINI_LIVE_PCM_BYTES_PER_SAMPLE !== 0) {
      this.malformed();
      return;
    }
    this.chargeDecodedBytes(pcm.byteLength);
    if (part.thought === true) return;
    this.chargeOutputAudio(pcm.byteLength);
    for (
      let offset = 0;
      offset < pcm.byteLength;
      offset += GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES
    ) {
      this.emit({
        type: "audio",
        pcm: pcm.slice(
          offset,
          offset + GEMINI_LIVE_MAX_RENDERER_AUDIO_CHUNK_BYTES,
        ),
        sampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
      });
    }
  }

  private handleCaption(
    direction: "input" | "output",
    value: unknown,
    defaultFinal: boolean,
  ): void {
    if (value === undefined) return;
    this.malformedStage = "transcription";
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, TRANSCRIPTION_KEYS) ||
      (value.text !== undefined &&
        (typeof value.text !== "string" ||
          utf8Bytes(value.text) > MAX_TEXT_BYTES))
    ) {
      this.malformed();
      return;
    }
    if (value.finished !== undefined && typeof value.finished !== "boolean") {
      this.malformed();
      return;
    }
    for (const field of ["languageCode", "speakerLabel"] as const) {
      if (
        value[field] !== undefined &&
        (typeof value[field] !== "string" ||
          utf8Bytes(value[field]) > MAX_PROVIDER_IDENTIFIER_BYTES)
      ) {
        this.malformed();
        return;
      }
      if (typeof value[field] === "string")
        this.chargeDecodedBytes(utf8Bytes(value[field]));
    }
    if (value.words !== undefined) {
      if (
        !Array.isArray(value.words) ||
        value.words.length > MAX_TRANSCRIPTION_WORDS ||
        value.words.some(
          (word) =>
            !isRecord(word) ||
            !hasOnlyKeys(word, WORD_INFO_KEYS) ||
            !boundedOptionalString(word.word, MAX_PROVIDER_IDENTIFIER_BYTES) ||
            !validDuration(word.startOffset) ||
            !validDuration(word.endOffset),
        )
      ) {
        this.malformed();
        return;
      }
      const bytes = boundedJsonBytes(value.words, MAX_IGNORED_METADATA_BYTES);
      if (bytes === null) this.malformed();
      this.chargeDecodedBytes(bytes ?? 0);
    }
    const text = typeof value.text === "string" ? value.text : "";
    this.markMeaningful();
    this.chargeDecodedBytes(utf8Bytes(text));
    if (text.length > 0) {
      this.emit({
        type: "caption",
        direction,
        final:
          typeof value.finished === "boolean" ? value.finished : defaultFinal,
        text,
      });
    }
  }

  private handleToolCalls(value: unknown): void {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, TOOL_CALL_KEYS) ||
      !Array.isArray(value.functionCalls)
    ) {
      this.malformed();
      return;
    }
    if (
      value.functionCalls.length === 0 ||
      value.functionCalls.length > MAX_TOOL_CALLS_PER_EVENT
    ) {
      this.malformed();
      return;
    }
    this.markMeaningful();
    for (const call of value.functionCalls) {
      if (
        !isRecord(call) ||
        !hasOnlyKeys(call, FUNCTION_CALL_KEYS) ||
        !validToolIdentity(call.id, call.name) ||
        !isRecord(call.args)
      ) {
        this.malformed();
        continue;
      }
      const safeArgs = cloneJsonRecord(call.args, MAX_TOOL_ARGUMENT_BYTES);
      if (!safeArgs) {
        this.malformed();
        continue;
      }
      this.chargeDecodedBytes(
        utf8Bytes(call.id) +
          utf8Bytes(call.name as string) +
          utf8Bytes(JSON.stringify(safeArgs)),
      );
      const id = call.id;
      const name = call.name as string;
      const existing = this.toolCalls.get(id);
      if (existing) {
        if (existing.name !== name) this.malformed();
        continue;
      }
      if (this.toolCalls.size >= GEMINI_LIVE_MAX_SESSION_TOOL_CALL_IDS) {
        throw new GeminiLiveProtocolFailure("provider_rate_limit");
      }
      this.toolCalls.set(id, { name, status: "issued" });
      this.emit({ type: "function_call", id, name, args: safeArgs });
    }
  }

  private handleToolCallCancellation(value: unknown): void {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, TOOL_CANCELLATION_KEYS) ||
      !Array.isArray(value.ids) ||
      value.ids.length === 0 ||
      value.ids.length > MAX_TOOL_CALLS_PER_EVENT
    ) {
      this.malformed();
      return;
    }
    this.markMeaningful();
    for (const id of value.ids) {
      if (typeof id !== "string" || !TOOL_CALL_ID_PATTERN.test(id)) {
        this.malformed();
      } else {
        this.chargeDecodedBytes(utf8Bytes(id));
        const call = this.toolCalls.get(id);
        if (!call) {
          this.malformed();
          continue;
        }
        if (call.status !== "issued") continue;
        call.status = "cancelled";
        this.emit({ type: "function_cancel", id });
      }
    }
  }

  private handleUsage(value: unknown): void {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, USAGE_KEYS) ||
      Object.keys(value).length === 0
    ) {
      this.malformed();
      return;
    }
    const metadataBytes = boundedJsonBytes(value, MAX_IGNORED_METADATA_BYTES);
    if (metadataBytes === null) {
      this.malformed();
      return;
    }
    this.markMeaningful();
    this.chargeDecodedBytes(metadataBytes);
    const promptTokens = finiteCount(value.promptTokenCount);
    const responseTokens = finiteCount(value.responseTokenCount);
    const totalTokens = finiteCount(value.totalTokenCount);
    if (
      promptTokens === null ||
      responseTokens === null ||
      totalTokens === null
    ) {
      this.malformed();
      return;
    }
    this.emit({
      type: "usage",
      promptTokens,
      responseTokens,
      totalTokens,
    });
  }

  private handleResumptionUpdate(value: unknown): void {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, RESUMPTION_KEYS) ||
      typeof value.resumable !== "boolean" ||
      (!value.resumable &&
        value.newHandle !== undefined &&
        value.newHandle !== "")
    ) {
      this.malformed();
      return;
    }
    if (
      value.lastConsumedClientMessageIndex !== undefined &&
      (typeof value.lastConsumedClientMessageIndex !== "string" ||
        utf8Bytes(value.lastConsumedClientMessageIndex) >
          MAX_PROVIDER_IDENTIFIER_BYTES)
    ) {
      this.malformed();
      return;
    }
    if (typeof value.lastConsumedClientMessageIndex === "string")
      this.chargeDecodedBytes(utf8Bytes(value.lastConsumedClientMessageIndex));
    if (value.resumable) {
      if (
        typeof value.newHandle !== "string" ||
        value.newHandle.length === 0 ||
        utf8Bytes(value.newHandle) > MAX_RESUMPTION_HANDLE_BYTES
      ) {
        this.malformed();
        return;
      }
      this.chargeDecodedBytes(utf8Bytes(value.newHandle));
      this.resumptionHandle = value.newHandle;
    } else {
      this.resumptionHandle = null;
    }
    this.markMeaningful();
    this.emit({ type: "resumption", resumable: value.resumable });
  }

  private handleGoAway(value: unknown): void {
    if (!isRecord(value) || !hasOnlyKeys(value, GO_AWAY_KEYS)) {
      this.malformed();
      return;
    }
    const timeLeft = value.timeLeft;
    if (
      timeLeft !== undefined &&
      (typeof timeLeft !== "string" || !DURATION_PATTERN.test(timeLeft))
    ) {
      this.malformed();
      return;
    }
    if (typeof timeLeft === "string")
      this.chargeDecodedBytes(utf8Bytes(timeLeft));
    this.markMeaningful();
    this.emit({
      type: "go_away",
      ...(typeof timeLeft === "string" ? { timeLeft } : {}),
    });
    const handle = this.resumptionHandle;
    this.deferTransactionEffect(() => {
      if (this.resumptionInFlight) return;
      if (!handle) {
        this.emitError("resumption_unavailable");
        this.emit({
          type: "reconnect_required",
          reason: "resumption_unavailable",
        });
        this.stopForDisconnect("failed");
        return;
      }
      this.resumptionInFlight = true;
      queueMicrotask(() => void this.resumeAfterGoAway(handle));
    });
  }

  private async resumeAfterGoAway(handle: string): Promise<void> {
    if (this.phase !== "open") {
      this.resumptionInFlight = false;
      return;
    }
    const oldWire = this.wire;
    this.wire = null;
    this.generation += 1;
    this.attemptController?.abort();
    this.attemptController = null;
    this.clearIdleTimer();
    try {
      oldWire?.close();
    } catch {
      // The new connection is still fenced by its resumption handle.
    }
    try {
      await this.openConnection(handle, "resuming");
    } catch {
      if (!this.isClosed()) {
        this.emit({ type: "reconnect_required", reason: "resume_failed" });
      }
    } finally {
      this.resumptionInFlight = false;
    }
  }

  private sendFrameNow(frame: Uint8Array): void {
    this.requireOpenAndSeeded();
    this.dispatch(() =>
      this.wire!.sendRealtimeInput({
        video: {
          data: Buffer.from(frame).toString("base64"),
          mimeType: "image/jpeg",
        },
      }),
    );
    this.lastFrameAt = this.clock.now();
  }

  private requireOpen(): void {
    if (this.phase !== "open" || !this.wire)
      throw new Error("Live connection is not open.");
  }

  private isClosed(): boolean {
    return this.phase === "closed";
  }

  private dispatch(operation: () => void): void {
    try {
      operation();
    } catch {
      this.failTransport("transport_error");
      throw new GeminiLiveProtocolFailure("transport_error");
    }
  }

  private requireOpenAndSeeded(): void {
    this.requireOpen();
    if (!this.seeded)
      throw new Error("Live history must be seeded before realtime input.");
  }

  private touchProviderActivity(): void {
    if (this.phase !== "open") return;
    this.lastProviderActivityAt = this.clock.now();
    this.armIdleDeadline();
  }

  private admitServerEvent(): void {
    const now = this.clock.now();
    this.serverEventTimes = this.serverEventTimes.filter(
      (time) => time > now - 1_000,
    );
    if (this.serverEventTimes.length >= MAX_SERVER_EVENTS_PER_SECOND) {
      throw new GeminiLiveProtocolFailure("provider_rate_limit");
    }
    this.serverEventTimes.push(now);
  }

  private chargeOutputAudio(bytes: number): void {
    this.decodedAudioBytesThisEvent += bytes;
    if (this.decodedAudioBytesThisEvent > MAX_OUTPUT_AUDIO_BYTES_PER_EVENT) {
      throw new GeminiLiveProtocolFailure("provider_rate_limit");
    }
    const now = this.clock.now();
    this.outputAudioTimes = this.outputAudioTimes.filter(
      (entry) => entry.at > now - 1_000,
    );
    const recentBytes = this.outputAudioTimes.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    if (recentBytes + bytes > MAX_OUTPUT_AUDIO_BYTES_PER_SECOND) {
      throw new GeminiLiveProtocolFailure("provider_rate_limit");
    }
    this.outputAudioTimes.push({ at: now, bytes });
  }

  private chargeDecodedBytes(bytes: number): void {
    this.transactionDecodedBytes += bytes;
    if (this.transactionDecodedBytes > MAX_DECODED_SERVER_EVENT_BYTES) {
      throw new GeminiLiveProtocolFailure("provider_rate_limit");
    }
  }

  private markMeaningful(): void {
    this.transactionMeaningfulMembers += 1;
  }

  private deferTransactionEffect(effect: () => void): void {
    if (!this.transactionEffects)
      throw new Error("Live event transaction is unavailable.");
    this.transactionEffects.push(effect);
  }

  private armIdleDeadline(): void {
    this.clearIdleTimer();
    if (this.phase !== "open") return;
    const elapsed = Math.max(0, this.clock.now() - this.lastProviderActivityAt);
    this.idleTimer = this.clock.setTimeout(
      () => {
        this.idleTimer = null;
        if (this.phase !== "open") return;
        if (
          this.clock.now() - this.lastProviderActivityAt <
          this.idleTimeoutMs
        ) {
          this.armIdleDeadline();
          return;
        }
        this.emitError("idle_timeout");
        this.stopForDisconnect("failed");
      },
      Math.max(1, this.idleTimeoutMs - elapsed),
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearTimersAndQueues(): void {
    this.clearIdleTimer();
    if (this.frameTimer !== null) this.clock.clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.pendingFrame = null;
    this.audioPackets = [];
    this.serverEventTimes = [];
    this.outputAudioTimes = [];
    this.decodedAudioBytesThisEvent = 0;
    this.transactionDecodedBytes = 0;
  }

  private unexpectedDisconnect(): void {
    this.emitError("unexpected_disconnect");
    this.emit({ type: "reconnect_required", reason: "unexpected_disconnect" });
    this.stopForDisconnect("disconnected");
  }

  private failTransport(
    code: GeminiLiveProtocolErrorCode,
    diagnostic?: GeminiLiveMalformedStage,
    diagnosticDetail?: GeminiLiveProtocolDiagnosticDetail,
  ): void {
    if (
      this.phase === "closed" ||
      this.phase === "failed" ||
      this.phase === "disconnected"
    )
      return;
    this.emitError(code, diagnostic, diagnosticDetail);
    this.stopForDisconnect("failed");
  }

  private stopForDisconnect(state: "disconnected" | "failed"): void {
    this.generation += 1;
    this.attemptController?.abort();
    this.attemptController = null;
    this.clearTimersAndQueues();
    const wire = this.wire;
    this.wire = null;
    try {
      wire?.close();
    } catch {
      // Authority and queues are already revoked.
    }
    this.removeParentAbort?.();
    this.removeParentAbort = null;
    this.setState(state);
  }

  private malformed(
    diagnosticDetail?: GeminiLiveProtocolDiagnosticDetail,
  ): void {
    throw new GeminiLiveProtocolFailure(
      "malformed_server_event",
      this.malformedStage,
      diagnosticDetail,
    );
  }

  private emitError(
    code: GeminiLiveProtocolErrorCode,
    diagnostic?: GeminiLiveMalformedStage,
    diagnosticDetail?: GeminiLiveProtocolDiagnosticDetail,
  ): void {
    this.emit({
      type: "error",
      code,
      message: SAFE_ERROR_MESSAGES[code],
      ...(diagnostic ? { diagnostic } : {}),
      ...(diagnosticDetail ? { diagnosticDetail } : {}),
    });
  }

  private setState(state: GeminiLiveProtocolState): void {
    if (this.phase === state) return;
    this.phase = state;
    this.emit({ type: "state", state });
  }

  private emit(event: GeminiLiveProtocolEvent): void {
    if (this.transactionEvents) {
      this.transactionEvents.push(event);
      return;
    }
    try {
      this.options.onEvent(event);
    } catch {
      // Renderer/event consumers cannot corrupt the protocol state machine.
    }
  }
}
