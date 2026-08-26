/** Invalidates async capture/transcription work when dictation is cancelled. */
export class DictationOperationGate {
  private generation = 0;
  private starting = false;

  beginStart(): number | null {
    if (this.starting) return null;
    this.starting = true;
    this.generation += 1;
    return this.generation;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  finishStart(token: number): void {
    if (this.isCurrent(token)) this.starting = false;
  }

  cancel(): void {
    this.generation += 1;
    this.starting = false;
  }
}

export const CLOUD_TRANSCRIPTION_BUDGET_MS = 45_000;
export const LOCAL_TRANSCRIPTION_BUDGET_MS = 125_000;

/** Parakeet owns a 120-second process timeout; leave IPC settlement headroom. */
export function transcriptionBudgetMs(provider: string): number {
  return provider === "local" ? LOCAL_TRANSCRIPTION_BUDGET_MS : CLOUD_TRANSCRIPTION_BUDGET_MS;
}

export async function withDictationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Transcription timed out. Press the dictation shortcut to retry.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One wall-clock budget shared by live finalization and batch fallback. */
export class DictationDeadline {
  private readonly expiresAt: number;

  constructor(
    timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.expiresAt = now() + Math.max(1, timeoutMs);
  }

  remaining(): number {
    return Math.max(0, this.expiresAt - this.now());
  }

  async run<T>(operation: Promise<T>, onTimeout?: () => void | Promise<void>): Promise<T> {
    const remaining = this.remaining();
    if (remaining <= 0) {
      void Promise.resolve(onTimeout?.()).catch(() => {
        // Cancellation is best effort; an expired deadline is already terminal.
      });
      throw transcriptionTimeoutError();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(transcriptionTimeoutError());
            void Promise.resolve(onTimeout?.()).catch(() => {
              // Cancellation is best effort; the wall-clock deadline remains terminal.
            });
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function transcriptionTimeoutError(): Error {
  return new Error("Transcription took too long. Try again with a shorter recording.");
}

/** Do not expose Electron's remote-method wrapper or provider internals in UI. */
export function voiceErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/iu, "")
    .replace(/^Error:\s*/iu, "")
    .trim();
  if (/providers|api key|set up google gemini/iu.test(message)) {
    return "Gemini needs an API key. Add it in Settings → Providers, then try again.";
  }
  if (/timed out|timeout/iu.test(message)) {
    return "Transcription took too long. Try again with a shorter recording.";
  }
  if (/cancel/iu.test(message)) return "Transcription was cancelled.";
  if (/no speech/iu.test(message)) return "No speech detected.";
  if (/on-device|parakeet|download and select/iu.test(message)) {
    return "On-device transcription isn’t ready. Download and select a model in Settings → Voice.";
  }
  if (/429|rate limit|quota/iu.test(message)) {
    return "The transcription service is busy or rate-limited. Try again shortly.";
  }
  if (/network|fetch|offline|connection/iu.test(message)) {
    return "Aiden couldn’t reach the transcription service. Check your connection and try again.";
  }
  // Provider/SDK errors are diagnostic input, not safe user-facing copy.
  return "Transcription failed. Try again.";
}

/** Prefer the final response, but never discard committed text already shown. */
export function recoverCommittedLiveTranscript(result: unknown, committed: unknown): string {
  const finalText = typeof result === "string" ? result.trim() : "";
  if (finalText) return finalText;
  return typeof committed === "string" ? committed.trim() : "";
}
