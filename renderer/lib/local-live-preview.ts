// Live dictation text for on-device models that can decode while the user
// speaks (Parakeet on Metal). The PCM recorder hands each 100 ms chunk here;
// chunks go to main in small ordered batches and main answers with
// `voice:stream-text`. The preview is a courtesy: when it cannot start or keep
// up it simply stops, and the final transcription is unaffected.

import { voiceApi } from "./ipc-voice";
import type { LiveTranscriptSnapshot } from "./live-pcm-capture";
import { pcm16FromChunks } from "./pcm-recorder";

/** 200 ms per push keeps IPC traffic low without delaying the words. */
const BATCH_CHUNKS = 2;
/** Ten seconds of unsent audio means main is not keeping up; give up on the preview. */
const MAX_UNSENT_CHUNKS = 100;

export class LocalLivePreview {
  private sessionId: string | null = null;
  private ended = false;
  private sending = false;
  private queued: Uint8Array[] = [];
  private unsubscribe: (() => void) | null = null;

  private constructor(private readonly onSnapshot: (snapshot: LiveTranscriptSnapshot) => void) {}

  /** Starts at once; audio pushed before main answers is held and sent after. */
  static start(modelId: string, onSnapshot: (snapshot: LiveTranscriptSnapshot) => void): LocalLivePreview {
    const preview = new LocalLivePreview(onSnapshot);
    voiceApi.localLiveStart(modelId).then(
      (started) => preview.begin(started),
      () => preview.stop(),
    );
    return preview;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) return;
    this.queued.push(chunk);
    if (this.queued.length > MAX_UNSENT_CHUNKS) {
      this.stop();
      return;
    }
    this.flush();
  }

  /** Ends the preview. Its last words stay wherever the caller shows them. */
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.queued = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sessionId) void voiceApi.localLiveStop(this.sessionId).catch(() => {});
  }

  private begin(started: { sessionId: string } | null): void {
    if (!started) {
      // This model is not fast enough to preview; dictation still works.
      this.ended = true;
      this.queued = [];
      return;
    }
    if (this.ended) {
      void voiceApi.localLiveStop(started.sessionId).catch(() => {});
      return;
    }
    this.sessionId = started.sessionId;
    this.unsubscribe = voiceApi.onStreamText((payload) => {
      if (this.ended || payload.sessionId !== started.sessionId) return;
      this.onSnapshot({ committed: payload.committed, tentative: payload.tentative });
    });
    this.flush();
  }

  private flush(): void {
    if (this.ended || this.sending || !this.sessionId || this.queued.length < BATCH_CHUNKS) return;
    const batch = this.queued.splice(0);
    this.sending = true;
    voiceApi.localLivePush(this.sessionId, pcm16FromChunks(batch).buffer).then(
      () => {
        this.sending = false;
        this.flush();
      },
      () => this.stop(),
    );
  }
}
