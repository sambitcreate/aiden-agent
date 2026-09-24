// TTS application service: main-owned orchestration for read aloud.
//
// Owns job arbitration, source freshness, settings snapshots, and audio
// retention. The provider adapter knows Google's wire format; this service
// knows Aiden's chat identities and permissions; the renderer player knows
// playback. Start generations and terminal checks fence async continuations
// so late events can never resurrect a cancelled job.

import { randomUUID } from "node:crypto";
import {
  TTS_LIMITS,
  TTS_PREVIEW_SENTENCE,
  normalizeTtsSettings,
  parseTtsSettingsPatch,
  type TtsJobPhase,
  type TtsJobSnapshot,
  type TtsSafeError,
  type TtsServiceEvent,
  type TtsSettingsV1,
  type TtsStartRequest,
  type TtsSourceRef,
} from "../../../renderer/shared/tts.js";
import {
  classifyTtsProviderError,
  TtsWireError,
  buildTtsInteractionBody,
  TTS_STARTER_PREBUILT_VOICES,
  type TtsInteractionBody,
  type TtsUnarySynthesisResult,
  type TtsVoicesPage,
} from "./gemini-wire.js";
import { prepareSpeechText, SpeechTextError } from "./speech-text.js";
import {
  revalidateTtsSource,
  resolveLatestTtsSource,
  type TtsSourceDeps,
  type TtsLatestSourceProjection,
} from "./source.js";
import {
  resolveTtsCredential,
  type TtsCredentialDeps,
  type TtsCredentialResolution,
} from "./credentials.js";
import { TtsAudioStore } from "./audio-store.js";

type ReadyTtsCredential = Extract<TtsCredentialResolution, { status: "ready" }>;

export const TTS_DEFAULT_PROVIDER_VOICE = "Kore";

export interface TtsProviderPort {
  synthesize(input: {
    apiKey: string;
    body: TtsInteractionBody;
    signal?: AbortSignal;
  }): Promise<TtsUnarySynthesisResult>;
  listVoices(input: { apiKey: string; pageToken?: string }): Promise<TtsVoicesPage>;
}

export interface TtsConfigPort {
  getTtsSettings(): Promise<{ settings: TtsSettingsV1; revision: string }>;
  updateTtsSettings(
    mutation: (current: TtsSettingsV1) => TtsSettingsV1,
    isCurrent?: () => boolean,
  ): Promise<{ settings: TtsSettingsV1; revision: string }>;
}

export interface TtsOwner {
  /** Active renderer document; assigned by main, never by request fields. */
  documentId: string;
  isDestroyed(): boolean;
  onInvalidated(callback: () => void): () => void;
}

export interface TtsUsageReport {
  kind: "read-aloud" | "preview";
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** False when usage was not reported by the provider. */
  usageKnown: boolean;
}

export interface TtsServiceDeps {
  config: TtsConfigPort;
  credentials: TtsCredentialDeps;
  source: TtsSourceDeps;
  provider: TtsProviderPort;
  emit(event: TtsServiceEvent): void;
  recordUsage?(report: TtsUsageReport): void;
  clock: {
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

function safeError(
  code: TtsSafeError["code"],
  message: string,
  retryable = false,
  generationMayHaveBeenBilled = false,
): TtsSafeError {
  return { code, message, retryable, generationMayHaveBeenBilled };
}

function wireToSafeError(error: unknown): TtsSafeError {
  const wire = error instanceof TtsWireError ? error : classifyTtsProviderError(error);
  return {
    code: wire.code,
    message: wire.message,
    retryable: wire.retryable,
    generationMayHaveBeenBilled: wire.generationMayHaveBeenBilled,
  };
}

class TtsJob {
  readonly id: string;
  readonly kind: "read-aloud" | "preview";
  readonly chatId: string | null;
  readonly ownerDocumentId: string;
  phase: TtsJobPhase = "preparing";
  totalSegments = 0;
  readySegments = 0;
  readonly segments: string[] = [];
  readonly omissions: readonly string[];
  error: TtsSafeError | null = null;
  source: TtsSourceRef | null = null;
  releaseOwner: () => void = () => undefined;
  clearRequestTimeout: () => void = () => undefined;
  clearPauseTimeout: () => void = () => undefined;
  nextSegmentToSynthesize = 0;
  paused = false;
  private resumeWaiters: Array<() => void> = [];
  private readonly controller = new AbortController();

  constructor(input: {
    kind: "read-aloud" | "preview";
    chatId: string | null;
    owner: TtsOwner;
    omissions: readonly string[];
  }) {
    this.id = randomUUID();
    this.kind = input.kind;
    this.chatId = input.chatId;
    this.ownerDocumentId = input.owner.documentId;
    this.omissions = input.omissions;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): void {
    this.controller.abort();
  }

  terminal(): boolean {
    return this.phase === "completed" || this.phase === "cancelled" || this.phase === "failed";
  }

  /** Pause-halt primitive: parks dispatch until resume or termination. */
  waitWhilePaused(): Promise<void> {
    if (!this.paused || this.terminal()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve);
    });
  }

  wakePaused(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  dispose(): void {
    this.clearRequestTimeout();
    this.clearPauseTimeout();
    this.releaseOwner();
    this.wakePaused();
    this.controller.abort();
  }

  snapshot(): TtsJobSnapshot {
    return {
      jobId: this.id,
      chatId: this.chatId,
      kind: this.kind,
      phase: this.phase,
      totalSegments: this.totalSegments,
      readySegments: this.readySegments,
      omissions: this.omissions,
      error: this.error,
    };
  }
}

export function createTtsService(deps: TtsServiceDeps) {
  const audioStore = new TtsAudioStore();
  let activeJob: TtsJob | null = null;
  let startEpoch = 0;
  let releasePendingOwner: (() => void) | null = null;
  let settingsQueue: Promise<unknown> = Promise.resolve();
  // Keep accepted intent IDs until document invalidation, including failures
  // and cancellations. A duplicate delivery must never create another charge.
  const startsByDocument = new Map<
    string,
    Map<
      string,
      {
        fingerprint: string;
        promise: Promise<TtsJobSnapshot>;
      }
    >
  >();

  function emitJob(job: TtsJob): void {
    deps.emit({ kind: "job", snapshot: job.snapshot() });
  }

  function terminateJob(
    job: TtsJob,
    phase: "cancelled" | "failed",
    error: TtsSafeError | null,
  ): void {
    if (job.phase === "cancelled" || job.phase === "failed") return;
    job.clearRequestTimeout();
    job.clearPauseTimeout();
    job.phase = phase;
    job.error = phase === "failed" ? error : null;
    job.abort();
    job.wakePaused();
    emitJob(job);
  }

  /** One active job across the app: starting a new one stops the old. */
  function cancelActiveJob(reason: "replaced" | "stopped"): void {
    const job = activeJob;
    if (!job) return;
    activeJob = null;
    audioStore.releaseJob(job.id);
    terminateJob(job, "cancelled", null);
    job.dispose();
    if (reason === "stopped") deps.emit({ kind: "status" });
  }

  function revokeStarts(): void {
    startEpoch += 1;
    releasePendingOwner?.();
    releasePendingOwner = null;
  }

  function reserveStart(owner: TtsOwner) {
    revokeStarts();
    cancelActiveJob("replaced");
    const epoch = startEpoch;
    let invalidated = false;
    const release = owner.onInvalidated(() => {
      invalidated = true;
      if (epoch !== startEpoch) return;
      revokeStarts();
      cancelActiveJob("stopped");
    });
    releasePendingOwner = release;
    const assertCurrent = () => {
      if (invalidated || owner.isDestroyed() || epoch !== startEpoch) {
        throw new TtsStartError(safeError("owner_invalidated", "Speech request was cancelled."));
      }
    };
    return {
      assertCurrent,
      attach(job: TtsJob) {
        assertCurrent();
        releasePendingOwner = null;
        job.releaseOwner = release;
        activeJob = job;
      },
      release() {
        release();
        if (releasePendingOwner === release) releasePendingOwner = null;
      },
    };
  }

  async function resolveCredentialAndSettings(): Promise<
    | { ok: true; settings: TtsSettingsV1; revision: string; credential: ReadyTtsCredential }
    | { ok: false; error: TtsSafeError }
  > {
    const { settings, revision } = await deps.config.getTtsSettings();
    if (!settings.enabled) {
      return { ok: false, error: safeError("setup_required", "Read aloud is not set up.") };
    }
    let credential: TtsCredentialResolution;
    try {
      credential = await resolveTtsCredential(deps.credentials, settings);
    } catch {
      return {
        ok: false,
        error: safeError("secure_storage_unavailable", "Secure storage is unavailable."),
      };
    }
    if (credential.status === "secure_storage_unavailable") {
      return {
        ok: false,
        error: safeError("secure_storage_unavailable", "Secure storage is unavailable."),
      };
    }
    if (credential.status !== "ready") {
      return {
        ok: false,
        error: safeError("setup_required", "Read aloud needs a Google API key."),
      };
    }
    return { ok: true, settings, revision, credential };
  }

  function resolveProviderVoice(settings: TtsSettingsV1): string {
    const voice = settings.selectedVoice;
    if (!voice) return TTS_DEFAULT_PROVIDER_VOICE;
    if (
      voice.kind !== "prebuilt" ||
      !TTS_STARTER_PREBUILT_VOICES.some(
        (candidate) => candidate.providerVoiceId === voice.localVoiceId,
      )
    ) {
      throw new TtsStartError(
        safeError("voice_unavailable", "Choose an available prebuilt voice."),
      );
    }
    return voice.localVoiceId;
  }

  function deliveryStyle(settings: TtsSettingsV1): string {
    const preset = settings.delivery.preset;
    const base =
      preset === "conversational"
        ? "conversational, warm delivery"
        : preset === "calm"
          ? "calm, unhurried delivery"
          : "";
    const note = settings.delivery.note.trim();
    if (base && note) return `${base}; ${note}`;
    return note || base;
  }

  /**
   * Sequential, lossless segment pipeline. At most one provider request is in
   * flight; source freshness is revalidated before every dispatch; every
   * continuation is epoch-fenced.
   */
  async function runJob(
    job: TtsJob,
    input: { apiKey: string; model: TtsSettingsV1["model"]; voice: string; style: string },
  ): Promise<void> {
    const run = async (): Promise<void> => {
      while (!job.terminal() && job.nextSegmentToSynthesize < job.segments.length) {
        while (job.paused && !job.terminal()) await job.waitWhilePaused();
        if (job.terminal()) return;
        if (job.source) {
          try {
            await revalidateTtsSource(deps.source, job.source);
          } catch (error) {
            if (!job.terminal()) terminateJob(job, "failed", sourceErrorToSafe(error));
            return;
          }
        }
        if (job.terminal() || job.signal.aborted) return;
        // A pause may have arrived during source revalidation.
        if (job.paused) continue;
        const segment = job.segments[job.nextSegmentToSynthesize]!;
        const segmentIndex = job.nextSegmentToSynthesize;
        job.phase = "generating";
        emitJob(job);
        // Per-segment request lifetime: pauses do not consume this budget.
        const timeoutHandle = deps.clock.setTimeout(() => {
          if (!job.terminal()) {
            terminateJob(
              job,
              "failed",
              safeError("network", "Speech generation timed out.", true, true),
            );
          }
        }, TTS_LIMITS.requestTimeoutMs);
        job.clearRequestTimeout = () => deps.clock.clearTimeout(timeoutHandle);
        try {
          const audio = await deps.provider.synthesize({
            apiKey: input.apiKey,
            body: buildTtsInteractionBody({
              model: input.model,
              transcript: segment,
              voice: input.voice,
              style: input.style,
            }),
            signal: job.signal,
          });
          if (job.terminal()) return;
          try {
            audioStore.put(job.id, segmentIndex, audio.audio);
          } catch {
            // Bounded retention: fail visibly instead of dropping audio.
            const limit = safeError(
              "audio_buffer_limit",
              "Playback fell too far behind to keep this response's audio.",
              false,
              true,
            );
            terminateJob(job, "failed", limit);
            return;
          }
          job.readySegments = segmentIndex + 1;
          job.nextSegmentToSynthesize += 1;
          if (!job.paused) job.phase = "buffering";
          emitJob(job);
          // Report usage once per billed generation, never for replay.
          deps.recordUsage?.({
            kind: job.kind,
            model: input.model,
            inputTokens: audio.usage.inputTokens,
            outputTokens: audio.usage.outputTokens,
            usageKnown: audio.usage.inputTokens !== null || audio.usage.outputTokens !== null,
          });
        } catch (error) {
          if (job.terminal()) return;
          if (job.signal.aborted) {
            // Timeout abort (user cancellation terminates first): fail the
            // job explicitly so it can never hang in a non-terminal phase.
            terminateJob(
              job,
              "failed",
              safeError("network", "Speech generation timed out.", true, true),
            );
            return;
          }
          const safe = wireToSafeError(error);
          terminateJob(job, "failed", safe);
          return;
        } finally {
          job.clearRequestTimeout();
        }
        // Pause halts future segment dispatch; an in-flight request was
        // allowed to complete and is retained above. Resume wakes this wait.
        while (job.paused && !job.terminal()) {
          await job.waitWhilePaused();
        }
      }
      if (job.terminal()) return;
      if (job.readySegments >= job.segments.length) {
        job.clearPauseTimeout();
        job.phase = "completed";
        emitJob(job);
      }
    };
    await run().catch((error: unknown) => {
      if (!job.terminal()) {
        terminateJob(job, "failed", wireToSafeError(error));
      }
    });
  }

  async function startReadAloud(
    owner: TtsOwner,
    request: TtsStartRequest,
  ): Promise<TtsJobSnapshot> {
    const reservation = reserveStart(owner);
    try {
      const resolved = await resolveCredentialAndSettings();
      if (!resolved.ok) {
        throw new TtsStartError(resolved.error);
      }
      reservation.assertCurrent();
      const { settings } = resolved;
      const voice = resolveProviderVoice(settings);
      if (request.settingsRevision !== resolved.revision) {
        throw new TtsStartError(safeError("source_changed", "Speech settings changed; try again."));
      }
      // Source freshness is main-owned: the submitted reference is revalidated
      // against live chat state, never trusted from the renderer.
      const { content } = await revalidateTtsSource(deps.source, request.source).catch(
        (error: unknown) => {
          throw new TtsStartError(sourceErrorToSafe(error));
        },
      );
      reservation.assertCurrent();
      let preparation;
      try {
        preparation = prepareSpeechText({
          markdown: content,
          reading: settings.reading,
        });
      } catch (error) {
        if (error instanceof SpeechTextError) {
          throw new TtsStartError(safeError("response_too_large", error.message));
        }
        throw error;
      }
      if (!preparation) {
        throw new TtsStartError(
          safeError("response_incomplete", "There is nothing to read aloud."),
        );
      }
      const job = new TtsJob({
        kind: "read-aloud",
        chatId: request.source.chatId,
        owner,
        omissions: preparation.omissions,
      });
      job.source = request.source;
      job.segments.push(...preparation.segments);
      job.totalSegments = preparation.segments.length;
      reservation.attach(job);
      emitJob(job);
      void runJob(job, {
        apiKey: resolved.credential.apiKey,
        model: settings.model,
        voice,
        style: deliveryStyle(settings),
      });
      return job.snapshot();
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  return {
    audioStore,

    async status(
      owner: TtsOwner,
      chatId?: string,
    ): Promise<{
      settings: TtsSettingsV1;
      settingsRevision: string;
      credentialReady: boolean;
      credentialSourceLabel: string;
      synthesisReady: boolean;
      latestSource: TtsLatestSourceProjection;
      job: TtsJobSnapshot | null;
    }> {
      const { settings, revision } = await deps.config.getTtsSettings();
      let credentialReady = false;
      let credentialSourceLabel = "Not configured";
      try {
        const credential = await resolveTtsCredential(deps.credentials, settings);
        credentialReady = credential.status === "ready";
        credentialSourceLabel =
          credential.status === "ready" ? credential.sourceLabel : "Needs setup";
      } catch {
        credentialSourceLabel = "Secure storage unavailable";
      }
      const latestSource = chatId
        ? await resolveLatestTtsSource(deps.source, chatId)
        : { source: null, reason: "no_response" as const };
      const active = activeJob;
      return {
        settings,
        settingsRevision: revision,
        credentialReady,
        credentialSourceLabel,
        synthesisReady: settings.enabled && credentialReady,
        latestSource,
        job: active && active.ownerDocumentId === owner.documentId ? active.snapshot() : null,
      };
    },

    async updateSettings(
      owner: TtsOwner,
      expectedRevision: string,
      patch: unknown,
    ): Promise<{ settings: TtsSettingsV1; revision: string }> {
      const parsed = parseTtsSettingsPatch(patch);
      const update = settingsQueue.then(async () => {
        if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
        const { revision } = await deps.config.getTtsSettings();
        if (expectedRevision !== revision) {
          throw new Error("TTS settings changed elsewhere; reload and try again.");
        }
        const result = await deps.config.updateTtsSettings(
          (current) => normalizeTtsSettings({ ...current, ...parsed }),
          () => !owner.isDestroyed(),
        );
        revokeStarts();
        cancelActiveJob("stopped");
        deps.emit({ kind: "status" });
        return result;
      });
      settingsQueue = update.catch(() => undefined);
      return update;
    },

    async listStarterVoices(): Promise<typeof TTS_STARTER_PREBUILT_VOICES> {
      return TTS_STARTER_PREBUILT_VOICES;
    },

    async listProviderVoices(owner: TtsOwner, pageToken?: string): Promise<TtsVoicesPage> {
      const resolved = await resolveCredentialAndSettings();
      if (!resolved.ok) throw new Error(resolved.error.message);
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      try {
        return await deps.provider.listVoices({
          apiKey: resolved.credential.apiKey,
          ...(pageToken ? { pageToken } : {}),
        });
      } catch (error) {
        throw new Error(wireToSafeError(error).message);
      }
    },

    start(owner: TtsOwner, request: TtsStartRequest): Promise<TtsJobSnapshot> {
      if (owner.isDestroyed())
        return Promise.reject(
          new TtsStartError(safeError("owner_invalidated", "Speech request was cancelled.")),
        );
      let requests = startsByDocument.get(owner.documentId);
      if (!requests) {
        requests = new Map();
        startsByDocument.set(owner.documentId, requests);
        const ownedRequests = requests;
        let release = () => undefined as void;
        release = owner.onInvalidated(() => {
          if (startsByDocument.get(owner.documentId) === ownedRequests)
            startsByDocument.delete(owner.documentId);
          release();
        });
      }
      const fingerprint = JSON.stringify([request.source, request.settingsRevision]);
      const previous = requests.get(request.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return Promise.reject(
            new TtsStartError(safeError("source_changed", "Speech request identity changed.")),
          );
        }
        return previous.promise.then((snapshot) =>
          activeJob?.id === snapshot.jobId
            ? activeJob.snapshot()
            : { ...snapshot, phase: "cancelled", readySegments: 0 },
        );
      }
      // Fail closed at the bound instead of evicting an ID that could be retried.
      if (requests.size >= 1024) {
        return Promise.reject(
          new TtsStartError(
            safeError("quota", "Reopen this window before starting more speech requests."),
          ),
        );
      }
      const promise = startReadAloud(owner, request);
      requests.set(request.requestId, { fingerprint, promise });
      return promise;
    },

    async startPreview(owner: TtsOwner): Promise<TtsJobSnapshot> {
      const reservation = reserveStart(owner);
      try {
        const resolved = await resolveCredentialAndSettings();
        if (!resolved.ok) {
          throw new TtsStartError(resolved.error);
        }
        reservation.assertCurrent();
        const { settings } = resolved;
        const voice = resolveProviderVoice(settings);
        const job = new TtsJob({
          kind: "preview",
          chatId: null,
          owner,
          omissions: [],
        });
        job.segments.push(TTS_PREVIEW_SENTENCE.slice(0, TTS_LIMITS.previewMaxChars));
        job.totalSegments = 1;
        reservation.attach(job);
        emitJob(job);
        void runJob(job, {
          apiKey: resolved.credential.apiKey,
          model: settings.model,
          voice,
          style: deliveryStyle(settings),
        });
        return job.snapshot();
      } catch (error) {
        reservation.release();
        throw error;
      }
    },

    readAudio(owner: TtsOwner, jobId: string, segment: number, offset: number, maxBytes: number) {
      const job = activeJob;
      if (!job || job.id !== jobId || job.ownerDocumentId !== owner.documentId) {
        return null;
      }
      return audioStore.read(jobId, segment, offset, maxBytes);
    },

    stop(_owner: TtsOwner): void {
      revokeStarts();
      cancelActiveJob("stopped");
    },

    pause(owner: TtsOwner): TtsJobSnapshot | null {
      const job = activeJob;
      if (!job || job.terminal() || job.ownerDocumentId !== owner.documentId) return null;
      job.paused = true;
      job.clearPauseTimeout();
      const timer = deps.clock.setTimeout(() => {
        if (activeJob !== job) return;
        revokeStarts();
        cancelActiveJob("stopped");
      }, TTS_LIMITS.pausedJobExpiryMs);
      job.clearPauseTimeout = () => deps.clock.clearTimeout(timer);
      job.phase = "paused";
      emitJob(job);
      return job.snapshot();
    },

    resume(owner: TtsOwner): TtsJobSnapshot | null {
      const job = activeJob;
      if (!job || job.terminal() || job.ownerDocumentId !== owner.documentId) return null;
      job.paused = false;
      job.clearPauseTimeout();
      job.wakePaused();
      job.phase = job.readySegments >= job.segments.length ? "completed" : "buffering";
      emitJob(job);
      return job.snapshot();
    },

    clearCache(_owner: TtsOwner): void {
      revokeStarts();
      cancelActiveJob("stopped");
      audioStore.clear();
      deps.emit({ kind: "status" });
    },
  };
}

export class TtsStartError extends Error {
  constructor(readonly safe: TtsSafeError) {
    super(safe.message);
    this.name = "TtsStartError";
  }
}

function sourceErrorToSafe(error: unknown): TtsSafeError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("busy")) {
    return safeError("source_changed", "A new turn started in this chat.");
  }
  if (message.includes("chat_missing")) {
    return safeError("source_changed", "This chat is no longer available.");
  }
  if (message.includes("failed")) {
    return safeError("response_incomplete", "This response did not complete successfully.");
  }
  return safeError("source_changed", "The response changed before it could be read.");
}
