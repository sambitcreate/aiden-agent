import { randomUUID } from "node:crypto";
import {
  isParakeetWorkerMessage,
  PARAKEET_PROTOCOL_VERSION,
  type ParakeetParentMessage,
  type ParakeetWorkerMessage,
} from "./parakeet-protocol.js";

export const PARAKEET_REQUEST_TIMEOUT_MS = 120_000;

export interface ParakeetProcessPort {
  postMessage: (message: ParakeetParentMessage) => void;
  onMessage: (handler: (message: unknown) => void) => () => void;
  onExit: (handler: (code: number) => void) => () => void;
  kill: () => void;
}

export class ParakeetProcessClient {
  private readonly pending = new Map<
    string,
    { resolve: (message: ParakeetWorkerMessage) => void; reject: (error: Error) => void }
  >();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeExit: () => void;
  private closed = false;

  constructor(
    private readonly port: ParakeetProcessPort,
    private readonly timeoutMs: number = PARAKEET_REQUEST_TIMEOUT_MS,
  ) {
    this.unsubscribeMessage = port.onMessage((raw) => {
      if (!isParakeetWorkerMessage(raw)) return;
      const pending = this.pending.get(raw.requestId);
      if (!pending) return;
      this.pending.delete(raw.requestId);
      pending.resolve(raw);
    });
    this.unsubscribeExit = port.onExit((code) => {
      this.failAll(new Error(`On-device transcription process exited (${code}).`));
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request(
    message:
      | { kind: "status" }
      | { kind: "release"; modelId: string }
      | { kind: "transcribe"; modelId: string; modelDirectory: string; pcmBase64: string },
  ) {
    if (this.closed) return Promise.reject(new Error("On-device transcription process is closed."));
    const requestId = randomUUID();
    const payload = {
      ...message,
      requestId,
      version: PARAKEET_PROTOCOL_VERSION,
    } as ParakeetParentMessage;
    return new Promise<ParakeetWorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("On-device transcription timed out."));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.port.postMessage(payload);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async status(): Promise<{ ready: boolean; error: string | null }> {
    const result = await this.request({ kind: "status" });
    if (result.kind === "failure") throw new Error(result.message);
    return { ready: result.ready === true, error: result.error ?? null };
  }

  async transcribe(input: {
    modelId: string;
    modelDirectory: string;
    pcmBase64: string;
  }): Promise<string> {
    const result = await this.request({
      kind: "transcribe",
      modelId: input.modelId,
      modelDirectory: input.modelDirectory,
      pcmBase64: input.pcmBase64,
    });
    if (result.kind === "failure") throw new Error(result.message);
    return result.text ?? "";
  }

  async release(modelId: string): Promise<void> {
    const result = await this.request({ kind: "release", modelId });
    if (result.kind === "failure") throw new Error(result.message);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeMessage();
    this.unsubscribeExit();
    this.failAll(new Error("On-device transcription process closed."));
    this.port.kill();
  }
}
