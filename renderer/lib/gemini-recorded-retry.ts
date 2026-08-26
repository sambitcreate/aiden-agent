export const GEMINI_RECORDED_RETRY_TITLE = "Retry Gemini transcription?";

export const GEMINI_RECORDED_RETRY_DESCRIPTION =
  "Live transcription couldn’t finish. Retry with the saved recording? This makes another Gemini API request and may incur cost.";

/** A denied or abandoned prompt must never leave transcription awaiting forever. */
export class GeminiRecordedRetryConsent {
  private pending: ((approved: boolean) => void) | null = null;

  request(): Promise<boolean> {
    this.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pending = resolve;
    });
  }

  resolve(approved: boolean): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(approved);
  }
}

export function needsGeminiRecordedRetry(
  liveAttempted: boolean,
  text: string,
  hasSavedRecording = true,
): boolean {
  return liveAttempted && hasSavedRecording && text.trim().length === 0;
}
