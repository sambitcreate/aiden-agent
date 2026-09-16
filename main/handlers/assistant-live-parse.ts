import type { AssistantLiveStartIntent } from "../../renderer/shared/assistant-live.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseAssistantLiveStartIntent(value: unknown): AssistantLiveStartIntent {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["computerUseAuthorization", "microphone"]) ||
    typeof value.microphone !== "boolean" ||
    !(
      value.computerUseAuthorization === null ||
      (typeof value.computerUseAuthorization === "string" &&
        value.computerUseAuthorization.length >= 1 &&
        value.computerUseAuthorization.length <= 128)
    )
  ) {
    throw new Error("Invalid Assistant Live start request.");
  }
  return {
    microphone: value.microphone,
    computerUseAuthorization: value.computerUseAuthorization,
  };
}

export function parseAssistantLiveStopIntent(value: unknown): void {
  if (!isRecord(value) || !exactKeys(value, [])) {
    throw new Error("Invalid Assistant Live stop request.");
  }
}

export interface AssistantLiveAudioIntent {
  sessionId: string;
  pcm: Uint8Array;
}

export function parseAssistantLiveAudioIntent(value: unknown): AssistantLiveAudioIntent {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["pcm", "sessionId"]) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length < 1 ||
    value.sessionId.length > 128 ||
    !(value.pcm instanceof Uint8Array) ||
    value.pcm.byteLength !== 640
  ) {
    throw new Error("Invalid Assistant Live audio request.");
  }
  return { sessionId: value.sessionId, pcm: Uint8Array.from(value.pcm) };
}
