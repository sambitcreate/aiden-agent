import {
  ASSISTANT_LIVE_MAX_NOTE_CHARS,
  ASSISTANT_LIVE_MAX_TOOL_RESULT_BYTES,
  type AssistantLiveStartIntent,
} from "../../renderer/shared/assistant-live.js";
import { GEMINI_LIVE_MAX_JPEG_BYTES } from "../services/gemini-live/protocol.js";

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
    !exactKeys(value, "screen" in value ? ["computerUseAuthorization", "microphone", "screen"] : ["computerUseAuthorization", "microphone"]) ||
    ("screen" in value && typeof value.screen !== "boolean") ||
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
    ...("screen" in value ? { screen: value.screen as boolean } : {}),
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

export interface AssistantLiveFrameIntent {
  sessionId: string;
  frame: Uint8Array;
}

export function parseAssistantLiveFrameIntent(value: unknown): AssistantLiveFrameIntent {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["frame", "sessionId"]) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length < 1 ||
    value.sessionId.length > 128 ||
    !(value.frame instanceof Uint8Array) ||
    value.frame.byteLength < 4 ||
    value.frame.byteLength > GEMINI_LIVE_MAX_JPEG_BYTES
  ) {
    throw new Error("Invalid Assistant Live frame request.");
  }
  return { sessionId: value.sessionId, frame: Uint8Array.from(value.frame) };
}

export function parseAssistantLiveEmptyIntent(
  value: unknown,
  name: string,
): void {
  if (!isRecord(value) || !exactKeys(value, [])) {
    throw new Error(`Invalid Assistant Live ${name} request.`);
  }
}

export function parseAssistantLiveDisplayReleaseIntent(
  value: unknown,
): { bindingId: string } {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["bindingId"]) ||
    typeof value.bindingId !== "string" ||
    value.bindingId.length < 1 ||
    value.bindingId.length > 128
  ) {
    throw new Error("Invalid Assistant Live display-release request.");
  }
  return { bindingId: value.bindingId };
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

export interface AssistantLiveToolResultIntent {
  sessionId: string;
  requestId: string;
  response: Record<string, unknown>;
}

export function parseAssistantLiveToolResultIntent(value: unknown): AssistantLiveToolResultIntent {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["requestId", "response", "sessionId"]) ||
    !validSessionId(value.sessionId) ||
    typeof value.requestId !== "string" ||
    !/^r[0-9]{1,9}$/u.test(value.requestId) ||
    !isRecord(value.response)
  ) {
    throw new Error("Invalid Assistant Live tool result.");
  }
  let json: string;
  try {
    json = JSON.stringify(value.response);
  } catch {
    throw new Error("Invalid Assistant Live tool result.");
  }
  if (Buffer.byteLength(json, "utf8") > ASSISTANT_LIVE_MAX_TOOL_RESULT_BYTES) {
    throw new Error("Assistant Live tool result is too large.");
  }
  return {
    sessionId: value.sessionId,
    requestId: value.requestId,
    response: JSON.parse(json) as Record<string, unknown>,
  };
}

export interface AssistantLiveNoteIntent {
  sessionId: string;
  text: string;
  /** Answer only once the note has reached Live, or false if it never does. */
  awaitDelivery?: true;
}

export function parseAssistantLiveNoteIntent(value: unknown): AssistantLiveNoteIntent {
  const awaitDelivery = isRecord(value) && "awaitDelivery" in value;
  if (
    !isRecord(value) ||
    !exactKeys(value, awaitDelivery ? ["awaitDelivery", "sessionId", "text"] : ["sessionId", "text"]) ||
    (awaitDelivery && value.awaitDelivery !== true) ||
    !validSessionId(value.sessionId) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text.length > ASSISTANT_LIVE_MAX_NOTE_CHARS
  ) {
    throw new Error("Invalid Assistant Live note.");
  }
  return awaitDelivery
    ? { sessionId: value.sessionId, text: value.text, awaitDelivery: true }
    : { sessionId: value.sessionId, text: value.text };
}
