// A paired host may run a newer Aiden than this Mac. Its Bot session can carry
// a state, entry type or event this client has never seen; the strict protocol
// parsers would reject the whole session, and the Bot's chat would never open.
// Like the phones, this client keeps what it understands: an unknown state
// reads as unavailable, an entry it cannot read is left out, and an event it
// cannot read asks for a fresh read of the session instead of failing.

import {
  AIDEN_REMOTE_BOT_SESSION_BLOCKED_REASONS,
  AIDEN_REMOTE_BOT_SESSION_STATES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  parseAidenRemoteBotApproval,
  parseAidenRemoteBotQuestion,
  parseAidenRemoteBotSession,
  parseAidenRemoteBotSessionActivity,
  parseAidenRemoteBotSessionEntry,
  parseAidenRemoteBotSessionEvent,
  parseAidenRemoteBotQueuedList,
  type AidenRemoteBotSession,
  type AidenRemoteBotSessionEvent,
} from "./aiden-remote-protocol.js";

const SESSION_KEYS = [
  "botId",
  "epoch",
  "seq",
  "state",
  "interrupted",
  "blocked",
  "partial",
  "entries",
  "hasOlder",
  "question",
  "approval",
  "activity",
  "queued",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parses(parse: (value: unknown) => unknown, value: unknown): boolean {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
}

/** The host's session as this client can read it. Anything not a session object is returned as is, to fail validation. */
export function peerBotSessionCompat(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const session: Record<string, unknown> = {};
  for (const key of SESSION_KEYS) if (has(value, key)) session[key] = value[key];
  if (!(AIDEN_REMOTE_BOT_SESSION_STATES as readonly unknown[]).includes(session.state)) {
    session.state = "unavailable";
    session.interrupted = false;
    delete session.blocked;
  } else if (
    has(session, "blocked") &&
    !(AIDEN_REMOTE_BOT_SESSION_BLOCKED_REASONS as readonly unknown[]).includes(session.blocked)
  ) {
    delete session.blocked;
  }
  if (Array.isArray(session.entries))
    session.entries = session.entries.filter((entry) => parses(parseAidenRemoteBotSessionEntry, entry));
  for (const [key, parse] of [
    ["question", parseAidenRemoteBotQuestion],
    ["approval", parseAidenRemoteBotApproval],
  ] as const) {
    if (session[key] !== null && !parses(parse, session[key])) session[key] = null;
  }
  if (
    has(session, "activity") &&
    session.activity !== null &&
    !parses(parseAidenRemoteBotSessionActivity, session.activity)
  )
    delete session.activity;
  if (has(session, "queued") && !parses(parseAidenRemoteBotQueuedList, session.queued)) delete session.queued;
  return session;
}

export function parsePeerBotSession(value: unknown): AidenRemoteBotSession {
  return parseAidenRemoteBotSession(peerBotSessionCompat(value));
}

/** An event this client cannot apply: the session must be read again. */
export interface PeerBotSessionResync {
  type: "resync";
  botId: string;
  epoch: string;
  seq: number;
}

/**
 * Parses one stream frame. A frame whose envelope is sound but whose content
 * is newer than this client becomes a resync; a malformed envelope still throws.
 */
export function parsePeerBotSessionEvent(value: unknown): AidenRemoteBotSessionEvent | PeerBotSessionResync {
  try {
    return parseAidenRemoteBotSessionEvent(value);
  } catch (error) {
    if (
      !isRecord(value) ||
      value.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION ||
      typeof value.botId !== "string" ||
      typeof value.epoch !== "string" ||
      typeof value.seq !== "number" ||
      !Number.isSafeInteger(value.seq) ||
      value.seq < 0
    )
      throw error;
    if (value.type === "snapshot" && isRecord(value.payload)) {
      return parseAidenRemoteBotSessionEvent({
        ...value,
        payload: { session: peerBotSessionCompat(value.payload.session) },
      });
    }
    // Validate the envelope's own fields with a known event shape.
    parseAidenRemoteBotSessionEvent({ ...value, type: "closed", payload: {} });
    return { type: "resync", botId: value.botId, epoch: value.epoch, seq: value.seq };
  }
}
