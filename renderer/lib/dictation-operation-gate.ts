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
          () => reject(new Error("Transcription timed out. Press the dictation shortcut to retry.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
