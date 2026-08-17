import type { AssistantMessage } from "@earendil-works/pi-ai";

export type PiRuntimePrivateFailure = "inference-startup" | "inference" | "policy";

const PI_RUNTIME_PRIVATE_FAILURE = Symbol("aiden.pi-runtime-private-failure");

type MarkedAssistantMessage = AssistantMessage & {
  [PI_RUNTIME_PRIVATE_FAILURE]?: PiRuntimePrivateFailure;
};

/** Keep host-only failure provenance off JSON, IPC, logs, and Pi journal payloads. */
export function markPiRuntimePrivateFailure(
  message: AssistantMessage,
  failure: PiRuntimePrivateFailure,
): AssistantMessage {
  Object.defineProperty(message, PI_RUNTIME_PRIVATE_FAILURE, {
    value: failure,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return message;
}

export function piRuntimePrivateFailure(
  message: AssistantMessage,
): PiRuntimePrivateFailure | undefined {
  return (message as MarkedAssistantMessage)[PI_RUNTIME_PRIVATE_FAILURE];
}
