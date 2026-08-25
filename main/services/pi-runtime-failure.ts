import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SubagentProcessDiagnostic } from "./subagents/subagent-runtime-diagnostics.js";

export type PiRuntimePrivateFailure = "inference-startup" | "inference" | "policy";

const PI_RUNTIME_PRIVATE_FAILURE = Symbol("aiden.pi-runtime-private-failure");
const PI_RUNTIME_PRIVATE_DIAGNOSTIC = Symbol("aiden.pi-runtime-private-diagnostic");

type MarkedAssistantMessage = AssistantMessage & {
  [PI_RUNTIME_PRIVATE_FAILURE]?: PiRuntimePrivateFailure;
  [PI_RUNTIME_PRIVATE_DIAGNOSTIC]?: SubagentProcessDiagnostic;
};

/** Keep host-only failure provenance off JSON, IPC, and Pi journal payloads. */
export function markPiRuntimePrivateFailure(
  message: AssistantMessage,
  failure: PiRuntimePrivateFailure,
  diagnostic?: SubagentProcessDiagnostic,
): AssistantMessage {
  Object.defineProperty(message, PI_RUNTIME_PRIVATE_FAILURE, {
    value: failure,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  if (diagnostic) {
    Object.defineProperty(message, PI_RUNTIME_PRIVATE_DIAGNOSTIC, {
      value: diagnostic,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return message;
}

export function piRuntimePrivateFailure(
  message: AssistantMessage,
): PiRuntimePrivateFailure | undefined {
  return (message as MarkedAssistantMessage)[PI_RUNTIME_PRIVATE_FAILURE];
}

export function piRuntimePrivateDiagnostic(
  message: AssistantMessage,
): SubagentProcessDiagnostic | undefined {
  return (message as MarkedAssistantMessage)[PI_RUNTIME_PRIVATE_DIAGNOSTIC];
}
