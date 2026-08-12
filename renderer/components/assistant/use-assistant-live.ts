import * as React from "react";
import { assistantLiveApi, chatsApi, computerUseApi } from "../../lib/ipc";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { useProviders } from "../../lib/queries";
import type { Chat, ComputerUseStatus } from "../../lib/types";
import {
  GEMINI_LIVE_PCM_WORKLET_NAME,
  GeminiLivePcmPlaybackQueue,
  loadGeminiLivePcmWorklet,
} from "../../lib/gemini-live-media-core";
import type {
  AssistantLiveRendererEvent,
  AssistantLiveSnapshot,
} from "../../shared/assistant-live";

export interface AssistantLiveCaption {
  id: number;
  direction: "input" | "output";
  final: boolean;
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
  microphonePermission: AssistantLiveMicrophonePermission;
  microphonePermissionReady: boolean;
  microphonePermissionDetail: string;
  model: string | null;
  state: AssistantLiveSnapshot["state"];
  captions: readonly AssistantLiveCaption[];
  error: string | null;
  reconnectRequired: boolean;
  startBlockedReason: string | null;
  computerUseEnabled: boolean;
  computerUseReady: boolean;
  computerUseConversationAvailable: boolean;
  computerUseBusy: boolean;
  computerUseDetail: string;
  computerUseError: string | null;
  setSetupOpen(open: boolean): void;
  setMicrophone(enabled: boolean): void;
  setComputerUse(enabled: boolean): Promise<void>;
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

export function assistantLiveAvailabilityDetail(
  snapshot: AssistantLiveSnapshot,
): string {
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

function normalizeMicrophonePermission(
  status: string,
): AssistantLiveMicrophonePermission {
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
  const message =
    error instanceof Error ? error.message : "Live could not start.";
  if (/Google rejected this API key for Live/u.test(message)) return message;
  if (/Google Live quota is unavailable/u.test(message)) return message;
  if (/approved Google Live model is unavailable/u.test(message))
    return message;
  if (/Google Live is temporarily unavailable/u.test(message)) return message;
  if (/Google Live rejected Aiden's session configuration/u.test(message))
    return message;
  if (/could not establish a connection to Google Live/u.test(message))
    return message;
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
export class PcmPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private starting = false;
  private paused = false;
  private epoch = 0;
  private readonly queue = new GeminiLivePcmPlaybackQueue();

  constructor(
    private readonly createContext = () =>
      new AudioContext({ sampleRate: 24_000 }),
  ) {}

  enqueue(pcm: Uint8Array): void {
    if (this.paused) return;
    this.queue.enqueue(pcm);
    void this.playNext().catch(() => {
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

  flush(): void {
    this.flushInternal();
  }

  async close(): Promise<void> {
    this.paused = true;
    this.flushInternal();
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => undefined);
  }

  private flushInternal(): void {
    this.epoch += 1;
    this.queue.flush();
    const source = this.source;
    this.source = null;
    this.starting = false;
    stopSource(source);
  }

  private async playNext(): Promise<void> {
    if (this.paused || this.source || this.starting) return;
    const pcm = this.queue.dequeue();
    if (!pcm) return;
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
    const samples = new Float32Array(pcm.byteLength / 2);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32_768;
    }
    if (epoch !== this.epoch || this.paused || context !== this.context) {
      this.starting = false;
      return;
    }
    const buffer = context.createBuffer(1, samples.length, 24_000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
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
  }
}

interface AssistantLiveApi {
  status(): Promise<AssistantLiveSnapshot>;
  start(intent: {
    chatId: string | null;
    microphone: boolean;
    screen: boolean;
  }): Promise<AssistantLiveSnapshot>;
  stop(): Promise<AssistantLiveSnapshot>;
  sendAudio(sessionId: string, pcm: Uint8Array): Promise<boolean>;
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
  computerUse: Pick<typeof computerUseApi, "status">;
  chats: Pick<typeof chatsApi, "get" | "setComputerUse">;
  activeChatId?: string | null;
  ordinaryBusyReason?: string | null;
}

function defaultDependencies(geminiLive: boolean): AssistantLiveDependencies {
  return {
    geminiLive,
    api: assistantLiveApi,
    askForMicrophone: () =>
      window.aidenAPI.systemPreferences.askForMediaAccess("microphone"),
    getMicrophoneStatus: () =>
      window.aidenAPI.systemPreferences.getMediaAccessStatus("microphone"),
    getUserMedia: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      }),
    createCaptureContext: () => new AudioContext(),
    createWorklet: (context) =>
      new AudioWorkletNode(context, GEMINI_LIVE_PCM_WORKLET_NAME),
    loadWorklet: (context) =>
      loadGeminiLivePcmWorklet(context, window.location.href),
    createPlayer: () => new PcmPlayer(),
    computerUse: computerUseApi,
    chats: chatsApi,
  };
}

function activeSnapshot(snapshot: AssistantLiveSnapshot): boolean {
  return (
    Boolean(snapshot.sessionId) &&
    !["idle", "closed", "failed", "disconnected"].includes(snapshot.state)
  );
}

export function reconcileAssistantLiveCaption(
  current: readonly AssistantLiveCaption[],
  event: Extract<AssistantLiveRendererEvent, { type: "caption" }>,
  nextId: () => number,
): AssistantLiveCaption[] {
  let openIndex = -1;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const caption = current[index];
    if (caption?.direction === event.direction && !caption.final) {
      openIndex = index;
      break;
    }
  }
  if (openIndex >= 0) {
    const updated = [...current];
    updated[openIndex] = {
      ...updated[openIndex]!,
      final: event.final,
      text: event.text,
    };
    return updated.slice(-40);
  }
  return [
    ...current.slice(-39),
    {
      id: nextId(),
      direction: event.direction,
      final: event.final,
      text: event.text,
    },
  ];
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
  const setupAbortRef = React.useRef<AbortController | null>(null);
  const mediaCleanupRef = React.useRef<{
    generation: number;
    sessionId: string;
    cleanup: () => Promise<void>;
  } | null>(null);
  const playerRef = React.useRef<PcmPlayer | null>(null);
  if (!playerRef.current) playerRef.current = dependencies.createPlayer();
  const captionId = React.useRef(0);
  const computerUseGeneration = React.useRef(0);
  const [snapshot, setSnapshot] = React.useState<AssistantLiveSnapshot>({
    available: false,
    reason: "live_model_unverified",
    state: "idle",
  });
  const [setupOpen, setSetupOpenState] = React.useState(false);
  const [microphone, setMicrophone] = React.useState(true);
  const [microphoneActive, setMicrophoneActive] = React.useState(false);
  const [microphonePermission, setMicrophonePermission] =
    React.useState<AssistantLiveMicrophonePermission>("checking");
  const [busy, setBusy] = React.useState(false);
  const [captions, setCaptions] = React.useState<AssistantLiveCaption[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [reconnectRequired, setReconnectRequired] = React.useState(false);
  const [computerUseStatus, setComputerUseStatus] =
    React.useState<ComputerUseStatus | null>(null);
  const [computerUseEnabled, setComputerUseEnabled] = React.useState(false);
  const [computerUseBusy, setComputerUseBusy] = React.useState(false);
  const [computerUseError, setComputerUseError] = React.useState<string | null>(
    null,
  );

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
      const teardownGeneration = ++mediaGeneration.current;
      mediaCleanupRef.current = null;
      if (mounted.current) setMicrophoneActive(false);
      await record?.cleanup();
      if (
        mediaGeneration.current === teardownGeneration &&
        !mediaCleanupRef.current
      ) {
        await playerRef.current?.close();
      }
    },
    [],
  );

  const acceptEvent = React.useCallback(
    (event: AssistantLiveRendererEvent) => {
      if (!mounted.current) return;
      if (event.type === "snapshot") {
        if (
          event.snapshot.sessionId &&
          event.snapshot.sessionId !== sessionRef.current
        )
          return;
        setSnapshot(event.snapshot);
        if (event.snapshot.state === "resuming")
          playerRef.current?.pauseAndFlush();
        else if (event.snapshot.state === "open") playerRef.current?.resume();
        if (
          ["closed", "failed", "disconnected"].includes(event.snapshot.state)
        ) {
          sessionRef.current = null;
          setCaptions([]);
          if (event.snapshot.state !== "closed") {
            setReconnectRequired(true);
            setError(
              (current) =>
                current ??
                "Live disconnected. Nothing restarted automatically.",
            );
          }
          void teardownMedia();
        }
        return;
      }
      if (event.sessionId !== sessionRef.current) return;
      if (event.type === "audio" && event.pcm instanceof Uint8Array) {
        playerRef.current?.enqueue(event.pcm);
      } else if (event.type === "playback_flush") {
        playerRef.current?.flush();
      } else if (event.type === "caption") {
        setCaptions((current) =>
          reconcileAssistantLiveCaption(
            current,
            event,
            () => ++captionId.current,
          ),
        );
      } else if (event.type === "error") {
        setError(assistantLiveRuntimeErrorDetail(event.code));
      } else if (event.type === "reconnect_required") {
        sessionRef.current = null;
        setCaptions([]);
        setReconnectRequired(true);
        setError(
          (current) =>
            current ?? "Live disconnected. Nothing restarted automatically.",
        );
        setSnapshot((current) => ({
          ...current,
          sessionId: undefined,
          state: "disconnected",
        }));
        void teardownMedia();
      }
    },
    [teardownMedia],
  );

  React.useEffect(() => {
    mounted.current = true;
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
      void teardownMedia();
      void dependencies.api.stop().catch(() => undefined);
    };
  }, [acceptEvent, dependencies.api, dependencies.geminiLive, teardownMedia]);

  React.useEffect(() => {
    const generation = ++availabilityGeneration.current;
    if (
      !dependencies.geminiLive ||
      dependencies.availabilityRefreshReady === false
    )
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
        if (!cancelled && mounted.current)
          setMicrophonePermission("unavailable");
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
    const chatId = dependencies.activeChatId ?? null;
    void Promise.all([
      dependencies.computerUse.status(),
      chatId
        ? dependencies.chats.get(chatId)
        : Promise.resolve<Chat | null>(null),
    ])
      .then(([status, chat]) => {
        if (!mounted.current || computerUseGeneration.current !== generation)
          return;
        setComputerUseStatus(status);
        setComputerUseEnabled(chat?.computerUseEnabled === true);
      })
      .catch(() => {
        if (!mounted.current || computerUseGeneration.current !== generation)
          return;
        setComputerUseStatus(null);
        setComputerUseEnabled(false);
        setComputerUseError(
          "Aiden could not check Computer Use readiness. Try again.",
        );
      });
    return () => {
      computerUseGeneration.current += 1;
    };
  }, [
    dependencies.activeChatId,
    dependencies.chats,
    dependencies.computerUse,
    dependencies.geminiLive,
  ]);

  const setComputerUse = React.useCallback(
    async (enabled: boolean) => {
      const chatId = dependencies.activeChatId ?? null;
      if (
        !chatId ||
        computerUseBusy ||
        (enabled && computerUseStatus?.ready !== true)
      )
        return;
      setComputerUseBusy(true);
      setComputerUseError(null);
      // Disable is an authority-removal intent. Reflect it immediately while
      // main synchronously closes this chat's exact Live session before its
      // durable setting write. A failed write is reconciled below.
      if (!enabled) setComputerUseEnabled(false);
      try {
        const chat = await dependencies.chats.setComputerUse(chatId, enabled);
        if (!mounted.current || dependencies.activeChatId !== chatId) return;
        setComputerUseEnabled(chat.computerUseEnabled === true);
      } catch (cause) {
        if (!mounted.current) return;
        if (!enabled && dependencies.activeChatId === chatId) {
          try {
            const reconciled = await dependencies.chats.get(chatId);
            if (mounted.current && dependencies.activeChatId === chatId) {
              setComputerUseEnabled(reconciled?.computerUseEnabled === true);
            }
          } catch {
            // Unknown durable truth stays fail-closed in this mounted view.
            setComputerUseEnabled(false);
          }
        }
        setComputerUseError(
          cause instanceof Error
            ? cause.message
            : "Aiden could not change Computer Use for this conversation.",
        );
      } finally {
        if (mounted.current) setComputerUseBusy(false);
      }
    },
    [
      computerUseBusy,
      computerUseStatus?.ready,
      dependencies.activeChatId,
      dependencies.chats,
    ],
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
          throw new DOMException(
            "Live microphone setup was cancelled.",
            "AbortError",
          );
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
            const next = await dependencies.api.stop();
            if (
              mounted.current &&
              operationGeneration.current === operation &&
              sessionRef.current === sessionId
            ) {
              sessionRef.current = activeSnapshot(next)
                ? (next.sessionId ?? null)
                : null;
              setSnapshot(next);
              if (!activeSnapshot(next)) setCaptions([]);
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
          if (stopped || !isCurrent() || inFlight >= 4) return;
          const data = message.data as { type?: unknown; data?: unknown };
          if (data?.type !== "pcm" || !(data.data instanceof ArrayBuffer))
            return;
          inFlight += 1;
          void dependencies.api
            .sendAudio(sessionId, new Uint8Array(data.data))
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
    try {
      const next = await dependencies.api.start({
        chatId: dependencies.activeChatId ?? null,
        microphone: true,
        screen: false,
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
    dependencies,
    microphone,
    microphonePermission,
    snapshot.available,
    startMicrophone,
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
      const next = await dependencies.api.status();
      if (mounted.current && operationGeneration.current === generation) {
        sessionRef.current = activeSnapshot(next)
          ? (next.sessionId ?? null)
          : null;
        setSnapshot(next);
        if (!activeSnapshot(next)) setCaptions([]);
        setError(null);
      }
    } catch {
      try {
        const reconciled = await dependencies.api.status();
        if (mounted.current && operationGeneration.current === generation) {
          sessionRef.current = activeSnapshot(reconciled)
            ? (reconciled.sessionId ?? null)
            : null;
          setSnapshot(reconciled);
          if (!activeSnapshot(reconciled)) setCaptions([]);
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
  }, [dependencies, teardownMedia]);

  const cancelSetup = React.useCallback(async () => {
    setSetupOpenState(false);
    await stop();
  }, [stop]);

  const setSetupOpen = React.useCallback(
    (open: boolean) => {
      if (
        open &&
        (dependencies.ordinaryBusyReason ||
          !snapshot.available ||
          !["granted", "not-determined"].includes(microphonePermission))
      )
        return;
      if (!open && busy) {
        void cancelSetup();
        return;
      }
      setSetupOpenState(open);
    },
    [
      busy,
      cancelSetup,
      dependencies.ordinaryBusyReason,
      microphonePermission,
      snapshot.available,
    ],
  );

  const active = Boolean(sessionRef.current) && activeSnapshot(snapshot);
  const availabilityDetail = assistantLiveAvailabilityDetail(snapshot);
  const microphonePermissionReady = ["granted", "not-determined"].includes(
    microphonePermission,
  );
  const microphonePermissionDetail =
    assistantLiveMicrophonePermissionDetail(microphonePermission);
  return {
    visible: dependencies.geminiLive,
    available: snapshot.available,
    availabilityDetail,
    active,
    setupOpen,
    busy,
    microphone,
    microphoneActive,
    microphonePermission,
    microphonePermissionReady,
    microphonePermissionDetail,
    model: snapshot.model ?? null,
    state: snapshot.state,
    captions,
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
    computerUseReady:
      computerUseStatus?.ready === true && Boolean(dependencies.activeChatId),
    computerUseConversationAvailable: Boolean(dependencies.activeChatId),
    computerUseBusy,
    computerUseDetail:
      computerUseStatus?.detail ?? "Checking global Computer Use readiness…",
    computerUseError,
    setSetupOpen,
    setMicrophone,
    setComputerUse,
    start,
    stop,
    cancelSetup,
  };
}

export function useAssistantLive(
  activeChatId: string | null = null,
  ordinaryBusyReason: string | null = null,
): AssistantLiveController {
  const { geminiLive } = useAppCapabilities();
  const providers = useProviders();
  const dependencies = React.useMemo(
    () => ({
      ...defaultDependencies(geminiLive),
      availabilityRefreshReady: providers.fetchStatus === "idle",
      availabilityRefreshToken: providers.dataUpdatedAt,
      activeChatId,
      ordinaryBusyReason,
    }),
    [
      activeChatId,
      geminiLive,
      ordinaryBusyReason,
      providers.dataUpdatedAt,
      providers.fetchStatus,
    ],
  );
  return useAssistantLiveWithDependencies(dependencies);
}
