import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { isCodexAuthenticationFailure } from "../codex-auth-failure.js";
import {
  isSubagentInferenceParentMessage,
  compactAssistantMessageEvent,
  SubagentInferenceOutboundBudget,
  serializeError,
  SUBAGENT_INFERENCE_PROTOCOL_VERSION,
} from "./subagent-inference-protocol.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Subagent inference worker requires an Electron parent port.");

let active: { requestId: string; cancellation: AbortController } | undefined;
let nextCallId = 0;
const pendingHooks = new Map<number, (payload: unknown) => void>();
let resolveTerminalAck: (() => void) | undefined;
let outboundBudget = new SubagentInferenceOutboundBudget();

function post(message: unknown): void {
  outboundBudget.consume(message);
  parentPort.postMessage(message);
}

function postFailure(requestId: string, error: unknown): void {
  // The fixed failure frame remains available even when a provider frame was
  // rejected for exceeding the data budget.
  parentPort.postMessage({
    kind: "failure",
    version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
    requestId,
    message: serializeError(error),
  });
}

parentPort.on("message", (messageEvent) => {
  const message = messageEvent.data;
  if (!isSubagentInferenceParentMessage(message)) return;
  if (message.kind === "terminal-ack") {
    if (active?.requestId === message.requestId) resolveTerminalAck?.();
    return;
  }
  if (message.kind === "hook-result") {
    if (active?.requestId !== message.requestId) return;
    const resolve = pendingHooks.get(message.callId);
    if (!resolve) return;
    pendingHooks.delete(message.callId);
    resolve(message.payload);
    return;
  }
  if (message.kind === "cancel") {
    if (active?.requestId === message.requestId) active.cancellation.abort();
    return;
  }
  if (message.kind !== "start" || active) return;
  const cancellation = new AbortController();
  active = { requestId: message.requestId, cancellation };
  outboundBudget = new SubagentInferenceOutboundBudget();
  void (async () => {
    const terminalAck = new Promise<void>((resolve) => {
      resolveTerminalAck = resolve;
    });
    try {
      const invokeHook = (hook: "payload" | "response", payload: unknown) =>
        new Promise<unknown>((resolve) => {
          const callId = nextCallId++;
          pendingHooks.set(callId, resolve);
          post({
            kind: "hook",
            version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
            requestId: message.requestId,
            callId,
            hook,
            payload,
          });
        });
      const builtIn = builtinModels().getProvider(message.model.provider);
      const compatibility =
        message.model.api === "anthropic-messages"
          ? anthropicMessagesApi()
          : openAICompletionsApi();
      const stream = (builtIn ?? compatibility).streamSimple(message.model, message.context, {
        ...message.options,
        signal: cancellation.signal,
        onPayload: (payload) => invokeHook("payload", payload),
        onResponse: async (response) => {
          await invokeHook("response", response);
        },
      });
      let sequence = 0;
      let terminalSent = false;
      for await (const event of stream) {
        const safeEvent =
          event.type === "error"
            ? {
                ...event,
                error: {
                  ...event.error,
                  errorMessage:
                    event.reason === "aborted"
                      ? "The isolated provider request was cancelled."
                      : "The isolated provider request failed.",
                },
              }
            : event;
        const authenticationFailure =
          message.model.provider === "openai-codex" &&
          event.type === "error" &&
          isCodexAuthenticationFailure(event.error.errorMessage);
        post({
          kind: "event",
          version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
          requestId: message.requestId,
          sequence: sequence++,
          event: compactAssistantMessageEvent(safeEvent),
          ...(authenticationFailure ? { authenticationFailure: true } : {}),
        });
        if (event.type === "done" || event.type === "error") terminalSent = true;
      }
      if (terminalSent) {
        await Promise.race([
          terminalAck,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    } catch (error) {
      postFailure(message.requestId, error);
      await Promise.race([terminalAck, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    } finally {
      pendingHooks.clear();
      resolveTerminalAck = undefined;
      active = undefined;
      setImmediate(() => process.exit(0));
    }
  })();
});
