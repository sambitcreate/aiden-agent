export const AMBIENT_MUSIC_PROTOCOL_VERSION = 1;
export const MAX_AMBIENT_MUSIC_MESSAGE_BYTES = 128 * 1024;

export type AmbientMusicHelperMethod =
  | "hello"
  | "load"
  | "setPrompts"
  | "setWeights"
  | "setVolume"
  | "setDrumless"
  | "setVariation"
  | "setBenchmarkMode"
  | "play"
  | "pause"
  | "suspend"
  | "resume"
  | "stop"
  | "reset"
  | "metrics"
  | "idleUnload"
  | "unload"
  | "shutdown";

export interface AmbientMusicHelperRequest {
  version: typeof AMBIENT_MUSIC_PROTOCOL_VERSION;
  requestId: string;
  method: AmbientMusicHelperMethod;
  params: Record<string, unknown>;
}

export interface AmbientMusicHelperResponse {
  version: typeof AMBIENT_MUSIC_PROTOCOL_VERSION;
  type: "response";
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export type AmbientMusicHelperEventName =
  | "ready"
  | "remoteCommand"
  | "promptEncoding"
  | "audioState"
  | "fatal";

export interface AmbientMusicHelperEvent {
  version: typeof AMBIENT_MUSIC_PROTOCOL_VERSION;
  type: "event";
  event: AmbientMusicHelperEventName;
  sequence: number;
  detail: Record<string, unknown>;
}

export type AmbientMusicHelperMessage = AmbientMusicHelperResponse | AmbientMusicHelperEvent;

export class AmbientMusicProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AmbientMusicProtocolError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

export function parseAmbientMusicHelperMessage(line: string): AmbientMusicHelperMessage {
  if (Buffer.byteLength(line, "utf8") > MAX_AMBIENT_MUSIC_MESSAGE_BYTES) {
    throw new AmbientMusicProtocolError("message_too_large", "The Ambient Music helper message is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new AmbientMusicProtocolError("invalid_json", "The Ambient Music helper returned invalid JSON.");
  }
  if (!isObject(parsed) || parsed.version !== AMBIENT_MUSIC_PROTOCOL_VERSION) {
    throw new AmbientMusicProtocolError("unsupported_protocol", "The Ambient Music helper protocol does not match Aiden.");
  }
  if (parsed.type === "response") {
    if (!boundedString(parsed.requestId, 128) || typeof parsed.ok !== "boolean") {
      throw new AmbientMusicProtocolError("invalid_response", "The Ambient Music helper returned an invalid response envelope.");
    }
    if (parsed.ok) {
      if (!isObject(parsed.result)) {
        throw new AmbientMusicProtocolError("invalid_response", "The Ambient Music helper returned no result.");
      }
    } else if (
      !isObject(parsed.error) ||
      !boundedString(parsed.error.code, 128) ||
      !boundedString(parsed.error.message, 2_000)
    ) {
      throw new AmbientMusicProtocolError("invalid_response", "The Ambient Music helper returned an invalid error.");
    }
    return parsed as unknown as AmbientMusicHelperResponse;
  }
  const eventNames = new Set<AmbientMusicHelperEventName>([
    "ready",
    "remoteCommand",
    "promptEncoding",
    "audioState",
    "fatal",
  ]);
  if (
    parsed.type !== "event" ||
    typeof parsed.event !== "string" ||
    !eventNames.has(parsed.event as AmbientMusicHelperEventName) ||
    !Number.isSafeInteger(parsed.sequence) ||
    (parsed.sequence as number) < 1 ||
    !isObject(parsed.detail)
  ) {
    throw new AmbientMusicProtocolError("invalid_event", "The Ambient Music helper returned an invalid event.");
  }
  return parsed as unknown as AmbientMusicHelperEvent;
}

export function acceptAmbientMusicEventSequence(lastSequence: number, event: AmbientMusicHelperEvent): number {
  if (event.sequence <= lastSequence) {
    throw new AmbientMusicProtocolError("stale_event", "The Ambient Music helper returned a duplicate or stale event.");
  }
  return event.sequence;
}
