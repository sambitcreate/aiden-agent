// Read-aloud frontend controller. Main owns source authority; this controller
// owns only its explicitly requested job and fences reads/decodes by generation.

import * as React from "react";
import { ttsApi } from "./ipc";
import { TtsPlayer } from "./tts-player";
import { TTS_LIMITS } from "../shared/tts";
import type {
  TtsJobSnapshot,
  TtsSafeError,
  TtsServiceEvent,
  TtsSourceRef,
  TtsStatusV1,
} from "../shared/tts";

export interface ReadAloudState {
  status: TtsStatusV1 | null;
  latestSource: { source: TtsSourceRef | null; reason: string } | null;
  job: TtsJobSnapshot | null;
  playing: boolean;
  paused: boolean;
  busy: boolean;
  error: TtsSafeError | null;
}

type Listener = (state: ReadAloudState) => void;
type Player = Pick<
  TtsPlayer,
  "prime" | "playSegment" | "pause" | "resume" | "stop" | "isPlaying" | "segmentsPlayed"
>;
type ClientApi = Pick<
  typeof ttsApi,
  "status" | "start" | "preview" | "readAudio" | "pause" | "resume" | "stop"
>;
const PLAYBACK_ERROR: TtsSafeError = {
  code: "playback_unavailable",
  message: "Playback stopped before the response finished. Try reading aloud again.",
  retryable: false,
  generationMayHaveBeenBilled: true,
};

export class ReadAloudController {
  private state: ReadAloudState = {
    status: null,
    latestSource: null,
    job: null,
    playing: false,
    paused: false,
    busy: false,
    error: null,
  };
  private listeners = new Set<Listener>();
  private player: Player | null = null;
  private scheduledSegments = new Set<number>();
  private pumpingEpoch: number | null = null;
  private epoch = 0;
  private statusEpoch = 0;
  private disposed = false;
  private chatId: string | undefined;
  private pending: {
    kind: TtsJobSnapshot["kind"];
    chatId: string | null;
    snapshot: TtsJobSnapshot | null;
  } | null = null;
  private readonly api: ClientApi;
  private readonly createPlayer: (onEnded: (index: number) => void) => Player;

  constructor(
    options: { api?: ClientApi; createPlayer?: (onEnded: (index: number) => void) => Player } = {},
  ) {
    this.api = options.api ?? ttsApi;
    this.createPlayer =
      options.createPlayer ?? ((onSegmentEnded) => new TtsPlayer({ onSegmentEnded }));
  }

  /** Effect setup may run again after StrictMode cleanup or a chat switch. */
  activate(chatId?: string): void {
    this.disposed = false;
    this.chatId = chatId;
    this.patch({ latestSource: null });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  head(): ReadAloudState {
    return this.state;
  }

  private patch(update: Partial<ReadAloudState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener(this.state);
  }

  async refreshStatus(chatId = this.chatId): Promise<void> {
    if (this.disposed) return;
    this.chatId = chatId;
    const revision = ++this.statusEpoch;
    try {
      const status = await this.api.status(chatId);
      if (this.disposed || revision !== this.statusEpoch) return;
      // Never adopt another surface's job from global status.
      this.patch({
        status: {
          settings: status.settings,
          settingsRevision: status.settingsRevision,
          credentialReady: status.credentialReady,
          credentialSourceLabel: status.credentialSourceLabel,
          synthesisReady: status.synthesisReady,
        },
        latestSource: status.latestSource,
      });
    } catch {
      // Start surfaces actionable errors; stale status cannot replace playback.
    }
  }

  handleEvent(event: TtsServiceEvent): void {
    if (this.disposed) return;
    if (event.kind === "status") {
      void this.refreshStatus();
      return;
    }
    const snapshot = event.snapshot;
    if (
      this.pending &&
      snapshot.kind === this.pending.kind &&
      snapshot.chatId === this.pending.chatId
    ) {
      // Main can emit before invoke resolves. Buffer, but do not play until
      // the acknowledgement binds this surface to the exact job id.
      this.pending.snapshot = snapshot;
    }
    if (snapshot.jobId !== this.state.job?.jobId) return;
    this.acceptSnapshot(snapshot);
  }

  private acceptSnapshot(snapshot: TtsJobSnapshot): void {
    if (snapshot.phase === "cancelled" || snapshot.phase === "failed") {
      this.resetPlayback();
      this.patch({
        job: snapshot,
        busy: false,
        playing: false,
        paused: false,
        error: snapshot.error,
      });
      return;
    }
    this.patch({ job: snapshot });
    // Generation completion is not playback completion: drain all ready audio.
    this.syncPlayback();
    void this.pump();
  }

  private current(epoch: number, jobId?: string): boolean {
    return !this.disposed && epoch === this.epoch && (!jobId || jobId === this.state.job?.jobId);
  }

  private syncPlayback(): void {
    const job = this.state.job;
    const playing = !this.state.paused && (this.player?.isPlaying ?? false);
    const waiting =
      !!job && (job.phase !== "completed" || this.scheduledSegments.size < job.readySegments);
    this.patch({ playing, busy: !this.state.paused && !playing && waiting });
  }

  /** One reader per generation; loop against the newest snapshot, not an old event. */
  private async pump(): Promise<void> {
    const epoch = this.epoch;
    const jobId = this.state.job?.jobId;
    const player = this.player;
    if (!jobId || !player || this.pumpingEpoch === epoch) return;
    this.pumpingEpoch = epoch;
    try {
      while (this.current(epoch, jobId)) {
        const snapshot = this.state.job!;
        const index = this.scheduledSegments.size;
        // Bound decoded renderer audio as well as bridge reads. End callbacks
        // refill this two-segment window, preserving every sample in order.
        if (
          this.state.paused ||
          index >= snapshot.readySegments ||
          index >= player.segmentsPlayed + 2
        )
          break;
        const bytes = await this.readSegment(epoch, jobId, index);
        if (!bytes || !this.current(epoch, jobId)) return;
        await player.playSegment(index, bytes);
        if (!this.current(epoch, jobId)) return;
        this.scheduledSegments.add(index);
        this.syncPlayback();
      }
    } catch {
      if (!this.current(epoch, jobId)) return;
      this.stop();
      this.patch({ error: PLAYBACK_ERROR });
    } finally {
      if (this.pumpingEpoch === epoch) this.pumpingEpoch = null;
    }
  }

  private async readSegment(
    epoch: number,
    jobId: string,
    segment: number,
  ): Promise<Uint8Array | null> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let total: number | null = null;
    for (;;) {
      const read = await this.api.readAudio(jobId, segment, offset, TTS_LIMITS.audioReadMaxBytes);
      if (!this.current(epoch, jobId)) return null;
      if (
        !read ||
        !(read.bytes instanceof Uint8Array) ||
        !Number.isSafeInteger(read.segmentBytes) ||
        read.segmentBytes <= 0 ||
        read.segmentBytes > TTS_LIMITS.segmentAudioMaxBytes ||
        (total !== null && read.segmentBytes !== total) ||
        read.bytes.byteLength === 0 ||
        read.bytes.byteLength > TTS_LIMITS.audioReadMaxBytes ||
        read.nextOffset !== offset + read.bytes.byteLength ||
        read.nextOffset > read.segmentBytes ||
        read.complete !== (read.nextOffset === read.segmentBytes)
      ) {
        throw new Error("Invalid audio continuation.");
      }
      total = read.segmentBytes;
      chunks.push(read.bytes);
      offset = read.nextOffset;
      if (read.complete) break;
    }
    const joined = new Uint8Array(offset);
    let position = 0;
    for (const chunk of chunks) {
      joined.set(chunk, position);
      position += chunk.byteLength;
    }
    return joined;
  }

  private resetPlayback(): void {
    this.epoch += 1;
    this.player?.stop();
    this.player = null;
    this.scheduledSegments.clear();
    this.pumpingEpoch = null;
    this.pending = null;
  }

  private async begin(source?: TtsSourceRef): Promise<TtsSafeError | null> {
    if (this.disposed) return null;
    this.resetPlayback();
    const epoch = this.epoch;
    this.pending = {
      kind: source ? "read-aloud" : "preview",
      chatId: source?.chatId ?? null,
      snapshot: null,
    };
    const player = this.createPlayer(() => {
      if (!this.current(epoch)) return;
      this.syncPlayback();
      void this.pump();
    });
    this.player = player;
    this.patch({ job: null, busy: true, playing: false, paused: false, error: null });
    try {
      // Prime from the click gesture, before status or provider awaits.
      await player.prime();
      if (!this.current(epoch)) return null;
      if (source && !this.state.status) await this.refreshStatus(source.chatId);
      if (!this.current(epoch)) return null;
      const result = source
        ? await this.api.start({
            requestId: crypto.randomUUID(),
            source,
            settingsRevision: this.state.status?.settingsRevision ?? "",
          })
        : await this.api.preview();
      if (!this.current(epoch)) return null;
      if (!result.ok) {
        this.resetPlayback();
        this.patch({ busy: false, error: result.error });
        return result.error;
      }
      const pending = this.pending?.snapshot;
      this.pending = null;
      this.acceptSnapshot(pending?.jobId === result.snapshot.jobId ? pending : result.snapshot);
      return null;
    } catch {
      if (!this.current(epoch)) return null;
      this.stop();
      this.patch({ error: PLAYBACK_ERROR });
      return PLAYBACK_ERROR;
    }
  }

  start(source: TtsSourceRef): Promise<TtsSafeError | null> {
    return this.begin(source);
  }
  preview(): Promise<TtsSafeError | null> {
    return this.begin();
  }

  async pause(): Promise<void> {
    const epoch = this.epoch;
    if (this.disposed || !this.player || !this.state.job) return;
    this.patch({ paused: true, playing: false, busy: false });
    try {
      await this.player.pause();
      if (!this.current(epoch)) return;
      // Main may have finished generation already; local pause still succeeds.
      const snapshot = await this.api.pause();
      if (this.current(epoch) && snapshot?.jobId === this.state.job?.jobId)
        this.patch({ job: snapshot });
    } catch {
      if (this.current(epoch)) {
        this.stop();
        this.patch({ error: PLAYBACK_ERROR });
      }
    }
  }

  async resume(): Promise<void> {
    const epoch = this.epoch;
    if (this.disposed || !this.player || !this.state.job) return;
    try {
      await this.player.resume();
      if (!this.current(epoch)) return;
      this.patch({ paused: false });
      const snapshot = await this.api.resume();
      if (!this.current(epoch)) return;
      if (snapshot?.jobId === this.state.job?.jobId) this.patch({ job: snapshot });
      this.syncPlayback();
      void this.pump();
    } catch {
      if (this.current(epoch)) {
        this.stop();
        this.patch({ error: PLAYBACK_ERROR });
      }
    }
  }

  stop(): void {
    const owned =
      this.state.busy ||
      this.pending !== null ||
      (this.state.job !== null && !["cancelled", "failed"].includes(this.state.job.phase));
    this.resetPlayback();
    this.patch({ job: null, playing: false, paused: false, busy: false, error: null });
    if (owned) void this.api.stop().catch(() => undefined);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.statusEpoch += 1;
    this.listeners.clear();
  }
}

/** Cleanup revokes playback on navigation and is safe under StrictMode replay. */
export function useReadAloud(chatId: string | undefined): {
  state: ReadAloudState;
  controller: ReadAloudController;
} {
  const [controller] = React.useState(() => new ReadAloudController());
  const [state, setState] = React.useState(() => controller.head());
  React.useEffect(() => {
    controller.activate(chatId);
    const unsubscribe = controller.subscribe(setState);
    const unsubscribeEvent = ttsApi.onEvent((event) => controller.handleEvent(event));
    void controller.refreshStatus(chatId);
    return () => {
      unsubscribe();
      unsubscribeEvent();
      controller.dispose();
    };
  }, [controller, chatId]);
  return { state, controller };
}
