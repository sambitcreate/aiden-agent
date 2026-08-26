export interface GeminiLiveTranscriptSnapshot {
  committed: string;
  tentative: string;
}

export interface GeminiLiveServerMessageLike {
  serverContent?: {
    interimInputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
    turnComplete?: boolean;
  };
  usageMetadata?: unknown;
}

/**
 * Finalization starts after a documented authoritative final segment or Gemini's
 * supplementary turn-complete signal. Every later transcript update restarts
 * the manager's quiet-period timer.
 */
export class GeminiLiveFinalizationGate {
  private completionObserved = false;

  observe(update: { changed: boolean; finalized: boolean; turnComplete: boolean }): boolean {
    if (update.finalized || update.turnComplete) this.completionObserved = true;
    return this.completionObserved && (update.changed || update.finalized || update.turnComplete);
  }
}

interface ClosableLiveSession {
  close(): void;
}

/** Bound the SDK's open/setup waits and close a session that resolves after abandonment. */
export async function waitForLiveStartup<T extends ClosableLiveSession>(
  connection: Promise<T>,
  startupFailure: Promise<never>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Gemini Live transcription timed out while connecting.")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([connection, startupFailure, timeout]);
  } catch (error) {
    void connection
      .then((lateSession) => {
        try {
          lateSession.close();
        } catch {
          /* best effort */
        }
      })
      .catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface OwnerBindingRecord {
  settled: boolean;
  removeOwnerInvalidation: () => void;
}

interface InvalidatableOwnerLike {
  isDestroyed(): boolean;
  onInvalidated(listener: () => void): () => void;
}

/** Publish before subscribing because onInvalidated may revoke synchronously. */
export function bindOwnerInvalidation(
  record: OwnerBindingRecord,
  owner: InvalidatableOwnerLike,
  publish: () => void,
  cancel: () => void,
): boolean {
  publish();
  const removeOwnerInvalidation = owner.onInvalidated(cancel);
  if (record.settled || owner.isDestroyed()) {
    removeOwnerInvalidation();
    cancel();
    return false;
  }
  record.removeOwnerInvalidation = removeOwnerInvalidation;
  return true;
}

function appendTranscript(left: string, right: string): string {
  const next = right.trim();
  if (!next) return left;
  if (!left) return next;
  return `${left.trimEnd()} ${next}`;
}

/** Accumulates append-only final segments plus the replaceable interim hypothesis. */
export class GeminiLiveTranscriptAccumulator {
  private committed = "";
  private tentative = "";
  usage: unknown;

  consume(message: GeminiLiveServerMessageLike): {
    changed: boolean;
    finalized: boolean;
    turnComplete: boolean;
    snapshot: GeminiLiveTranscriptSnapshot;
  } {
    const content = message.serverContent;
    let changed = false;
    let finalized = false;
    const interim = content?.interimInputTranscription?.text;
    if (typeof interim === "string" && interim.trim() !== this.tentative) {
      this.tentative = interim.trim();
      changed = true;
    }
    const final = content?.inputTranscription?.text;
    if (typeof final === "string" && final.trim()) {
      this.committed = appendTranscript(this.committed, final);
      this.tentative = "";
      changed = true;
      finalized = true;
    }
    if (message.usageMetadata !== undefined) this.usage = message.usageMetadata;
    return {
      changed,
      finalized,
      turnComplete: content?.turnComplete === true,
      snapshot: this.snapshot(),
    };
  }

  snapshot(): GeminiLiveTranscriptSnapshot {
    return { committed: this.committed, tentative: this.tentative };
  }

  fullText(): string {
    return appendTranscript(this.committed, this.tentative).trim();
  }
}

export function decodePcm16Chunk(value: unknown, maxBytes = 64 * 1024): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("PCM audio chunk must be a non-empty base64 string.");
  }
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error("PCM audio chunk is too large.");
  }
  const normalized = value.replace(/=+$/u, "");
  if (!/^[A-Za-z0-9+/]+$/u.test(normalized)) {
    throw new Error("PCM audio chunk is not valid base64.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.length % 2 !== 0) {
    throw new Error("PCM audio chunk must contain 16-bit samples within the size limit.");
  }
  return bytes;
}
