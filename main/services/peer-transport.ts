import https from "node:https";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { createHash, X509Certificate } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  AIDEN_REMOTE_ERROR_CODES,
  assertAidenRemoteEndpoint,
  parseAidenRemoteJson,
} from "./aiden-remote-protocol.js";

export interface PeerTrust {
  endpoint: string;
  serverSpkiSha256: string;
  caCertificateDerBase64?: string;
}

export interface PeerRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  credential?: string;
  body?: unknown;
  idempotencyKey?: string;
  revision?: string;
  signal?: AbortSignal;
  /** Overrides the 30 s JSON deadline, e.g. for a simulator boot. Capped at `MAX_PEER_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** SSE resume cursor sent as `Last-Event-ID`. */
  lastEventId?: string;
  /**
   * Streams only: called once the host accepted the stream, before any frame.
   * A resumed feed may legitimately send nothing until something changes.
   */
  onOpen?(): void;
}

/** How a stream ended without an error: the host closed it, or the 5-minute session cap fired. */
export interface PeerStreamEnd {
  reason: "eof" | "capped";
}

/** A bounded binary body, e.g. an attachment image. */
export interface PeerBinary {
  mimeType: string;
  data: Buffer;
}

const MAX_JSON_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 1_048_576;
const MAX_ERROR_BYTES = 16_384;
export const MAX_PEER_BINARY_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 30_000;
export const MAX_PEER_TIMEOUT_MS = 240_000;
/** A single SSE connection never outlives this; callers resume from their cursor. */
export const PEER_STREAM_SESSION_MS = 300_000;
const PEER_IDENTITY_ERROR = "ERR_AIDEN_PEER_IDENTITY";
/** TLS failures that mean the peer presented a different identity, not that it was unreachable. */
const IDENTITY_TLS_CODES = new Set([
  PEER_IDENTITY_ERROR,
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_SIGNATURE_FAILURE",
]);

function identityError(message: string): Error {
  return Object.assign(new Error(message), { code: PEER_IDENTITY_ERROR });
}

/** Pinned TLS for one paired installation: the CA when given, and always the SPKI fingerprint. */
export function peerTlsOptions(trust: PeerTrust): {
  rejectUnauthorized: true;
  ca?: string;
  checkServerIdentity(hostname: string, certificate: PeerCertificate): Error | undefined;
} {
  return {
    rejectUnauthorized: true,
    ...(trust.caCertificateDerBase64
      ? {
          ca: new X509Certificate(
            Buffer.from(trust.caCertificateDerBase64, "base64"),
          ).toString(),
        }
      : {}),
    checkServerIdentity: (hostname, certificate) => {
      const invalid = checkServerIdentity(hostname, certificate);
      if (invalid) return invalid;
      try {
        const key = new X509Certificate(certificate.raw).publicKey.export(
          { type: "spki", format: "der" },
        );
        const fingerprint = `sha256/${createHash("sha256").update(key).digest("base64")}`;
        if (fingerprint !== trust.serverSpkiSha256)
          return identityError("Server identity changed.");
      } catch {
        return identityError("Invalid server identity.");
      }
      return undefined;
    },
  };
}

/**
 * Linear byte scanner; each input byte is visited once, including one-byte trickles.
 *
 * The byte and frame budget is rolling: it bounds what arrives between two
 * frames that carry an SSE `id`, i.e. heartbeats and id-less partial snapshot
 * chunks a reader may have to hold. A committed frame releases it, so a
 * long-lived feed is limited by its session cap rather than its lifetime volume.
 */
export class PeerEventFrames {
  private buffer = Buffer.allocUnsafe(MAX_FRAME_BYTES + 4);
  private length = 0;
  private previousLf = false;
  private betweenCr = false;
  private total = 0;
  private frames = 0;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  push(
    chunk: Buffer,
    onFrame: (frame: string) => void,
    onBoundary: () => void,
  ): void {
    for (const byte of chunk) {
      if (++this.total > 16 * MAX_FRAME_BYTES)
        throw new Error("Stream byte budget exceeded.");
      if (this.length >= this.buffer.length)
        throw new Error("Frame too large.");
      this.buffer[this.length++] = byte;
      if (byte === 10 && this.previousLf) {
        if (++this.frames > 16_384)
          throw new Error("Stream frame budget exceeded.");
        const raw = this.buffer.subarray(0, this.length);
        const frame = this.decoder.decode(raw).replace(/\r?\n\r?\n$/u, "");
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
          throw new Error("Frame too large.");
        this.length = 0;
        this.previousLf = false;
        this.betweenCr = false;
        onBoundary();
        const lines = frame.split(/\r?\n/u);
        if (frame && !lines.every((line) => line.startsWith(":"))) {
          onFrame(frame);
          if (lines.some((line) => line.startsWith("id:"))) {
            this.total = 0;
            this.frames = 0;
          }
        }
      } else if (byte === 10) {
        this.previousLf = true;
        this.betweenCr = false;
      } else if (byte === 13 && this.previousLf && !this.betweenCr) {
        this.betweenCr = true;
      } else {
        this.previousLf = false;
        this.betweenCr = false;
      }
    }
  }
  end(): void {
    if (this.length) throw new Error("Incomplete SSE frame.");
  }
}

/** Sanitized fields of a host error envelope that callers may branch on. */
export interface PeerRemoteError {
  code: string;
  retryable: boolean;
  details?: {
    decision?: "allow" | "deny";
    outcome?: "answered" | "expired";
    resolvedAt?: string;
    currentRevision?: string;
  };
}

export type PeerTransportErrorCode =
  | "unavailable"
  | "invalid_response"
  | "authentication_required"
  | "request_failed"
  | "identity_changed"
  | "unsupported_protocol";

export class PeerTransportError extends Error {
  constructor(
    readonly code: PeerTransportErrorCode,
    readonly status?: number,
    readonly remote?: PeerRemoteError,
  ) {
    super(
      code === "authentication_required"
        ? "Pair this device again to reconnect."
        : code === "identity_changed"
          ? "The other device's identity changed. Pair it again."
          : code === "unsupported_protocol"
            ? "The other device runs an incompatible Aiden version."
          : "The other device could not complete this request.",
    );
  }
}

/** Parse a bounded `{error:{code,...}}` envelope; anything else yields no remote detail. */
export function parsePeerErrorEnvelope(text: string): PeerRemoteError | undefined {
  try {
    const value = parseAidenRemoteJson(text, "peer error") as {
      error?: Record<string, unknown>;
    };
    const error = value?.error;
    if (!error || typeof error !== "object") return undefined;
    const code = error.code;
    if (
      typeof code !== "string" ||
      !(AIDEN_REMOTE_ERROR_CODES as readonly string[]).includes(code)
    )
      return undefined;
    const raw =
      error.details && typeof error.details === "object"
        ? (error.details as Record<string, unknown>)
        : {};
    const details: NonNullable<PeerRemoteError["details"]> = {};
    if (raw.decision === "allow" || raw.decision === "deny")
      details.decision = raw.decision;
    if (raw.outcome === "answered" || raw.outcome === "expired")
      details.outcome = raw.outcome;
    for (const key of ["resolvedAt", "currentRevision"] as const) {
      const field = raw[key];
      if (typeof field === "string" && /^[\x21-\x7e]{1,128}$/u.test(field))
        details[key] = field;
    }
    return {
      code,
      retryable: error.retryable === true,
      ...(Object.keys(details).length ? { details } : {}),
    };
  } catch {
    return undefined;
  }
}

function statusError(status: number, remote: PeerRemoteError | undefined): PeerTransportError {
  // A 403 for a single capability is an answer, not a lost credential.
  const authFailure =
    status === 401 ||
    (status === 403 &&
      remote?.code !== "capability_denied" &&
      remote?.code !== "git_capability_denied");
  return new PeerTransportError(
    authFailure ? "authentication_required" : "request_failed",
    status,
    remote,
  );
}

/** A pinned keep-alive agent for one paired installation. */
export function createPeerAgent(trust: PeerTrust): https.Agent {
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 32,
    maxFreeSockets: 4,
    scheduling: "lifo",
    ...peerTlsOptions(trust),
  });
}

export function validatePeerTrust(trust: PeerTrust): PeerTrust {
  assertAidenRemoteEndpoint(trust.endpoint);
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/u.test(trust.serverSpkiSha256)) {
    throw new Error("Invalid server identity.");
  }
  if (trust.caCertificateDerBase64 !== undefined) {
    if (
      trust.caCertificateDerBase64.length > 8192 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(trust.caCertificateDerBase64)
    ) {
      throw new Error("Invalid server trust certificate.");
    }
    const cert = new X509Certificate(
      Buffer.from(trust.caCertificateDerBase64, "base64"),
    );
    if (!cert.ca) throw new Error("Server trust certificate must be a CA.");
  }
  return { ...trust };
}

/** Route fragments must not escape the fixed API prefix or introduce another authority. */
export function peerRequestUrl(endpoint: string, route: string): URL {
  assertAidenRemoteEndpoint(endpoint);
  if (
    route.length > 4096 ||
    !route.startsWith("/") ||
    route.startsWith("//") ||
    /[\\#\r\n]/u.test(route)
  ) {
    throw new Error("Invalid peer operation path.");
  }
  const result = new URL(`${endpoint}${route}`);
  const base = new URL(endpoint);
  if (
    result.origin !== base.origin ||
    !result.pathname.startsWith(`${base.pathname}/`)
  ) {
    throw new Error("Peer operation escaped its API endpoint.");
  }
  return result;
}

type ReadMode = "json" | "events" | "binary";

function headers(input: PeerRequest, mode: ReadMode): Record<string, string> {
  const result: Record<string, string> = {
    "Aiden-Protocol-Version": "1",
    Accept:
      mode === "events"
        ? "text/event-stream"
        : mode === "binary"
          ? "image/png, image/jpeg"
          : "application/json",
    "Accept-Encoding": "identity",
  };
  if (input.credential !== undefined) {
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(input.credential))
      throw new Error("Invalid peer credential.");
    result.Authorization = `Bearer ${input.credential}`;
  }
  for (const [name, value] of [
    ["Idempotency-Key", input.idempotencyKey],
    ["If-Match", input.revision],
    ["Last-Event-ID", input.lastEventId],
  ] as const) {
    if (value !== undefined) {
      if (!/^[\x21-\x7e]{1,128}$/u.test(value))
        throw new Error("Invalid peer operation metadata.");
      result[name] = value;
    }
  }
  return result;
}

/** Main-process transport. Redirects are rejected; neither cookies nor default browser sessions are used. */
export class PeerTransport {
  readonly trust: PeerTrust;
  private readonly agent: https.Agent | undefined;
  constructor(trust: PeerTrust, options: { agent?: https.Agent } = {}) {
    this.trust = validatePeerTrust(trust);
    this.agent = options.agent;
  }

  private async read(
    input: PeerRequest,
    mode: ReadMode,
    onFrame?: (frame: string) => void,
  ): Promise<unknown> {
    const streaming = mode === "events";
    const target = peerRequestUrl(this.trust.endpoint, input.path);
    const requestHeaders = headers(input, mode);
    const body =
      input.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(input.body));
    if (body && body.length > MAX_JSON_BYTES)
      throw new Error("Peer request is too large.");
    if (body) {
      requestHeaders["Content-Type"] = "application/json";
      requestHeaders["Content-Length"] = String(body.length);
    }
    if (input.signal?.aborted) throw new PeerTransportError("unavailable");
    const deadlineMs =
      !streaming && input.timeoutMs !== undefined
        ? Math.min(Math.max(1, Math.floor(input.timeoutMs)), MAX_PEER_TIMEOUT_MS)
        : DEADLINE_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let sessionDeadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(sessionDeadline);
        input.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const request = https.request(
        target,
        {
          method: input.method ?? "GET",
          headers: requestHeaders,
          ...(this.agent ? { agent: this.agent } : { agent: false }),
          ...peerTlsOptions(this.trust),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const fail = (error: Error) => {
            finish(error);
            response.destroy();
            request.destroy();
          };
          const mime = response.headers["content-type"]?.split(";")[0]?.trim();
          if (
            response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity"
          ) {
            fail(new PeerTransportError("invalid_response", status));
            return;
          }
          if (status < 200 || status >= 300) {
            // Read a bounded JSON error envelope so callers can tell answered refusals apart.
            if (mime !== "application/json") {
              fail(statusError(status, undefined));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > MAX_ERROR_BYTES) fail(statusError(status, undefined));
              else chunks.push(chunk);
            });
            response.on("end", () =>
              finish(
                statusError(
                  status,
                  parsePeerErrorEnvelope(Buffer.concat(chunks).toString("utf8")),
                ),
              ),
            );
            response.on("error", () => finish(statusError(status, undefined)));
            response.on("aborted", () => finish(statusError(status, undefined)));
            return;
          }
          const binaryMime = mime === "image/png" || mime === "image/jpeg";
          if (
            status !== 204 &&
            (mode === "binary"
              ? !binaryMime
              : mime !== (streaming ? "text/event-stream" : "application/json"))
          ) {
            fail(new PeerTransportError("invalid_response", status));
            return;
          }
          const frames = streaming ? new PeerEventFrames() : undefined;
          if (streaming) {
            try {
              input.onOpen?.();
            } catch {
              // An observer must not break the stream.
            }
          }
          const frameBoundary = () => {
            clearTimeout(deadline);
            deadline = setTimeout(abort, DEADLINE_MS);
          };
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const binary: Buffer[] = [];
          let text = "";
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            try {
              bytes += chunk.length;
              if (mode === "json" && bytes > MAX_JSON_BYTES)
                throw new Error("Response too large.");
              if (mode === "binary") {
                if (bytes > MAX_PEER_BINARY_BYTES)
                  throw new Error("Response too large.");
                binary.push(chunk);
              } else if (frames && onFrame) {
                frames.push(chunk, onFrame, frameBoundary);
              } else text += decoder.decode(chunk, { stream: true });
            } catch {
              fail(new PeerTransportError("invalid_response", status));
            }
          });
          response.on("end", () => {
            try {
              if (mode === "binary") {
                if (status === 204 || !mime) throw new Error("Empty binary body.");
                finish(undefined, {
                  mimeType: mime,
                  data: Buffer.concat(binary),
                } satisfies PeerBinary);
                return;
              }
              text += decoder.decode();
              frames?.end();
              finish(
                undefined,
                streaming
                  ? ({ reason: "eof" } satisfies PeerStreamEnd)
                  : status === 204
                    ? undefined
                    : parseAidenRemoteJson(text, "peer response"),
              );
            } catch {
              fail(new PeerTransportError("invalid_response", status));
            }
          });
          response.on("error", () =>
            finish(new PeerTransportError("unavailable")),
          );
          response.on("aborted", () =>
            finish(new PeerTransportError("unavailable")),
          );
        },
      );
      const abort = () => {
        finish(new PeerTransportError("unavailable"));
        request.destroy();
      };
      const capped = () => {
        // The cap is a scheduled end, not a failure: the caller resumes from its cursor.
        finish(undefined, { reason: "capped" } satisfies PeerStreamEnd);
        request.destroy();
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      request.on("error", (error: Error & { code?: unknown }) =>
        finish(
          new PeerTransportError(
            typeof error.code === "string" && IDENTITY_TLS_CODES.has(error.code)
              ? "identity_changed"
              : "unavailable",
          ),
        ),
      );
      request.setTimeout(streaming ? 60_000 : deadlineMs, abort);
      deadline = setTimeout(abort, deadlineMs);
      if (streaming) sessionDeadline = setTimeout(capped, PEER_STREAM_SESSION_MS);
      request.end(body);
    });
  }

  json(input: PeerRequest): Promise<unknown> {
    return this.read(input, "json");
  }
  binary(input: PeerRequest): Promise<PeerBinary> {
    return this.read(input, "binary") as Promise<PeerBinary>;
  }
  events(
    input: PeerRequest,
    onFrame: (frame: string) => void,
  ): Promise<PeerStreamEnd> {
    return this.read(input, "events", onFrame) as Promise<PeerStreamEnd>;
  }
}
