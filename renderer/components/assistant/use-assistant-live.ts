import * as React from "react";
import { captureLiveMicrophone, LiveAudioDeviceError, readLiveAudioDevices, routeLiveAudioOutput } from "../../lib/live-audio-devices";
import { playLiveConnectionCue } from "../../lib/dictation-sounds";
import { assistantLiveApi, computerUseApi } from "../../lib/ipc";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { useProviders } from "../../lib/queries";
import type { ComputerUseStatus } from "../../lib/types";
import {
  bindDisplayCaptureLifecycle,
  GEMINI_LIVE_FRAME_INTERVAL_MS,
  GEMINI_LIVE_FRAME_JPEG_QUALITY,
  GEMINI_LIVE_MAX_FRAME_BYTES,
  GEMINI_LIVE_PCM_WORKLET_NAME,
  geminiLiveScaledFrameSize,
  GeminiLivePcmPlaybackQueue,
  loadGeminiLivePcmWorklet,
  measureGeminiLivePcmLevel,
  type DisplayMediaStream,
  type GeminiLiveDisplayFrameSource,
} from "../../lib/gemini-live-media-core";
import type {
  AssistantLiveRendererEvent,
  AssistantLiveSnapshot,
} from "../../shared/assistant-live";
import { assistantLiveVoiceApprovalDecision } from "./assistant-live-voice-approval";
import { liveSessionBus } from "../../lib/live-session-bus";
import { LiveTimeStretcher } from "../../lib/live-time-stretch";

export interface AssistantLiveCaption {
  id: number;
  direction: "input" | "output";
  final: boolean;
  sealed: boolean;
  text: string;
}

export interface AssistantLiveVoiceApprovalReceipt {
  id: number;
  text: string;
}

export interface AssistantLiveController {
  visible: boolean;
  available: boolean;
  availabilityDetail: string;
  active: boolean;
  setupOpen: boolean;
  busy: boolean;
  microphone: boolean;
  microphoneActive: boolean;
  microphoneLevel: number;
  /** The user muted the microphone during the session; Live hears silence. */
  microphoneMuted: boolean;
  microphonePermission: AssistantLiveMicrophonePermission;
  microphonePermissionReady: boolean;
  microphonePermissionDetail: string;
  model: string | null;
  state: AssistantLiveSnapshot["state"];
  captions: readonly AssistantLiveCaption[];
  voiceApprovalReceipts: readonly AssistantLiveVoiceApprovalReceipt[];
  latestVoiceApprovalReceiptId(): number;
  retainVoiceApprovalReceiptsAfter(receiptId: number | null): void;
  error: string | null;
  reconnectRequired: boolean;
  startBlockedReason: string | null;
  computerUseEnabled: boolean;
  computerUseActing: boolean;
  computerUseReady: boolean;
  computerUseBusy: boolean;
  computerUseDetail: string;
  computerUsePermissions: ComputerUseStatus["permissions"] | null;
  computerUseError: string | null;
  screenShareAvailable: boolean;
  screenSourceLabel: string | null;
  screenActive: boolean;
  screenBusy: boolean;
  screenError: string | null;
  setupComplete: boolean;
  setSetupOpen(open: boolean): void;
  setMicrophone(enabled: boolean): void;
  setMicrophoneMuted(muted: boolean): void;
  /** Loudness of Live's voice playing now, 0 to 1. Read it per frame. */
  outputLevel(): number;
  /** Whether replies are still queued or playing, and how often playback was cut off. */
  playbackState(): { idle: boolean; bargeIns: number };
  /** Pitch-preserving speaking speed for Live's replies. */
  setPlaybackSpeed(speed: number): void;
  setComputerUse(enabled: boolean): Promise<void>;
  requestMicrophonePermission(): Promise<boolean>;
  prepareComputerUse(): Promise<void>;
  chooseScreenSource(): Promise<void>;
  releaseScreen(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancelSetup(): Promise<void>;
}

export type AssistantLiveMicrophonePermission =
  | "checking"
  | "granted"
  | "not-determined"
  | "denied"
  | "restricted"
  | "unavailable";

export function assistantLiveAvailabilityDetail(snapshot: AssistantLiveSnapshot): string {
  switch (snapshot.reason) {
    case "available":
      return snapshot.model
        ? `Approved model: ${snapshot.model}`
        : "Aiden approved this Live session.";
    case "missing_google_credential":
      return "Connect Google with an API key in Settings before starting Live.";
    case "google_oauth_unsupported":
      return "The connected Google account uses OAuth. Live currently requires a Google API key.";
    case "google_api_key_invalid":
      return "The saved Google API key is not valid for Live. Update it in Settings.";
    case "live_model_unverified":
      return "No Google Live model has passed Aiden’s production contract probe yet.";
  }
}

function normalizeMicrophonePermission(status: string): AssistantLiveMicrophonePermission {
  return ["granted", "not-determined", "denied", "restricted"].includes(status)
    ? (status as AssistantLiveMicrophonePermission)
    : "unavailable";
}

export function assistantLiveMicrophonePermissionDetail(
  permission: AssistantLiveMicrophonePermission,
): string {
  switch (permission) {
    case "checking":
      return "Checking macOS microphone permission…";
    case "granted":
      return "Microphone permission is allowed in macOS System Settings.";
    case "not-determined":
      return "Microphone permission has not been requested. macOS will ask after you choose Start.";
    case "denied":
      return "Microphone permission is denied. Allow Aiden in System Settings → Privacy & Security → Microphone.";
    case "restricted":
      return "Microphone access is restricted by macOS or device policy.";
    case "unavailable":
      return "Aiden could not verify macOS microphone permission. Start stays unavailable.";
  }
}

export function assistantLiveStartErrorDetail(error: unknown): string {
  if (error instanceof LiveAudioDeviceError) return error.message;
  const message = error instanceof Error ? error.message : "Live could not start.";
  if (/Google rejected this API key for Live/u.test(message)) return message;
  if (/Google Live quota is unavailable/u.test(message)) return message;
  if (/approved Google Live model is unavailable/u.test(message)) return message;
  if (/Google Live is temporarily unavailable/u.test(message)) return message;
  if (/Google Live rejected Aiden's session configuration/u.test(message)) return message;
  if (/could not establish a connection to Google Live/u.test(message)) return message;
  if (/permission|denied|notallowed/iu.test(message)) {
    return "Microphone access was not granted. You can try again after allowing it in System Settings.";
  }
  return "Live could not start. Nothing is capturing; try again when you’re ready.";
}

export function assistantLiveRuntimeErrorDetail(code: string): string {
  switch (code) {
    case "idle_timeout":
      return "The Live connection stopped responding. Nothing restarted automatically.";
    case "malformed_server_event":
      return "Google Live sent an unsupported event. Nothing restarted automatically.";
    case "provider_rate_limit":
      return "The Live session exceeded its safety limits. Nothing restarted automatically.";
    case "resumption_unavailable":
      return "The Live connection could not resume safely. Reconnect when you’re ready.";
    case "connect_timeout":
    case "transport_error":
    case "unexpected_disconnect":
      return "The Live connection closed unexpectedly. Nothing restarted automatically.";
    case "cancelled":
      return "The Live session was stopped.";
    default:
      return "The Live session encountered a provider error.";
  }
}

function stopSource(source: AudioBufferSourceNode | null): void {
  if (!source) return;
  try {
    source.stop();
  } catch {
    // A source may already have ended while an interruption is being applied.
  }
}

/** Generation-fenced 24 kHz player. Every asynchronous continuation rechecks its epoch. */
/** How long arriving audio may pause before the stretcher's held tail plays. */
export const PCM_STARVATION_MS = 250;

export class PcmPlayer {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelSamples: Float32Array<ArrayBuffer> | null = null;
  private source: AudioBufferSourceNode | null = null;
  private starting = false;
  private paused = false;
  private epoch = 0;
  private flushes = 0;
  private bargeIns = 0;
  /** Set once the reply has ended, or audio has not arrived for a while: play the held tail. */
  private releaseHeld = false;
  private starvationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue = new GeminiLivePcmPlaybackQueue();
  /** Pitch-preserving speed change; idle at 1×. */
  private readonly stretcher = new LiveTimeStretcher();

  constructor(private readonly createContext = () => new AudioContext({ sampleRate: 24_000 })) {}

  async prepareOutput(deviceId: string, signal: AbortSignal): Promise<void> {
    await this.close();
    if (signal.aborted) return;
    const context = this.createContext();
    try {
      await routeLiveAudioOutput(context, deviceId);
      if (signal.aborted) {
        await context.close();
        return;
      }
      this.context = context;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  /** Speaking speed for replies; applies from the next audio played. */
  setSpeed(speed: number): void {
    this.stretcher.setSpeed(speed);
  }

  /** True when nothing is queued, held back or playing. */
  get idle(): boolean {
    return !this.source && !this.starting && this.queue.queuedChunks === 0 && !this.stretcher.pending;
  }

  /** Counts every flush, including a resumption's. */
  get flushCount(): number {
    return this.flushes;
  }

  /** Counts only flushes because the user talked over a reply. */
  get bargeInCount(): number {
    return this.bargeIns;
  }

  /**
   * Live finished generating this reply: play what the stretcher still holds.
   * Until then, a short gap in arriving audio keeps the stretcher's state, so
   * a reply that streams in small pieces keeps its speed.
   */
  endOfReply(): void {
    if (!this.stretcher.pending) return;
    this.releaseHeld = true;
    void this.playNext().catch(() => {
      this.starting = false;
    });
  }

  /** Loudness of what is playing now, 0 to 1. */
  level(): number {
    const analyser = this.analyser;
    if (!analyser || !this.source) return 0;
    const samples = (this.levelSamples ??= new Float32Array(analyser.fftSize));
    analyser.getFloatTimeDomainData(samples);
    let squareSum = 0;
    for (const sample of samples) squareSum += sample * sample;
    return Math.min(1, Math.sqrt(squareSum / samples.length) * 4);
  }

  enqueue(pcm: Uint8Array): void {
    if (this.paused) return;
    this.clearStarvation();
    this.queue.enqueue(pcm);
    void this.playNext().catch(() => {
      console.info("[aiden-live] playback-failed");
      this.starting = false;
    });
  }

  /** Controlled resumption and interruption drop pending/active output, never microphone input. */
  pauseAndFlush(): void {
    this.paused = true;
    this.flushInternal();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.epoch += 1;
    void this.playNext().catch(() => {
      this.starting = false;
    });
  }

  /** The user talked over the reply. */
  flush(): void {
    this.bargeIns += 1;
    this.flushInternal();
  }

  async close(): Promise<void> {
    this.paused = true;
    this.flushInternal();
    const context = this.context;
    this.context = null;
    this.analyser = null;
    if (context) await context.close().catch(() => undefined);
  }

  private flushInternal(): void {
    this.epoch += 1;
    this.flushes += 1;
    this.clearStarvation();
    this.releaseHeld = false;
    this.queue.flush();
    this.stretcher.reset();
    const source = this.source;
    this.source = null;
    this.starting = false;
    stopSource(source);
  }

  /** The next stretch of audio to play, joining chunks until some is ready. */
  private nextSamples(): Float32Array<ArrayBuffer> | null {
    for (;;) {
      const pcm = this.queue.dequeue();
      if (!pcm) {
        // Caught up with the reply. Keep what the stretcher holds unless the
        // reply has ended or audio stopped arriving (see endOfReply).
        if (!this.releaseHeld || !this.stretcher.pending) return null;
        this.releaseHeld = false;
        return this.stretcher.drain();
      }
      const decoded = new Float32Array(pcm.byteLength / 2);
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let index = 0; index < decoded.length; index += 1) {
        decoded[index] = view.getInt16(index * 2, true) / 32_768;
      }
      const samples = this.stretcher.process(decoded);
      if (samples.length > 0) return samples;
    }
  }

  private clearStarvation(): void {
    if (this.starvationTimer !== null) clearTimeout(this.starvationTimer);
    this.starvationTimer = null;
  }

  /** Audio that stops arriving for a while is treated as the end of the reply. */
  private armStarvation(): void {
    this.clearStarvation();
    this.starvationTimer = setTimeout(() => {
      this.starvationTimer = null;
      this.endOfReply();
    }, PCM_STARVATION_MS);
  }

  private destinationFor(context: AudioContext): AudioNode {
    if (this.analyser) return this.analyser;
    if (typeof context.createAnalyser !== "function") return context.destination;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(context.destination);
    this.analyser = analyser;
    return analyser;
  }

  private async playNext(): Promise<void> {
    if (this.paused || this.source || this.starting) return;
    if (this.queue.queuedChunks === 0 && !this.stretcher.pending) return;
    const epoch = this.epoch;
    this.starting = true;
    const context = (this.context ??= this.createContext());
    if (context.state === "suspended") {
      await context.resume();
      if (epoch !== this.epoch || this.paused || context !== this.context) {
        this.starting = false;
        return;
      }
    }
    const samples = this.nextSamples();
    if (!samples || samples.length === 0 || epoch !== this.epoch || this.paused || context !== this.context) {
      this.starting = false;
      if (!samples && epoch === this.epoch && this.stretcher.pending) this.armStarvation();
      return;
    }
    const buffer = context.createBuffer(1, samples.length, 24_000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destinationFor(context));
    source.onended = () => {
      if (epoch !== this.epoch) return;
      if (this.source === source) this.source = null;
      void this.playNext().catch(() => {
        this.starting = false;
      });
    };
    if (epoch !== this.epoch || this.paused || context !== this.context) {
      this.starting = false;
      source.disconnect();
      return;
    }
    this.source = source;
    this.starting = false;
    source.start();
    if (context.currentTime < 1) console.info("[aiden-live] playback-started");
  }
}

interface AssistantLiveApi {
  status(): Promise<AssistantLiveSnapshot>;
  authorizeComputerUse?(): Promise<string | null>;
  start(intent: {
    microphone: boolean;
    screen?: boolean;
    computerUseAuthorization: string | null;
  }): Promise<AssistantLiveSnapshot>;
  stop(): Promise<AssistantLiveSnapshot>;
  sendAudio(sessionId: string, pcm: Uint8Array): Promise<boolean>;
  bindDisplay?(): Promise<string | null>;
  releaseDisplay?(bindingId: string): Promise<boolean>;
  sendFrame?(sessionId: string, frame: Uint8Array): Promise<boolean>;
  toolResult?(sessionId: string, requestId: string, response: Record<string, unknown>): Promise<boolean>;
  note?(sessionId: string, text: string, options?: { awaitDelivery?: boolean }): Promise<boolean>;
  onEvent(handler: (event: AssistantLiveRendererEvent) => void): () => void;
}

export interface AssistantLiveDependencies {
  geminiLive: boolean;
  /** Changes after provider credential/catalog state is authoritatively refreshed. */
  availabilityRefreshToken?: number;
  /** False while the provider query is fetching, so Live reads only settled credential state. */
  availabilityRefreshReady?: boolean;
  api: AssistantLiveApi;
  askForMicrophone(): Promise<boolean>;
  getMicrophoneStatus(): Promise<string>;
  getUserMedia(): Promise<MediaStream>;
  createCaptureContext(): AudioContext;
  createWorklet(context: AudioContext): AudioWorkletNode;
  loadWorklet(context: AudioContext): Promise<void>;
  createPlayer(): PcmPlayer;
  prepareAudioSession?(signal: AbortSignal): Promise<void>;
  playConnectionCue?(kind: "connected" | "disconnected"): Promise<void>;
  getDisplayMedia?(): Promise<DisplayMediaStream>;
  createDisplayFrameSource?(
    stream: DisplayMediaStream,
  ): Promise<GeminiLiveDisplayFrameSource>;
  computerUse: {
    status(): Promise<ComputerUseStatus>;
    setEnabled?(enabled: boolean): Promise<ComputerUseStatus>;
    requestPermissions?(): Promise<ComputerUseStatus>;
  };
  ordinaryBusyReason?: string | null;
  /** Silence after the user's last words that ends an utterance no reply has ended yet. */
  utteranceQuietMs?: number;
}

/**
 * Ends a user utterance when Google has neither marked it finished nor started
 * a reply, so a spoken answer still counts while Live waits on a tool.
 */
export const ASSISTANT_LIVE_UTTERANCE_QUIET_MS = 2_000;

function defaultDependencies(geminiLive: boolean): AssistantLiveDependencies {
  let devices = { input: "default", output: "default" };
  const player = new PcmPlayer();
  return {
    geminiLive,
    api: assistantLiveApi,
    askForMicrophone: () => window.aidenAPI.systemPreferences.askForMediaAccess("microphone"),
    getMicrophoneStatus: () => window.aidenAPI.systemPreferences.getMediaAccessStatus("microphone"),
    getUserMedia: () => captureLiveMicrophone(devices.input),
    createCaptureContext: () => new AudioContext(),
    createWorklet: (context) => new AudioWorkletNode(context, GEMINI_LIVE_PCM_WORKLET_NAME),
    loadWorklet: (context) => loadGeminiLivePcmWorklet(context, window.location.href),
    createPlayer: () => player,
    prepareAudioSession: async (signal) => {
      devices = readLiveAudioDevices();
      await player.prepareOutput(devices.output, signal);
    },
    playConnectionCue: async (kind) => {
      try {
        await playLiveConnectionCue(kind, devices.output);
        console.info(`[aiden-live] cue-${kind}`);
      } catch {
        console.info("[aiden-live] cue-failed");
      }
    },
    getDisplayMedia: () =>
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }),
    createDisplayFrameSource: async (stream) => {
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream as MediaStream;
      await video.play();
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Live screen capture is unavailable.");
      return {
        capture: async () => {
          if (!video.videoWidth || !video.videoHeight) return null;
          const size = geminiLiveScaledFrameSize(video.videoWidth, video.videoHeight);
          if (canvas.width !== size.width) canvas.width = size.width;
          if (canvas.height !== size.height) canvas.height = size.height;
          context.drawImage(video, 0, 0, size.width, size.height);
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", GEMINI_LIVE_FRAME_JPEG_QUALITY),
          );
          if (!blob || blob.size < 4 || blob.size > GEMINI_LIVE_MAX_FRAME_BYTES) return null;
          return new Uint8Array(await blob.arrayBuffer());
        },
        stop: () => {
          video.srcObject = null;
        },
      };
    },
    computerUse: computerUseApi,
  };
}

function activeSnapshot(snapshot: AssistantLiveSnapshot): boolean {
  return (
    Boolean(snapshot.sessionId) &&
    !["idle", "closed", "failed", "disconnected"].includes(snapshot.state)
  );
}

const MAX_ASSISTANT_LIVE_TRANSCRIPT_TURNS = 40;
const MAX_ASSISTANT_LIVE_TRANSCRIPT_CHARACTERS = 64 * 1_024;
const MAX_ASSISTANT_LIVE_TURN_CHARACTERS = 32 * 1_024;

function joinAssistantLiveCaptionFragments(current: string, next: string): string {
  const left = current.trim();
  const right = next.trim();
  if (!left) return right;
  if (!right || left === right) return left;
  if (right.startsWith(left)) return right;
  if (left.endsWith(right)) return left;
  const separator = /^[,.;:!?)]/u.test(right) || /[([]$/u.test(left) ? "" : " ";
  return `${left}${separator}${right}`;
}

function boundAssistantLiveTranscript(captions: AssistantLiveCaption[]): AssistantLiveCaption[] {
  const bounded = captions.slice(-MAX_ASSISTANT_LIVE_TRANSCRIPT_TURNS).map((caption) =>
    caption.text.length <= MAX_ASSISTANT_LIVE_TURN_CHARACTERS
      ? caption
      : {
          ...caption,
          text: `${caption.text.slice(0, MAX_ASSISTANT_LIVE_TURN_CHARACTERS - 1)}…`,
        },
  );
  let characters = bounded.reduce((total, caption) => total + caption.text.length, 0);
  while (bounded.length > 1 && characters > MAX_ASSISTANT_LIVE_TRANSCRIPT_CHARACTERS) {
    characters -= bounded.shift()?.text.length ?? 0;
  }
  return bounded;
}

export function sealAssistantLiveCaption(
  current: readonly AssistantLiveCaption[],
): AssistantLiveCaption[] {
  const last = current[current.length - 1];
  if (!last || last.sealed) return [...current];
  return [...current.slice(0, -1), { ...last, final: true, sealed: true }];
}

export function reconcileAssistantLiveCaption(
  current: readonly AssistantLiveCaption[],
  event: Extract<AssistantLiveRendererEvent, { type: "caption" }>,
  nextId: () => number,
): AssistantLiveCaption[] {
  const last = current[current.length - 1];
  if (last && !last.sealed && last.direction === event.direction) {
    const updated = [...current];
    updated[updated.length - 1] = {
      ...last,
      final: event.final,
      text: last.final ? joinAssistantLiveCaptionFragments(last.text, event.text) : event.text,
    };
    return boundAssistantLiveTranscript(updated);
  }
  const sealedCurrent = last && !last.sealed ? sealAssistantLiveCaption(current) : [...current];
  return boundAssistantLiveTranscript([
    ...sealedCurrent,
    {
      id: nextId(),
      direction: event.direction,
      final: event.final,
      sealed: false,
      text: event.text,
    },
  ]);
}

/** Dependency-injected variant used by renderer lifecycle tests. */
export function useAssistantLiveWithDependencies(
  dependencies: AssistantLiveDependencies,
): AssistantLiveController {
  const mounted = React.useRef(true);
  const sessionRef = React.useRef<string | null>(null);
  const operationGeneration = React.useRef(0);
  const operationInFlight = React.useRef(false);
  const availabilityGeneration = React.useRef(0);
  const mediaGeneration = React.useRef(0);
  const microphoneLevelRef = React.useRef(0);
  const microphoneLevelFrame = React.useRef(0);
  const setupAbortRef = React.useRef<AbortController | null>(null);
  const mediaCleanupRef = React.useRef<{
    generation: number;
    sessionId: string;
    cleanup: () => Promise<void>;
  } | null>(null);
  const screenStreamRef = React.useRef<DisplayMediaStream | null>(null);
  const screenBindingRef = React.useRef<string | null>(null);
  const screenPickerGeneration = React.useRef(0);
  const screenFinishRef = React.useRef<(() => void) | null>(null);
  const screenPumpRef = React.useRef<{
    sessionId: string;
    timer: ReturnType<typeof setInterval>;
    source: GeminiLiveDisplayFrameSource;
  } | null>(null);
  const stopSessionRef = React.useRef<(() => Promise<void>) | null>(null);
  const playerRef = React.useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = dependencies.createPlayer();
  const captionId = React.useRef(0);
  const voiceApprovalReceiptId = React.useRef(0);
  const voiceApprovalReceiptRetentionFloor = React.useRef<number | null>(null);
  // Google transcribes the user's speech in pieces ("Don't", " allow", " this").
  // Pieces join into one utterance that is published once, when the user's turn
  // ends, so a fixed phrase is matched against everything that was said. The
  // receipt id is taken at the first piece, so an approval shown mid-sentence
  // still fences words that started before it.
  //
  // Live's output ends the user's turn only when Live was quiet as the user
  // began. Speech that talks over a reply is followed by that reply's
  // leftovers (a late caption, a last chunk, its turn end), so such an
  // utterance ends only on Google's finished mark or the quiet timer.
  const pendingUtterance = React.useRef<
    { receiptId: number; startedAt: number; text: string; overReply: boolean } | null
  >(null);
  /** Bus start mark of the utterance under way, taken on its first input caption, interim or final. */
  const utteranceStartedAt = React.useRef<number | null>(null);
  /** Whether Live's latest reply is still producing output, including a reply the user cut off. */
  const liveReplyOpen = React.useRef(false);
  const utteranceQuietTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestVoiceApprovalReceiptId = React.useCallback(
    () => voiceApprovalReceiptId.current,
    [],
  );
  const retainVoiceApprovalReceiptsAfter = React.useCallback((receiptId: number | null) => {
    voiceApprovalReceiptRetentionFloor.current = receiptId;
  }, []);
  const computerUseGeneration = React.useRef(0);
  const [snapshot, setSnapshot] = React.useState<AssistantLiveSnapshot>({
    available: false,
    reason: "live_model_unverified",
    state: "idle",
  });
  const liveApi = dependencies.api;
  const busSessionId = activeSnapshot(snapshot) ? (snapshot.sessionId ?? null) : null;
  React.useEffect(() => {
    const { toolResult, note } = liveApi;
    liveSessionBus.setSession(
      busSessionId,
      busSessionId && toolResult && note
        ? { toolResult: toolResult.bind(liveApi), note: note.bind(liveApi) }
        : null,
    );
  }, [busSessionId, liveApi]);
  React.useEffect(() => () => liveSessionBus.setSession(null, null), []);
  const [setupOpen, setSetupOpenState] = React.useState(false);
  const [microphone, setMicrophone] = React.useState(true);
  const [microphoneActive, setMicrophoneActive] = React.useState(false);
  const [microphoneLevel, setMicrophoneLevel] = React.useState(0);
  const [microphoneMuted, setMicrophoneMutedState] = React.useState(false);
  const microphoneMutedRef = React.useRef(false);
  const setMicrophoneMuted = React.useCallback((muted: boolean) => {
    microphoneMutedRef.current = muted;
    setMicrophoneMutedState(muted);
  }, []);
  const outputLevel = React.useCallback(() => playerRef.current?.level() ?? 0, []);
  const playbackState = React.useCallback(() => {
    const player = playerRef.current;
    return { idle: player?.idle ?? true, bargeIns: player?.bargeInCount ?? 0 };
  }, []);
  const setPlaybackSpeed = React.useCallback((speed: number) => {
    playerRef.current?.setSpeed(speed);
  }, []);
  const [microphonePermission, setMicrophonePermission] =
    React.useState<AssistantLiveMicrophonePermission>("checking");
  const [busy, setBusy] = React.useState(false);
  const [captions, setCaptions] = React.useState<AssistantLiveCaption[]>([]);
  const [voiceApprovalReceipts, setVoiceApprovalReceipts] = React.useState<
    AssistantLiveVoiceApprovalReceipt[]
  >([]);
  const [error, setError] = React.useState<string | null>(null);
  const [reconnectRequired, setReconnectRequired] = React.useState(false);
  const [computerUseStatus, setComputerUseStatus] = React.useState<ComputerUseStatus | null>(null);
  const [computerUseEnabled, setComputerUseEnabled] = React.useState(false);
  const [computerUseActing, setComputerUseActing] = React.useState(false);
  const [computerUseBusy, setComputerUseBusy] = React.useState(false);
  const [computerUseError, setComputerUseError] = React.useState<string | null>(null);
  const audibleSession = React.useRef<string | null>(null);
  const receivedAudioSession = React.useRef<string | null>(null);
  React.useEffect(() => {
    let cue: "connected" | "disconnected" | null = null;
    if (snapshot.state === "open" && microphoneActive && snapshot.sessionId) {
      if (audibleSession.current !== snapshot.sessionId) {
        audibleSession.current = snapshot.sessionId;
        cue = "connected";
      }
    } else if (
      audibleSession.current &&
      ["idle", "closed", "failed", "disconnected"].includes(snapshot.state)
    ) {
      audibleSession.current = null;
      cue = "disconnected";
    }
    // Audio feedback must never block capture, teardown, or reconnect recovery.
    if (cue) void dependencies.playConnectionCue?.(cue).catch(() => undefined);
  }, [snapshot.state, snapshot.sessionId, microphoneActive, dependencies.playConnectionCue]);
  const [screenSourceLabel, setScreenSourceLabel] = React.useState<string | null>(null);
  const [screenActive, setScreenActive] = React.useState(false);
  const [screenBusy, setScreenBusy] = React.useState(false);
  const [screenError, setScreenError] = React.useState<string | null>(null);

  const active = Boolean(sessionRef.current) && activeSnapshot(snapshot);

  /** Idempotent: clears the frame pump, then ends every display track once. */
  const stopScreenCapture = React.useCallback(() => {
    const pump = screenPumpRef.current;
    screenPumpRef.current = null;
    if (pump) {
      clearInterval(pump.timer);
      pump.source.stop();
    }
    const finish = screenFinishRef.current;
    screenFinishRef.current = null;
    finish?.();
    screenStreamRef.current = null;
    if (mounted.current) {
      setScreenActive(false);
      setScreenSourceLabel(null);
    }
  }, []);

  const releaseDisplayAuthority = React.useCallback(() => {
    screenPickerGeneration.current += 1;
    const bindingId = screenBindingRef.current;
    screenBindingRef.current = null;
    if (mounted.current) setScreenBusy(false);
    if (bindingId) {
      void dependencies.api.releaseDisplay?.(bindingId).catch(() => undefined);
    }
  }, [dependencies.api]);

  const teardownMedia = React.useCallback(
    async (expected?: { sessionId: string; generation: number }) => {
      const record = mediaCleanupRef.current;
      if (
        expected &&
        (!record ||
          record.sessionId !== expected.sessionId ||
          record.generation !== expected.generation)
      ) {
        return;
      }
      stopScreenCapture();
      const teardownGeneration = ++mediaGeneration.current;
      mediaCleanupRef.current = null;
      microphoneLevelRef.current = 0;
      microphoneLevelFrame.current = 0;
      if (mounted.current) {
        setMicrophoneActive(false);
        setMicrophoneLevel(0);
      }
      await record?.cleanup();
      if (mediaGeneration.current === teardownGeneration && !mediaCleanupRef.current) {
        await playerRef.current?.close();
      }
    },
    [stopScreenCapture],
  );

  const discardUtterance = React.useCallback(() => {
    pendingUtterance.current = null;
    utteranceStartedAt.current = null;
    if (utteranceQuietTimer.current !== null) clearTimeout(utteranceQuietTimer.current);
    utteranceQuietTimer.current = null;
  }, []);

  const endUtterance = React.useCallback(() => {
    const pending = pendingUtterance.current;
    discardUtterance();
    if (!pending || !mounted.current) return;
    liveSessionBus.publishVoiceInput(pending.text, pending.startedAt);
    const receipt = { id: pending.receiptId, text: pending.text };
    setVoiceApprovalReceipts((current) => {
      const next = [...current, receipt];
      const floor = voiceApprovalReceiptRetentionFloor.current;
      const protectedReceipt =
        floor === null
          ? undefined
          : next.find(
              (candidate) =>
                candidate.id > floor &&
                assistantLiveVoiceApprovalDecision(candidate.text) !== null,
            );
      const tail = next.slice(protectedReceipt ? -255 : -256);
      return protectedReceipt && !tail.some((candidate) => candidate.id === protectedReceipt.id)
        ? [protectedReceipt, ...tail]
        : tail;
    });
  }, [discardUtterance]);

  const continueUtterance = React.useCallback(
    (fragment: string) => {
      const pending = pendingUtterance.current;
      const text = joinAssistantLiveCaptionFragments(pending?.text ?? "", fragment);
      if (!text) return;
      pendingUtterance.current = {
        receiptId: pending?.receiptId ?? ++voiceApprovalReceiptId.current,
        startedAt: pending?.startedAt ?? utteranceStartedAt.current ?? liveSessionBus.beginVoiceInput(),
        text,
        overReply: pending ? pending.overReply : liveReplyOpen.current,
      };
      if (utteranceQuietTimer.current !== null) clearTimeout(utteranceQuietTimer.current);
      utteranceQuietTimer.current = setTimeout(
        endUtterance,
        dependencies.utteranceQuietMs ?? ASSISTANT_LIVE_UTTERANCE_QUIET_MS,
      );
    },
    [dependencies.utteranceQuietMs, endUtterance],
  );

  const acceptEvent = React.useCallback(
    (event: AssistantLiveRendererEvent) => {
      if (!mounted.current) return;
      if (event.type === "snapshot") {
        if (event.snapshot.sessionId && event.snapshot.sessionId !== sessionRef.current) return;
        setSnapshot(event.snapshot);
        if (event.snapshot.state === "resuming") playerRef.current?.pauseAndFlush();
        else if (event.snapshot.state === "open") playerRef.current?.resume();
        if (["closed", "failed", "disconnected"].includes(event.snapshot.state)) {
          sessionRef.current = null;
          discardUtterance();
          liveReplyOpen.current = false;
          setCaptions([]);
          setVoiceApprovalReceipts([]);
          setComputerUseActing(false);
          if (event.snapshot.state !== "closed") {
            setReconnectRequired(true);
            setError((current) => current ?? "Live disconnected. Nothing restarted automatically.");
          }
          void teardownMedia();
        }
        return;
      }
      if (event.sessionId !== sessionRef.current) return;
      const liveOutput =
        event.type === "audio" ||
        event.type === "model_text" ||
        event.type === "tool_request" ||
        (event.type === "caption" && event.direction === "output");
      // Anything Live says or does next means the user's turn is over, unless
      // the user was talking over a reply whose leftovers may still arrive.
      if ((liveOutput || event.type === "turn") && pendingUtterance.current?.overReply === false) {
        endUtterance();
      }
      if (liveOutput) liveReplyOpen.current = true;
      else if (event.type === "turn" && event.state === "turn_complete") liveReplyOpen.current = false;
      else if (event.type === "playback_flush" && pendingUtterance.current) {
        pendingUtterance.current.overReply = true;
      }
      if (event.type === "tool_request") {
        void liveSessionBus.runToolRequest(event);
        return;
      }
      if (event.type === "tool_cancel") {
        liveSessionBus.cancelToolRequest(event.sessionId, event.requestId);
        return;
      }
      if (event.type === "audio" && event.pcm instanceof Uint8Array) {
        if (receivedAudioSession.current !== event.sessionId) {
          receivedAudioSession.current = event.sessionId;
          console.info("[aiden-live] output-first-packet");
        }
        playerRef.current?.enqueue(event.pcm);
      } else if (event.type === "playback_flush") {
        playerRef.current?.flush();
        setCaptions(sealAssistantLiveCaption);
      } else if (event.type === "caption") {
        // The receipt id is assigned synchronously at IPC delivery time. React may defer
        // the caption render, but an immediately following approval notification must
        // still fence every utterance that began before the prompt.
        // The bus start mark likewise: speech begun before an approval armed
        // stays before its fence however late the utterance finishes.
        if (event.direction === "input" && utteranceStartedAt.current === null) {
          utteranceStartedAt.current = liveSessionBus.beginVoiceInput();
        }
        if (event.direction === "input" && event.final) {
          continueUtterance(event.text);
          if (event.finished) endUtterance();
        }
        setCaptions((current) =>
          reconcileAssistantLiveCaption(current, event, () => ++captionId.current),
        );
      } else if (event.type === "turn") {
        // The reply is fully generated: play what the speed stretcher holds.
        if (event.state !== "waiting") playerRef.current?.endOfReply();
        setCaptions(sealAssistantLiveCaption);
      } else if (event.type === "computer_use_state") {
        setComputerUseActing(event.active);
      } else if (event.type === "error") {
        setError(assistantLiveRuntimeErrorDetail(event.code));
      } else if (event.type === "reconnect_required") {
        sessionRef.current = null;
        discardUtterance();
        setCaptions([]);
        setVoiceApprovalReceipts([]);
        setReconnectRequired(true);
        setError((current) => current ?? "Live disconnected. Nothing restarted automatically.");
        setSnapshot((current) => ({
          ...current,
          sessionId: undefined,
          state: "disconnected",
        }));
        void teardownMedia();
      }
    },
    [continueUtterance, discardUtterance, endUtterance, teardownMedia],
  );

  React.useEffect(() => {
    mounted.current = true;
    // A dependency refresh may have cancelled an in-flight picker during the
    // previous effect's cleanup. The replacement effect now owns the hook and
    // must make the picker re-armable; final unmount has no replacement setup.
    setScreenBusy(false);
    if (!dependencies.geminiLive)
      return () => {
        mounted.current = false;
      };
    const unsubscribe = dependencies.api.onEvent(acceptEvent);
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
      setupAbortRef.current?.abort();
      setupAbortRef.current = null;
      unsubscribe();
      sessionRef.current = null;
      discardUtterance();
      void teardownMedia();
      void dependencies.api.stop().catch(() => undefined);
      releaseDisplayAuthority();
    };
  }, [acceptEvent, dependencies.api, dependencies.geminiLive, discardUtterance, releaseDisplayAuthority, teardownMedia]);

  React.useEffect(() => {
    const generation = ++availabilityGeneration.current;
    if (!dependencies.geminiLive || dependencies.availabilityRefreshReady === false)
      return () => undefined;
    void dependencies.api
      .status()
      .then((next) => {
        if (
          mounted.current &&
          !operationInFlight.current &&
          availabilityGeneration.current === generation
        ) {
          setSnapshot(next);
        }
      })
      .catch(() => undefined);
    return () => {
      availabilityGeneration.current += 1;
    };
  }, [
    dependencies.api,
    dependencies.availabilityRefreshReady,
    dependencies.availabilityRefreshToken,
    dependencies.geminiLive,
  ]);

  React.useEffect(() => {
    let cancelled = false;
    setMicrophonePermission("checking");
    if (!dependencies.geminiLive) return () => undefined;
    void dependencies.getMicrophoneStatus().then(
      (status) => {
        if (!cancelled && mounted.current) {
          setMicrophonePermission(normalizeMicrophonePermission(status));
        }
      },
      () => {
        if (!cancelled && mounted.current) setMicrophonePermission("unavailable");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dependencies.geminiLive, dependencies.getMicrophoneStatus]);

  React.useEffect(() => {
    const generation = ++computerUseGeneration.current;
    setComputerUseEnabled(false);
    setComputerUseError(null);
    if (!dependencies.geminiLive) {
      setComputerUseStatus(null);
      return;
    }
    void dependencies.computerUse.status()
      .then((status) => {
        if (!mounted.current || computerUseGeneration.current !== generation) return;
        setComputerUseStatus(status);
        setComputerUseEnabled(status.ready);
      })
      .catch(() => {
        if (!mounted.current || computerUseGeneration.current !== generation) return;
        setComputerUseStatus(null);
        setComputerUseEnabled(false);
        setComputerUseError("Aiden could not check Computer Use readiness. Try again.");
      });
    return () => {
      computerUseGeneration.current += 1;
    };
  }, [
    dependencies.computerUse,
    dependencies.geminiLive,
  ]);

  const setComputerUse = React.useCallback(
    async (enabled: boolean) => {
      if (computerUseBusy || (enabled && computerUseStatus?.ready !== true)) return;
      setComputerUseError(null);
      setComputerUseEnabled(enabled);
    },
    [computerUseBusy, computerUseStatus?.ready],
  );

  const requestMicrophonePermission = React.useCallback(async () => {
    setError(null);
    try {
      const granted = await dependencies.askForMicrophone();
      if (mounted.current) setMicrophonePermission(granted ? "granted" : "denied");
      return granted;
    } catch {
      if (mounted.current) setMicrophonePermission("unavailable");
      return false;
    }
  }, [dependencies.askForMicrophone]);

  const prepareComputerUse = React.useCallback(async () => {
    if (computerUseBusy) return;
    setComputerUseBusy(true);
    setComputerUseError(null);
    try {
      let status = computerUseStatus;
      if (!status?.enabled) {
        if (!dependencies.computerUse.setEnabled)
          throw new Error("Computer Use setup is unavailable.");
        status = await dependencies.computerUse.setEnabled(true);
      }
      if (!status.ready && status.canRequestPermissions) {
        if (!dependencies.computerUse.requestPermissions)
          throw new Error("macOS permission setup is unavailable.");
        status = await dependencies.computerUse.requestPermissions();
      }
      if (mounted.current) setComputerUseStatus(status);
      if (!status.ready) {
        if (mounted.current) setComputerUseError(status.detail);
        return;
      }
      if (mounted.current) setComputerUseEnabled(true);
    } catch (cause) {
      if (mounted.current) {
        setComputerUseError(
          cause instanceof Error ? cause.message : "Aiden could not prepare Computer Use.",
        );
      }
    } finally {
      if (mounted.current) setComputerUseBusy(false);
    }
  }, [
    computerUseBusy,
    computerUseStatus,
    dependencies.computerUse,
  ]);

  const releaseScreen = React.useCallback(() => {
    stopScreenCapture();
    releaseDisplayAuthority();
  }, [releaseDisplayAuthority, stopScreenCapture]);

  const chooseScreenSource = React.useCallback(async () => {
    if (
      screenBusy ||
      busy ||
      active ||
      snapshot.screenShareAllowed !== true ||
      !dependencies.getDisplayMedia ||
      !dependencies.api.bindDisplay
    )
      return;
    const generation = ++screenPickerGeneration.current;
    setScreenBusy(true);
    setScreenError(null);
    let bindingId: string | null = null;
    try {
      bindingId = await dependencies.api.bindDisplay();
      if (!bindingId) {
        throw new Error("Screen sharing is unavailable for this window.");
      }
      if (!mounted.current || screenPickerGeneration.current !== generation) {
        void dependencies.api.releaseDisplay?.(bindingId).catch(() => undefined);
        return;
      }
      screenBindingRef.current = bindingId;
      const stream = await dependencies.getDisplayMedia();
      if (
        !mounted.current ||
        screenPickerGeneration.current !== generation ||
        sessionRef.current !== null
      ) {
        for (const track of stream.getTracks()) track.stop();
        if (screenBindingRef.current === bindingId) {
          screenBindingRef.current = null;
          void dependencies.api.releaseDisplay?.(bindingId).catch(() => undefined);
        }
        return;
      }
      stopScreenCapture();
      screenStreamRef.current = stream;
      const finish = bindDisplayCaptureLifecycle(stream, {
        onStopped: (reason) => {
          stopScreenCapture();
          if (reason === "ended") void stopSessionRef.current?.();
        },
      });
      // The lifecycle can resolve synchronously for an already-ended track;
      // never advertise a source whose capture already finished.
      if (screenStreamRef.current !== stream) return;
      screenFinishRef.current = () => finish("stopped");
      setScreenSourceLabel(stream.getTracks()[0]?.label?.trim() || "screen");
    } catch (cause) {
      // A cancelled picker keeps any previously chosen source; only a failed
      // first pick releases this document's binding authority.
      if (
        bindingId &&
        screenPickerGeneration.current === generation &&
        !screenStreamRef.current &&
        screenBindingRef.current === bindingId
      ) {
        screenBindingRef.current = null;
        void dependencies.api.releaseDisplay?.(bindingId).catch(() => undefined);
      }
      if (mounted.current) {
        const name = cause instanceof DOMException ? cause.name : "";
        setScreenError(
          name === "AbortError" || name === "NotAllowedError"
            ? null
            : "Aiden could not open the screen picker. Try again.",
        );
      }
    } finally {
      if (mounted.current && screenPickerGeneration.current === generation) {
        setScreenBusy(false);
      }
    }
  }, [
    active,
    busy,
    dependencies.api,
    dependencies.getDisplayMedia,
    screenBusy,
    snapshot.screenShareAllowed,
    stopScreenCapture,
  ]);

  const startScreenShare = React.useCallback(
    async (sessionId: string, signal: AbortSignal) => {
      const stream = screenStreamRef.current;
      if (!stream) return;
      const isCurrent = () =>
        mounted.current && !signal.aborted && sessionRef.current === sessionId;
      if (!dependencies.createDisplayFrameSource || !dependencies.api.sendFrame) {
        releaseScreen();
        return;
      }
      try {
        const source = await dependencies.createDisplayFrameSource(stream);
        if (!isCurrent()) {
          source.stop();
          return;
        }
        let inFlight = false;
        const sendOnce = async () => {
          if (inFlight || !isCurrent()) return;
          inFlight = true;
          try {
            const frame = await source.capture();
            if (frame && isCurrent()) {
              const admitted = await dependencies.api
                .sendFrame?.(sessionId, frame)
                .catch(() => false);
              if (admitted !== true && isCurrent()) releaseScreen();
            }
          } catch {
            // A skipped frame is never fatal; the next interval sends fresh.
          } finally {
            inFlight = false;
          }
        };
        const timer = setInterval(
          () => void sendOnce(),
          GEMINI_LIVE_FRAME_INTERVAL_MS,
        );
        screenPumpRef.current = { sessionId, timer, source };
        setScreenActive(true);
        void sendOnce();
      } catch {
        releaseScreen();
      }
    },
    [dependencies, releaseScreen],
  );

  const startMicrophone = React.useCallback(
    async (sessionId: string, signal: AbortSignal) => {
      const generation = ++mediaGeneration.current;
      const isCurrent = () =>
        mounted.current &&
        !signal.aborted &&
        sessionRef.current === sessionId &&
        mediaGeneration.current === generation;
      const assertCurrent = () => {
        if (!isCurrent())
          throw new DOMException("Live microphone setup was cancelled.", "AbortError");
      };
      const granted = await dependencies.askForMicrophone();
      assertCurrent();
      if (!granted) {
        setMicrophonePermission("denied");
        throw new Error("Microphone permission denied");
      }
      setMicrophonePermission("granted");
      const stream = await dependencies.getUserMedia();
      if (!isCurrent()) {
        for (const track of stream.getTracks()) track.stop();
        assertCurrent();
      }
      const context = dependencies.createCaptureContext();
      try {
        await dependencies.loadWorklet(context);
        assertCurrent();
        const source = context.createMediaStreamSource(stream);
        const worklet = dependencies.createWorklet(context);
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(worklet).connect(silent).connect(context.destination);
        let stopped = false;
        let loggedInput = false;
        let audioSendFailed = false;
        let inFlight = 0;
        const stopAfterAudioFailure = async () => {
          if (audioSendFailed || !isCurrent()) return;
          audioSendFailed = true;
          const operation = operationGeneration.current;
          availabilityGeneration.current += 1;
          operationInFlight.current = true;
          try {
            await teardownMedia({ sessionId, generation });
            if (
              !mounted.current ||
              operationGeneration.current !== operation ||
              sessionRef.current !== sessionId
            )
              return;
            await dependencies.api.stop();
            const next = await dependencies.api.status();
            if (
              mounted.current &&
              operationGeneration.current === operation &&
              sessionRef.current === sessionId
            ) {
              sessionRef.current = activeSnapshot(next) ? (next.sessionId ?? null) : null;
              setSnapshot(next);
              if (!activeSnapshot(next)) {
                setCaptions([]);
                pendingUtterance.current = null;
                setVoiceApprovalReceipts([]);
              }
              setError(
                "Microphone capture stopped because audio could not be sent. Start Live again.",
              );
            }
          } catch {
            if (
              mounted.current &&
              operationGeneration.current === operation &&
              sessionRef.current === sessionId
            ) {
              setSnapshot((current) => ({ ...current, state: "closing" }));
              setError(
                "Microphone capture stopped, but the provider session may still be open. Stop Live, then try again.",
              );
            }
          } finally {
            if (operationGeneration.current === operation) {
              availabilityGeneration.current += 1;
              operationInFlight.current = false;
            }
          }
        };
        worklet.port.onmessage = (message: MessageEvent<unknown>) => {
          if (stopped || !isCurrent()) return;
          const data = message.data as { type?: unknown; data?: unknown };
          if (data?.type !== "pcm" || !(data.data instanceof ArrayBuffer)) return;
          const pcm = new Uint8Array(data.data);
          if (!loggedInput) {
            loggedInput = true;
            console.info("[aiden-live] input-first-packet");
          }
          // Muted: Live keeps getting silence, so it hears the user stop
          // rather than a cut-off stream.
          if (microphoneMutedRef.current) pcm.fill(0);
          const measured = measureGeminiLivePcmLevel(pcm);
          const previous = microphoneLevelRef.current;
          const smoothed =
            measured >= previous
              ? previous * 0.25 + measured * 0.75
              : previous * 0.72 + measured * 0.28;
          microphoneLevelRef.current = smoothed;
          microphoneLevelFrame.current += 1;
          if (
            mounted.current &&
            (microphoneLevelFrame.current === 1 || microphoneLevelFrame.current % 4 === 0)
          ) {
            setMicrophoneLevel(smoothed);
          }
          if (inFlight >= 4) return;
          inFlight += 1;
          void dependencies.api
            .sendAudio(sessionId, pcm)
            .then((accepted) => {
              if (!accepted) void stopAfterAudioFailure();
            })
            .catch(() => {
              void stopAfterAudioFailure();
            })
            .finally(() => {
              inFlight -= 1;
            });
        };
        mediaCleanupRef.current = {
          generation,
          sessionId,
          cleanup: async () => {
            stopped = true;
            worklet.port.onmessage = null;
            source.disconnect();
            worklet.disconnect();
            silent.disconnect();
            for (const track of stream.getTracks()) track.stop();
            await context.close().catch(() => undefined);
          },
        };
        await context.resume();
        assertCurrent();
        setMicrophoneActive(true);
        console.info("[aiden-live] microphone-ready");
      } catch (startError) {
        for (const track of stream.getTracks()) track.stop();
        await context.close().catch(() => undefined);
        throw startError;
      }
    },
    [dependencies, teardownMedia],
  );

  const start = React.useCallback(async () => {
    if (
      busy ||
      screenBusy ||
      dependencies.ordinaryBusyReason ||
      !snapshot.available ||
      !["granted", "not-determined"].includes(microphonePermission) ||
      !microphone
    )
      return;
    availabilityGeneration.current += 1;
    operationInFlight.current = true;
    const generation = ++operationGeneration.current;
    setupAbortRef.current?.abort();
    const setupAbort = new AbortController();
    setupAbortRef.current = setupAbort;
    setBusy(true);
    setError(null);
    setReconnectRequired(false);
    setCaptions([]);
    pendingUtterance.current = null;
    liveReplyOpen.current = false;
    setVoiceApprovalReceipts([]);
    setComputerUseActing(false);
    setMicrophoneMuted(false);
    try {
      await dependencies.prepareAudioSession?.(setupAbort.signal);
      if (setupAbort.signal.aborted || !mounted.current || operationGeneration.current !== generation) return;
      const computerUseAuthorization = computerUseEnabled
        ? (await dependencies.api.authorizeComputerUse?.()) ?? null
        : null;
      if (
        computerUseEnabled &&
        dependencies.api.authorizeComputerUse &&
        !computerUseAuthorization
      ) {
        throw new Error("Computer Use readiness changed. Open setup and check permissions again.");
      }
      if (
        !mounted.current ||
        setupAbort.signal.aborted ||
        operationGeneration.current !== generation
      ) {
        return;
      }
      const next = await dependencies.api.start({
        microphone: true,
        computerUseAuthorization,
        screen: Boolean(screenStreamRef.current),
      });
      if (
        !mounted.current ||
        setupAbort.signal.aborted ||
        operationGeneration.current !== generation ||
        !next.sessionId
      ) {
        return;
      }
      sessionRef.current = next.sessionId;
      setSnapshot(next);
      if (next.state === "resuming") playerRef.current?.pauseAndFlush();
      else if (next.state === "open") playerRef.current?.resume();
      await startMicrophone(next.sessionId, setupAbort.signal);
      await startScreenShare(next.sessionId, setupAbort.signal);
      if (
        mounted.current &&
        !setupAbort.signal.aborted &&
        operationGeneration.current === generation
      ) {
        setSetupOpenState(false);
      }
    } catch (startError) {
      if (operationGeneration.current === generation) {
        await dependencies.api.stop().catch(() => undefined);
        sessionRef.current = null;
        await teardownMedia();
        releaseDisplayAuthority();
        if (mounted.current && !setupAbort.signal.aborted)
          setError(assistantLiveStartErrorDetail(startError));
      }
    } finally {
      if (setupAbortRef.current === setupAbort) setupAbortRef.current = null;
      if (mounted.current && operationGeneration.current === generation) {
        availabilityGeneration.current += 1;
        operationInFlight.current = false;
        setBusy(false);
      }
    }
  }, [
    busy,
    screenBusy,
    computerUseEnabled,
    setMicrophoneMuted,
    dependencies,
    microphone,
    microphonePermission,
    snapshot.available,
    startMicrophone,
    startScreenShare,
    releaseDisplayAuthority,
    teardownMedia,
  ]);

  const stop = React.useCallback(async () => {
    availabilityGeneration.current += 1;
    operationInFlight.current = true;
    const generation = ++operationGeneration.current;
    const previousSessionId = sessionRef.current;
    setupAbortRef.current?.abort();
    setupAbortRef.current = null;
    setBusy(true);
    sessionRef.current = null;
    await teardownMedia();
    try {
      await dependencies.api.stop();
      releaseDisplayAuthority();
      const next = await dependencies.api.status();
      if (mounted.current && operationGeneration.current === generation) {
        sessionRef.current = activeSnapshot(next) ? (next.sessionId ?? null) : null;
        setSnapshot(next);
        if (!activeSnapshot(next)) {
          setCaptions([]);
          pendingUtterance.current = null;
          setVoiceApprovalReceipts([]);
        }
        setError(null);
      }
    } catch {
      try {
        const reconciled = await dependencies.api.status();
        if (mounted.current && operationGeneration.current === generation) {
          sessionRef.current = activeSnapshot(reconciled) ? (reconciled.sessionId ?? null) : null;
          setSnapshot(reconciled);
          if (!activeSnapshot(reconciled)) {
            setCaptions([]);
            pendingUtterance.current = null;
            setVoiceApprovalReceipts([]);
          }
          setError(
            activeSnapshot(reconciled)
              ? "Aiden stopped this microphone, but the provider session may still be open. Choose Stop again."
              : null,
          );
        }
      } catch {
        if (mounted.current && operationGeneration.current === generation) {
          sessionRef.current = previousSessionId;
          setSnapshot((current) => ({
            ...current,
            sessionId: previousSessionId ?? current.sessionId,
            state: "closing",
          }));
          setError(
            "Aiden stopped this microphone but could not confirm the provider session closed. Choose Stop again or quit Aiden.",
          );
        }
      }
    } finally {
      if (mounted.current && operationGeneration.current === generation) {
        availabilityGeneration.current += 1;
        operationInFlight.current = false;
        setBusy(false);
      }
    }
  }, [dependencies, releaseDisplayAuthority, teardownMedia]);

  const cancelSetup = React.useCallback(async () => {
    setSetupOpenState(false);
    await stop();
  }, [stop]);

  React.useEffect(() => {
    stopSessionRef.current = stop;
    return () => {
      stopSessionRef.current = null;
    };
  }, [stop]);

  const setSetupOpen = React.useCallback(
    (open: boolean) => {
      if (!open && busy) {
        void cancelSetup();
        return;
      }
      setSetupOpenState(open);
      // A dismissed setup must never keep an unused capture alive.
      if (!open && !sessionRef.current) releaseScreen();
    },
    [busy, cancelSetup, releaseScreen],
  );

  const availabilityDetail = assistantLiveAvailabilityDetail(snapshot);
  const microphonePermissionReady = ["granted", "not-determined"].includes(microphonePermission);
  const microphonePermissionDetail = assistantLiveMicrophonePermissionDetail(microphonePermission);
  const setupComplete =
    snapshot.available &&
    microphonePermission === "granted" &&
    computerUseStatus?.ready === true &&
    computerUseEnabled;
  return {
    visible: dependencies.geminiLive,
    available: snapshot.available,
    availabilityDetail,
    active,
    setupOpen,
    busy,
    microphone,
    microphoneActive,
    microphoneLevel,
    microphoneMuted,
    microphonePermission,
    microphonePermissionReady,
    microphonePermissionDetail,
    model: snapshot.model ?? null,
    state: snapshot.state,
    captions,
    voiceApprovalReceipts,
    latestVoiceApprovalReceiptId,
    retainVoiceApprovalReceiptsAfter,
    error,
    reconnectRequired,
    startBlockedReason:
      dependencies.ordinaryBusyReason ??
      (!snapshot.available
        ? availabilityDetail
        : !microphonePermissionReady
          ? microphonePermissionDetail
          : null),
    computerUseEnabled,
    computerUseActing,
    computerUseReady: computerUseStatus?.ready === true,
    computerUseBusy,
    computerUseDetail: computerUseStatus?.detail ?? "Checking global Computer Use readiness…",
    computerUsePermissions: computerUseStatus?.permissions ?? null,
    computerUseError,
    screenShareAvailable: snapshot.screenShareAllowed === true,
    screenSourceLabel,
    screenActive,
    screenBusy,
    screenError,
    setupComplete,
    setSetupOpen,
    setMicrophone,
    setMicrophoneMuted,
    outputLevel,
    playbackState,
    setPlaybackSpeed,
    setComputerUse,
    requestMicrophonePermission,
    prepareComputerUse,
    chooseScreenSource,
    releaseScreen,
    start,
    stop,
    cancelSetup,
  };
}

export function useAssistantLive(
  ordinaryBusyReason: string | null = null,
): AssistantLiveController {
  const { geminiLive } = useAppCapabilities();
  const providers = useProviders();
  // Audio ownership survives capability refresh; playerRef must share this same player.
  const [audioDependencies] = React.useState(() => defaultDependencies(false));
  const dependencies = React.useMemo(
    () => ({
      ...audioDependencies,
      geminiLive,
      availabilityRefreshReady: providers.fetchStatus === "idle",
      availabilityRefreshToken: providers.dataUpdatedAt,
      ordinaryBusyReason,
    }),
    [audioDependencies, geminiLive, ordinaryBusyReason, providers.dataUpdatedAt, providers.fetchStatus],
  );
  return useAssistantLiveWithDependencies(dependencies);
}
