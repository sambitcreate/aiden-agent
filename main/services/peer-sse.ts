import { parseAidenRemoteJson } from "./aiden-remote-protocol.js";
import { PeerTransportError } from "./peer-transport.js";
import type { PeerRunEvent } from "../../renderer/shared/peer-host.js";

/** One parsed SSE frame (`id:`, `event:`, `data:` lines; comments already dropped). */
export interface PeerSseFrame {
  id?: string;
  event?: string;
  data: string;
}

const ENVELOPE_KEYS = new Set([
  "protocolVersion",
  "streamId",
  "sequence",
  "timestamp",
  "type",
  "terminal",
  "payload",
]);
const FEED_CURSOR = /^([A-Za-z0-9_-]{1,64}):(0|[1-9]\d{0,14})$/u;
const RUN_CURSOR = /^(0|[1-9]\d{0,14})$/u;

function malformed(): never {
  throw new PeerTransportError("invalid_response");
}

export function parsePeerSseFrame(frame: string): PeerSseFrame {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) malformed();
  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    data: data.join("\n"),
  };
}

/**
 * Validate a stream envelope. A different protocol version is a typed
 * `unsupported_protocol`, so the supervisor blocks instead of retrying.
 */
export function parsePeerStreamEnvelope(
  frame: PeerSseFrame,
  label: string,
): PeerRunEvent {
  let value: unknown;
  try {
    value = parseAidenRemoteJson(frame.data, label);
  } catch {
    malformed();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const record = value as Record<string, unknown>;
  if (
    "protocolVersion" in record &&
    record.protocolVersion !== 1 &&
    typeof record.protocolVersion === "number"
  )
    throw new PeerTransportError("unsupported_protocol");
  if (Object.keys(record).some((key) => !ENVELOPE_KEYS.has(key))) malformed();
  const { protocolVersion, streamId, sequence, timestamp, type, terminal, payload } =
    record;
  if (
    protocolVersion !== 1 ||
    typeof streamId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(streamId) ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0 ||
    typeof timestamp !== "string" ||
    timestamp.length > 64 ||
    typeof type !== "string" ||
    !/^[a-z_.]{1,64}$/u.test(type) ||
    (frame.event !== undefined && frame.event !== type) ||
    typeof terminal !== "boolean" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    malformed();
  return {
    protocolVersion: 1,
    streamId,
    sequence: sequence as number,
    timestamp,
    type,
    terminal,
    payload: payload as Record<string, unknown>,
  };
}

/** `epoch:sequence` host-feed cursor. */
export function parsePeerFeedCursor(
  id: string,
): { epoch: string; sequence: number } {
  const match = FEED_CURSOR.exec(id);
  if (!match) malformed();
  return { epoch: match[1]!, sequence: Number(match[2]) };
}

/** Decimal run-stream cursor. */
export function parsePeerRunCursor(id: string): number {
  if (!RUN_CURSOR.test(id)) malformed();
  return Number(id);
}
