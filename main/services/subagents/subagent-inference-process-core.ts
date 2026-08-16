import type {
  AssistantMessageEventStream,
  Model,
  Api,
  AssistantMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  SubagentInferenceStartMessage,
  SubagentInferenceWorkerMessage,
} from "./subagent-inference-protocol.js";
import {
  isSubagentInferenceWorkerMessage,
  expandAssistantMessageEvent,
  MAX_SUBAGENT_INFERENCE_MESSAGE_BYTES,
  SUBAGENT_INFERENCE_PROTOCOL_VERSION,
} from "./subagent-inference-protocol.js";

const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 750;

export interface KillableInferenceProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  terminate(): boolean;
  killHard(pid: number): void;
  isAlive(pid: number): boolean;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

export type LaunchInferenceProcess = (
  request: SubagentInferenceStartMessage,
) => Promise<KillableInferenceProcess>;

export interface SubagentInferenceHooks {
  model: Model<Api>;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  onTerminal?: (message: AssistantMessage) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SubagentInferenceProcessOwner {
  private readonly active = new Map<Promise<void>, AbortController>();
  private cleanupHealthy = true;

  constructor(
    private readonly launch: LaunchInferenceProcess,
    private readonly timing = {
      termGraceMs: TERM_GRACE_MS,
      killGraceMs: KILL_GRACE_MS,
    },
    private readonly onCleanupFailure: (error: Error) => void = () => {},
  ) {}

  stream(
    request: SubagentInferenceStartMessage,
    hooks: SubagentInferenceHooks,
    signal?: AbortSignal,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    const cancellation = new AbortController();
    const forwardAbort = () => cancellation.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const run = this.run(request, output, hooks, cancellation.signal);
    this.active.set(run, cancellation);
    void run.finally(() => {
      signal?.removeEventListener("abort", forwardAbort);
      this.active.delete(run);
    });
    return output;
  }

  private async run(
    request: SubagentInferenceStartMessage,
    output: ReturnType<typeof createAssistantMessageEventStream>,
    hooks: SubagentInferenceHooks,
    signal?: AbortSignal,
  ): Promise<void> {
    let process: KillableInferenceProcess | undefined;
    let terminal = false;
    let terminalEvent: import("@earendil-works/pi-ai").AssistantMessageEvent | undefined;
    let expectedSequence = 0;
    let partialMessage: AssistantMessage | undefined;
    let wireBytes = 0;
    let exited = false;
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolve) => (resolveExit = resolve));
    const cleanup: Array<() => void> = [];
    const finishExit = () => {
      if (exited) return;
      exited = true;
      resolveExit();
    };
    const terminate = async () => {
      if (!process || exited) return;
      try {
        process.postMessage({
          kind: "cancel",
          version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
          requestId: request.requestId,
        });
      } catch {
        // The process may already have stopped reading its IPC channel.
      }
      await Promise.race([exit, delay(this.timing.termGraceMs)]);
      if (!exited) process.terminate();
      await Promise.race([exit, delay(this.timing.killGraceMs)]);
      const pid = process.pid;
      if (!exited && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.killHard(pid);
        } catch {
          // ESRCH means the process has already exited; the exit listener remains authoritative.
        }
      }
      await Promise.race([exit, delay(this.timing.killGraceMs)]);
      if (!exited && typeof pid === "number" && process.isAlive(pid)) {
        throw new Error("The isolated subagent inference process could not be stopped.");
      }
      if (!exited) finishExit();
    };
    const fail = (message: string) => {
      if (terminal) return;
      terminal = true;
      const reason: "aborted" | "error" = signal?.aborted ? "aborted" : "error";
      const error: AssistantMessage = {
        role: "assistant",
        content: [],
        api: request.model.api,
        provider: request.model.provider,
        model: request.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: reason,
        errorMessage: message,
        timestamp: Date.now(),
      };
      terminalEvent = { type: "error", reason, error };
    };
    let stopping: Promise<void> | undefined;
    const stopOwnedProcess = () =>
      (stopping ??= (async () => {
        try {
          await terminate();
        } catch (error) {
          this.cleanupHealthy = false;
          this.onCleanupFailure(
            error instanceof Error ? error : new Error("Subagent inference cleanup failed."),
          );
        }
      })());
    const onAbort = () => void stopOwnedProcess();
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("Subagent inference cancelled.");
      process = await this.launch(request);
      cleanup.push(
        process.onExit(() => finishExit()),
        process.onError((error) => {
          fail(error.message);
          void stopOwnedProcess();
        }),
        process.onMessage((raw) => {
          if (!isSubagentInferenceWorkerMessage(raw) || raw.requestId !== request.requestId) {
            fail("The isolated subagent inference process sent an invalid message.");
            void stopOwnedProcess();
            return;
          }
          try {
            wireBytes += Buffer.byteLength(JSON.stringify(raw));
          } catch {
            fail("The isolated subagent inference process sent an invalid message.");
            void stopOwnedProcess();
            return;
          }
          if (wireBytes > MAX_SUBAGENT_INFERENCE_MESSAGE_BYTES) {
            fail("The isolated subagent inference stream exceeded its IPC budget.");
            void stopOwnedProcess();
            return;
          }
          const message = raw as SubagentInferenceWorkerMessage;
          if (message.kind === "failure") {
            fail(message.message);
            process?.postMessage({
              kind: "terminal-ack",
              version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
              requestId: request.requestId,
            });
            // A terminal frame is not process-settlement proof. Own the child
            // through its normal exit and escalate if it lingers after ACK.
            void stopOwnedProcess();
            return;
          }
          if (message.kind === "hook") {
            void (async () => {
              let payload: unknown;
              if (message.hook === "payload") {
                payload = await hooks.onPayload?.(message.payload, hooks.model);
              } else if (hooks.onResponse) {
                const response = message.payload as {
                  status: number;
                  headers: Record<string, string>;
                };
                await hooks.onResponse(response, hooks.model);
              }
              process?.postMessage({
                kind: "hook-result",
                version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
                requestId: request.requestId,
                callId: message.callId,
                ...(payload === undefined ? {} : { payload }),
              });
            })().catch(() => {
              fail("A main-owned provider hook failed.");
              void stopOwnedProcess();
            });
            return;
          }
          if (message.sequence !== expectedSequence++) {
            fail("The isolated subagent inference stream was out of sequence.");
            void terminate();
            return;
          }
          let event: import("@earendil-works/pi-ai").AssistantMessageEvent;
          try {
            const expanded = expandAssistantMessageEvent(message.event, partialMessage);
            event = expanded.event;
            partialMessage = expanded.partial;
          } catch {
            fail("The isolated provider stream could not be reconstructed.");
            void stopOwnedProcess();
            return;
          }
          if (event.type === "done" || event.type === "error") {
            terminal = true;
            terminalEvent = event;
            process?.postMessage({
              kind: "terminal-ack",
              version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
              requestId: request.requestId,
            });
            void stopOwnedProcess();
          } else {
            output.push(event);
          }
        }),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        await stopOwnedProcess();
        throw signal.reason ?? new Error("Subagent inference cancelled.");
      }
      process.postMessage(request);
      await exit;
      if (!terminal) fail("The isolated subagent inference process exited before completion.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not start isolated subagent inference.");
      await stopOwnedProcess();
    } finally {
      if (terminalEvent) {
        if (terminalEvent.type === "done") {
          try {
            hooks.onTerminal?.(terminalEvent.message);
          } catch {
            // Result observation must not suppress Pi's terminal event.
          }
          output.push(terminalEvent);
        } else if (terminalEvent.type === "error") {
          try {
            hooks.onTerminal?.(terminalEvent.error);
          } catch {
            // Result observation must not suppress Pi's terminal event.
          }
          output.push(terminalEvent);
        }
      }
      signal?.removeEventListener("abort", onAbort);
      for (const dispose of cleanup) {
        try {
          dispose();
        } catch {
          // Listener cleanup cannot change the verified process outcome.
        }
      }
    }
  }

  async shutdown(): Promise<boolean> {
    for (const cancellation of this.active.values()) {
      cancellation.abort(new Error("Subagent inference is shutting down."));
    }
    await Promise.race([
      Promise.allSettled([...this.active.keys()]),
      delay(this.timing.termGraceMs + this.timing.killGraceMs * 2 + 250),
    ]);
    return this.active.size === 0 && this.cleanupHealthy;
  }
}
