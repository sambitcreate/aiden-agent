// Which on-device model the speech host holds, and the lifecycle events the
// pill and composer use for their "Loading model…" notice. Every path that
// drops the model (idle unload, release, crash, cancel or hang kill) goes
// through markUnloaded so a "ready" view never goes stale.

export interface LocalSpeechState {
  modelId: string;
  state: "loading" | "ready" | "failed" | "unloaded";
  error?: string;
}

export interface LocalSpeechLoadRequest {
  /** Call before each attempt: reports `loading` when this attempt must (re)load the model. */
  announceLoad(): void;
  /** The model is loaded and answered. */
  succeed(): void;
  /** Settles a pending load. A user cancel is not a failure and reports `unloaded`. */
  fail(error: unknown, options: { aborted: boolean }): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalSpeechModelState {
  private current: string | null = null;

  constructor(private readonly emit: (state: LocalSpeechState) => void) {}

  get loaded(): string | null {
    return this.current;
  }

  /** The host no longer holds a model; reports `unloaded` for the one it held. */
  markUnloaded(): void {
    const previous = this.current;
    this.current = null;
    if (previous) this.emit({ modelId: previous, state: "unloaded" });
  }

  request(modelId: string): LocalSpeechLoadRequest {
    let pending = false;
    return {
      announceLoad: () => {
        if (pending || this.current === modelId) return;
        pending = true;
        this.emit({ modelId, state: "loading" });
      },
      succeed: () => {
        const previous = this.current;
        this.current = modelId;
        if (previous && previous !== modelId) this.emit({ modelId: previous, state: "unloaded" });
        if (!pending) return;
        pending = false;
        this.emit({ modelId, state: "ready" });
      },
      fail: (error, { aborted }) => {
        if (!pending) return;
        pending = false;
        this.emit(aborted ? { modelId, state: "unloaded" } : { modelId, state: "failed", error: errorMessage(error) });
      },
    };
  }
}
