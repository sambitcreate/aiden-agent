import { performance } from "node:perf_hooks";
import type {
  AssistantMessageEventStream,
  Model,
  Api,
  AssistantMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { markPiRuntimePrivateFailure } from "../pi-runtime-failure.js";
import { MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS } from "./subagent-startup-retry.js";
import type { SubagentProcessDiagnostic } from "./subagent-runtime-diagnostics.js";
import type { ProviderFailureCategoryV1 } from "../../../renderer/shared/provider-failure.js";
import type {
  SubagentInferenceStartMessage,
  SubagentInferenceWorkerMessage,
} from "./subagent-inference-protocol.js";
import {
  isSubagentInferenceWorkerMessage,
  expandAssistantMessageEvent,
  MAX_SUBAGENT_INFERENCE_MESSAGE_BYTES,
  SubagentInferenceOutboundBudget,
  SUBAGENT_INFERENCE_PROTOCOL_VERSION,
} from "./subagent-inference-protocol.js";

const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 750;

export interface KillableInferenceProcess {
  /** Prove that this handle is bound to the exact launched OS process. */
  isLaunchVerified(): boolean;
  postMessage(message: unknown): void;
  terminate(): boolean;
  /** Hard-kill only the launch identity captured by this owned handle. */
  killHard(): void;
  /** Prove the captured launch identity is gone; throw when proof is indeterminate. */
  hasExited(): boolean;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  /** Bounded, pre-ready process evidence; never exposed outside main. */
  startupDiagnostic?(): string | undefined;
}

export type LaunchInferenceProcess = (
  request: SubagentInferenceStartMessage,
  signal?: AbortSignal,
) => Promise<KillableInferenceProcess>;

export interface SubagentInferenceHooks {
  model: Model<Api>;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  onTerminal?: (
    message: AssistantMessage,
    metadata: {
      authenticationFailure: boolean;
      providerFailureCategory?: ProviderFailureCategoryV1;
    },
  ) => void;
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
    const startedAt = performance.now();
    let process: KillableInferenceProcess | undefined;
    let terminal = false;
    let terminalEvent: import("@earendil-works/pi-ai").AssistantMessageEvent | undefined;
    let terminalAuthenticationFailure = false;
    let terminalProviderFailureCategory: ProviderFailureCategoryV1 | undefined;
    let expectedSequence = 0;
    let partialMessage: AssistantMessage | undefined;
    let wireBytes = 0;
    let workerMessageObserved = false;
    let exitCode: number | null | undefined;
    const outboundBudget = new SubagentInferenceOutboundBudget();
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
      if (!exited) {
        try {
          process.killHard();
        } catch {
          // An already-exited process is confirmed by the owned handle below.
        }
      }
      await Promise.race([exit, delay(this.timing.killGraceMs)]);
      if (!exited) {
        if (!process.hasExited()) {
          throw new Error("The isolated subagent inference process could not be stopped.");
        }
        finishExit();
      }
    };
    const setFailure = (
      message: string,
      reason: "aborted" | "error",
      privateFailure?: "inference-startup" | "inference" | "policy",
      diagnostic?: SubagentProcessDiagnostic,
    ) => {
      terminal = true;
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
      terminalEvent = {
        type: "error",
        reason,
        error: privateFailure
          ? markPiRuntimePrivateFailure(error, privateFailure, diagnostic)
          : error,
      };
    };
    const fail = (
      message: string,
      privateFailure?: "inference" | "policy",
      diagnostic?: SubagentProcessDiagnostic,
    ) => {
      if (terminal) return;
      setFailure(
        message,
        signal?.aborted ? "aborted" : "error",
        signal?.aborted ? undefined : privateFailure,
        signal?.aborted ? undefined : diagnostic,
      );
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
    const onAbort = () => {
      terminalAuthenticationFailure = false;
      setFailure("Subagent inference cancelled.", "aborted");
      void stopOwnedProcess();
    };
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("Subagent inference cancelled.");
      process = await this.launch(request, signal);
      if (!process.isLaunchVerified()) {
        throw new Error("The isolated inference process launch identity could not be verified.");
      }
      cleanup.push(
        process.onExit((code) => {
          exitCode = code;
          finishExit();
        }),
        process.onError((error) => {
          fail(error.message, "inference", {
            stage: workerMessageObserved ? "runtime" : "bootstrap",
            code: "worker_fatal",
            durationMs: performance.now() - startedAt,
            detail: process?.startupDiagnostic?.() ?? error.message,
          });
          void stopOwnedProcess();
        }),
        process.onMessage((raw) => {
          // Cancellation owns the terminal outcome. A provider process may
          // race a final frame with cooperative/forced shutdown; accepting it
          // could incorrectly advance Pi into another tool/provider turn.
          if (signal?.aborted || terminal) return;
          workerMessageObserved = true;
          if (!isSubagentInferenceWorkerMessage(raw) || raw.requestId !== request.requestId) {
            fail("The isolated subagent inference process sent an invalid message.", "inference", {
              stage: "protocol",
              code: "invalid_message",
              durationMs: performance.now() - startedAt,
            });
            void stopOwnedProcess();
            return;
          }
          try {
            wireBytes += Buffer.byteLength(JSON.stringify(raw));
          } catch {
            fail("The isolated subagent inference process sent an invalid message.", "inference");
            void stopOwnedProcess();
            return;
          }
          if (wireBytes > MAX_SUBAGENT_INFERENCE_MESSAGE_BYTES) {
            fail("The isolated subagent inference stream exceeded its IPC budget.", "inference", {
              stage: "protocol",
              code: "ipc_budget_exceeded",
              durationMs: performance.now() - startedAt,
            });
            void stopOwnedProcess();
            return;
          }
          const message = raw as SubagentInferenceWorkerMessage;
          if (message.kind === "ready") {
            try {
              const acknowledgement = {
                kind: "ready-ack",
                version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
                requestId: request.requestId,
              } as const;
              outboundBudget.consume(acknowledgement);
              process?.postMessage(acknowledgement);
            } catch {
              fail("The isolated inference readiness acknowledgement failed.", "inference", {
                stage: "protocol",
                code: "readiness_ack_failed",
                durationMs: performance.now() - startedAt,
              });
              void stopOwnedProcess();
            }
            return;
          }
          if (message.kind === "failure") {
            terminalProviderFailureCategory = undefined;
            fail(message.message, "inference", {
              stage: "runtime",
              code: "worker_fatal",
              durationMs: performance.now() - startedAt,
            });
            try {
              const acknowledgement = {
                kind: "terminal-ack",
                version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
                requestId: request.requestId,
              } as const;
              process?.postMessage(acknowledgement);
            } catch {
              setFailure(
                "The isolated inference terminal acknowledgement failed.",
                "error",
                "inference",
                {
                  stage: "protocol",
                  code: "terminal_ack_failed",
                  durationMs: performance.now() - startedAt,
                },
              );
            }
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
              const reply = {
                kind: "hook-result",
                version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
                requestId: request.requestId,
                callId: message.callId,
                ...(payload === undefined ? {} : { payload }),
              } as const;
              outboundBudget.consume(reply);
              process?.postMessage(reply);
            })().catch(() => {
              fail("A main-owned provider hook failed.", "policy", {
                stage: "provider_hook",
                code: "provider_hook_failed",
                durationMs: performance.now() - startedAt,
              });
              void stopOwnedProcess();
            });
            return;
          }
          if (message.sequence !== expectedSequence++) {
            fail("The isolated subagent inference stream was out of sequence.", "inference", {
              stage: "protocol",
              code: "invalid_message",
              durationMs: performance.now() - startedAt,
            });
            void terminate();
            return;
          }
          let event: import("@earendil-works/pi-ai").AssistantMessageEvent;
          try {
            const expanded = expandAssistantMessageEvent(message.event, partialMessage);
            event = expanded.event;
            partialMessage = expanded.partial;
          } catch {
            fail("The isolated provider stream could not be reconstructed.", "inference", {
              stage: "protocol",
              code: "stream_reconstruction_failed",
              durationMs: performance.now() - startedAt,
            });
            void stopOwnedProcess();
            return;
          }
          if (event.type === "done" || event.type === "error") {
            terminal = true;
            terminalEvent = event;
            terminalAuthenticationFailure = message.authenticationFailure === true;
            terminalProviderFailureCategory = message.providerFailureCategory;
            const acknowledgement = {
              kind: "terminal-ack",
              version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
              requestId: request.requestId,
            } as const;
            try {
              process?.postMessage(acknowledgement);
            } catch {
              terminalAuthenticationFailure = false;
              terminalProviderFailureCategory = undefined;
              setFailure(
                "The isolated inference terminal acknowledgement failed.",
                "error",
                "inference",
                {
                  stage: "protocol",
                  code: "terminal_ack_failed",
                  durationMs: performance.now() - startedAt,
                },
              );
            }
            void stopOwnedProcess();
          } else {
            output.push(event);
          }
        }),
      );
      if (process.hasExited()) finishExit();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        await stopOwnedProcess();
        throw signal.reason ?? new Error("Subagent inference cancelled.");
      }
      outboundBudget.consume(request);
      process.postMessage(request);
      await exit;
      if (!terminal) {
        const durationMs = performance.now() - startedAt;
        const retryableStartupExit =
          !workerMessageObserved &&
          typeof exitCode === "number" &&
          exitCode !== 0 &&
          durationMs >= 0 &&
          durationMs <= MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS &&
          !signal?.aborted;
        setFailure(
          "The isolated subagent inference process exited before completion.",
          signal?.aborted ? "aborted" : "error",
          signal?.aborted ? undefined : retryableStartupExit ? "inference-startup" : "inference",
          signal?.aborted
            ? undefined
            : {
                stage: workerMessageObserved ? "runtime" : "bootstrap",
                code: retryableStartupExit ? "pre_ready_exit" : "worker_exit",
                durationMs,
                exitCode,
                detail: process.startupDiagnostic?.(),
              },
        );
      }
    } catch (error) {
      fail(
        error instanceof Error ? error.message : "Could not start isolated subagent inference.",
        "inference",
        {
          stage: "launch",
          code: "launch_failed",
          durationMs: performance.now() - startedAt,
          detail:
            process?.startupDiagnostic?.() ?? (error instanceof Error ? error.message : undefined),
        },
      );
      await stopOwnedProcess();
    } finally {
      if (terminalEvent) {
        if (terminalEvent.type === "done") {
          try {
            hooks.onTerminal?.(terminalEvent.message, {
              authenticationFailure: terminalAuthenticationFailure,
              ...(terminalProviderFailureCategory
                ? { providerFailureCategory: terminalProviderFailureCategory }
                : {}),
            });
          } catch {
            // Result observation must not suppress Pi's terminal event.
          }
          output.push(terminalEvent);
        } else if (terminalEvent.type === "error") {
          try {
            hooks.onTerminal?.(terminalEvent.error, {
              authenticationFailure: terminalAuthenticationFailure,
              ...(terminalProviderFailureCategory
                ? { providerFailureCategory: terminalProviderFailureCategory }
                : {}),
            });
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
