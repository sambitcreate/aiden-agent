import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

/**
 * A small FIFO admission lane for memory-heavy local speech work. Admission is
 * synchronous, while operations settle serially, so callers cannot allocate or
 * decode multiple PCM buffers in parallel while another recognizer owns the Mac.
 */
export class AidenRemoteSpeechLane {
  private tail: Promise<void> = Promise.resolve();
  private admitted = 0;

  constructor(private readonly maximumAdmitted = 2) {
    if (!Number.isSafeInteger(maximumAdmitted) || maximumAdmitted < 1) {
      throw new Error("The speech admission limit must be a positive safe integer.");
    }
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.admitted >= this.maximumAdmitted) {
      throw new AidenRemoteServiceError(
        "rate_limited",
        "The Mac speech engine is busy. Try again in a moment.",
        429,
        true,
        { retryAfterSeconds: 2 },
      );
    }
    this.admitted += 1;

    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
      this.admitted -= 1;
    }
  }
}
