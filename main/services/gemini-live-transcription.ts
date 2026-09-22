import {
  AudioTranscriptionConfigMode,
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
  type UsageMetadata,
} from "@google/genai";
import { randomUUID } from "node:crypto";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import { configStore } from "./config-store.js";
import { providerRegistry } from "./provider-registry.js";
import { listProvidersWithLegacyPiCredentialMigration } from "./legacy-pi-credential-migration.js";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";
import { geminiTranscriptionTokens } from "./usage-accounting.js";
import { recordTranscription } from "./transcription.js";
import {
  bindOwnerInvalidation,
  decodePcm16Chunk,
  GeminiLiveFinalizationGate,
  GeminiLiveTranscriptAccumulator,
  waitForLiveStartup,
} from "./gemini-live-transcription-core.js";
import {
  GEMINI_LIVE_TRANSCRIPTION_MODEL,
  isGeminiLiveTranscriptionModel,
  resolveCloudVoiceModel,
} from "../../renderer/shared/voice-models.js";

const MAX_SESSION_BYTES = 16_000 * 2 * 60 * 10;
const STARTUP_TIMEOUT_MS = 10_000;
const FINALIZE_TIMEOUT_MS = 20_000;
const FINAL_SETTLE_MS = 1_000;

interface LiveRecord {
  id: string;
  ownerKey: string;
  owner: RendererDocumentOwner;
  session: Session;
  transcript: GeminiLiveTranscriptAccumulator;
  finalization: GeminiLiveFinalizationGate;
  provider: NonNullable<Awaited<ReturnType<typeof providerRegistry.selectionProvider>>>;
  totalBytes: number;
  finishing: boolean;
  settled: boolean;
  failure?: Error;
  resolve?: (text: string) => void;
  reject?: (error: Error) => void;
  finishTimer?: ReturnType<typeof setTimeout>;
  settleTimer?: ReturnType<typeof setTimeout>;
  removeOwnerInvalidation: () => void;
}

function ownerKey(owner: RendererDocumentOwner): string {
  return `${owner.id}:${owner.documentId}`;
}

function errorFromEvent(event: ErrorEvent | CloseEvent, fallback: string): Error {
  if ("error" in event && event.error instanceof Error) return event.error;
  return new Error(fallback);
}

class GeminiLiveTranscriptionManager {
  private readonly sessions = new Map<string, LiveRecord>();
  private readonly activeByOwner = new Map<string, string>();

  async start(owner: RendererDocumentOwner): Promise<{ sessionId: string }> {
    await listProvidersWithLegacyPiCredentialMigration();
    const settings = await configStore.getSettings();
    const selected = resolveCloudVoiceModel("gemini", settings.voiceModel);
    if (settings.voiceProvider !== "gemini" || !isGeminiLiveTranscriptionModel(selected)) {
      throw new Error("Select Gemini 3.5 Transcribe Live in Settings → Voice first.");
    }
    const auth = await providerRegistry.getBuiltinRequestAuth(GOOGLE_PROVIDER_ID);
    const key = auth?.auth.apiKey;
    if (!key) throw new Error("Set up Google Gemini in Settings → Providers to use voice input.");
    const provider = await providerRegistry.selectionProvider(GOOGLE_PROVIDER_ID);
    if (!provider) throw new Error("Google Gemini provider settings are unavailable.");

    const keyForOwner = ownerKey(owner);
    const previous = this.activeByOwner.get(keyForOwner);
    if (previous) this.cancelById(previous);

    const id = randomUUID();
    let record: LiveRecord | undefined;
    const ai = new GoogleGenAI({ apiKey: key });
    let rejectStartup = (_error: Error): void => {};
    const startupFailure = new Promise<never>((_resolve, reject) => {
      rejectStartup = reject;
    });
    let session: Session;
    try {
      session = await waitForLiveStartup(
        ai.live.connect({
          model: GEMINI_LIVE_TRANSCRIPTION_MODEL,
          config: {
            responseModalities: [Modality.TEXT],
            inputAudioTranscription: {
              languageCodes: [],
              mode: AudioTranscriptionConfigMode.VERBATIM,
            },
          },
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              if (record) this.onMessage(record, message);
            },
            onerror: (event: ErrorEvent) => {
              const error = errorFromEvent(event, "Gemini Live transcription failed.");
              if (record) this.onFailure(record, error);
              else rejectStartup(error);
            },
            onclose: (event: CloseEvent) => {
              const error = errorFromEvent(event, "Gemini Live transcription closed unexpectedly.");
              if (!record) {
                rejectStartup(error);
              } else if (!record.settled) {
                if (record.finishing && record.transcript.fullText()) void this.settle(record);
                else this.onFailure(record, error);
              }
            },
          },
        }),
        startupFailure,
        STARTUP_TIMEOUT_MS,
      );
    } catch (error) {
      await recordTranscription({
        provider,
        model: GEMINI_LIVE_TRANSCRIPTION_MODEL,
        status: "failed",
      });
      throw error;
    }

    record = {
      id,
      ownerKey: keyForOwner,
      owner,
      session,
      transcript: new GeminiLiveTranscriptAccumulator(),
      finalization: new GeminiLiveFinalizationGate(),
      provider,
      totalBytes: 0,
      finishing: false,
      settled: false,
      removeOwnerInvalidation: () => {},
    };
    const ownerBound = bindOwnerInvalidation(
      record,
      owner,
      () => {
        this.sessions.set(id, record!);
        this.activeByOwner.set(keyForOwner, id);
      },
      () => this.cancelById(id),
    );
    if (!ownerBound) {
      throw new Error("Gemini Live transcription document changed while connecting.");
    }
    return { sessionId: id };
  }

  push(owner: RendererDocumentOwner, sessionId: string, base64: unknown): void {
    const record = this.owned(owner, sessionId);
    if (record.finishing) throw new Error("Gemini Live transcription is already finalizing.");
    if (record.failure) throw record.failure;
    const bytes = decodePcm16Chunk(base64);
    record.totalBytes += bytes.length;
    if (record.totalBytes > MAX_SESSION_BYTES) {
      this.onFailure(record, new Error("Gemini Live transcription reached the 10-minute limit."));
      throw record.failure;
    }
    record.session.sendRealtimeInput({
      audio: { data: bytes.toString("base64"), mimeType: "audio/pcm;rate=16000" },
    });
  }

  async finish(owner: RendererDocumentOwner, sessionId: string): Promise<string> {
    const record = this.owned(owner, sessionId);
    if (record.failure) {
      this.cleanup(record);
      void recordTranscription({
        provider: record.provider,
        model: GEMINI_LIVE_TRANSCRIPTION_MODEL,
        status: "failed",
      });
      throw record.failure;
    }
    if (record.finishing) throw new Error("Gemini Live transcription is already finalizing.");
    record.finishing = true;
    const result = new Promise<string>((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    record.finishTimer = setTimeout(
      () =>
        this.onFailure(record, new Error("Gemini Live transcription timed out while finalizing.")),
      FINALIZE_TIMEOUT_MS,
    );
    try {
      record.session.sendRealtimeInput({ audioStreamEnd: true });
    } catch (error) {
      this.onFailure(record, error instanceof Error ? error : new Error(String(error)));
    }
    return result;
  }

  cancel(owner: RendererDocumentOwner, sessionId: string): void {
    this.owned(owner, sessionId);
    this.cancelById(sessionId);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.cancelById(id);
  }

  private owned(owner: RendererDocumentOwner, sessionId: string): LiveRecord {
    const record = this.sessions.get(sessionId);
    if (!record || record.ownerKey !== ownerKey(owner)) {
      throw new Error("Gemini Live transcription session is unavailable for this document.");
    }
    return record;
  }

  private onMessage(record: LiveRecord, message: LiveServerMessage): void {
    if (record.settled || record.owner.isDestroyed()) return;
    const update = record.transcript.consume(message);
    if (update.changed) {
      try {
        record.owner.send("voice:stream-text", { sessionId: record.id, ...update.snapshot });
      } catch {
        this.cancelById(record.id);
        return;
      }
    }
    if (record.finishing && record.finalization.observe(update)) {
      this.scheduleSettle(record);
    }
  }

  private scheduleSettle(record: LiveRecord): void {
    if (record.settleTimer) clearTimeout(record.settleTimer);
    record.settleTimer = setTimeout(() => void this.settle(record), FINAL_SETTLE_MS);
  }

  private async settle(record: LiveRecord): Promise<void> {
    if (record.settled) return;
    const text = record.transcript.fullText();
    record.settled = true;
    const resolve = record.resolve;
    this.cleanup(record);
    await recordTranscription({
      provider: record.provider,
      model: GEMINI_LIVE_TRANSCRIPTION_MODEL,
      status: "completed",
      tokens: geminiTranscriptionTokens(record.transcript.usage as UsageMetadata | undefined),
    }).catch(() => {
      // Usage persistence must never strand an otherwise completed dictation.
    });
    resolve?.(text);
  }

  private onFailure(record: LiveRecord, error: Error): void {
    if (record.settled) return;
    record.failure = error;
    if (!record.finishing) {
      try {
        record.session.close();
      } catch {
        /* best effort */
      }
      return;
    }
    record.settled = true;
    const reject = record.reject;
    this.cleanup(record);
    void recordTranscription({
      provider: record.provider,
      model: GEMINI_LIVE_TRANSCRIPTION_MODEL,
      status: "failed",
    });
    reject?.(error);
  }

  private cancelById(id: string): void {
    const record = this.sessions.get(id);
    if (!record) return;
    record.settled = true;
    const reject = record.reject;
    this.cleanup(record);
    reject?.(new Error("Gemini Live transcription was cancelled."));
  }

  private cleanup(record: LiveRecord): void {
    if (record.finishTimer) clearTimeout(record.finishTimer);
    if (record.settleTimer) clearTimeout(record.settleTimer);
    record.removeOwnerInvalidation();
    this.sessions.delete(record.id);
    if (this.activeByOwner.get(record.ownerKey) === record.id) {
      this.activeByOwner.delete(record.ownerKey);
    }
    try {
      record.session.close();
    } catch {
      /* best effort */
    }
  }
}

export const geminiLiveTranscription = new GeminiLiveTranscriptionManager();
