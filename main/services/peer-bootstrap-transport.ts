import https from "node:https";
import { isIP, type Socket } from "node:net";
import tls from "node:tls";
import { TextDecoder } from "node:util";
import { parseAidenRemoteJson } from "./aiden-remote-protocol.js";
import {
  identityError,
  isPeerIdentityTlsError,
  parsePeerErrorEnvelope,
  peerRequestUrl,
  peerSpkiFingerprint,
  peerStatusError,
  PeerTransportError,
} from "./peer-transport.js";

/**
 * How a bootstrap session checks the certificate on its first connection.
 *
 * - `webpki`: system roots and the exact hostname, as for a Tailscale
 *   MagicDNS name.
 * - `unverified`: any certificate, for LAN requests and setup codes. A LAN
 *   pairing request is protected by the match code, which covers the SPKI
 *   observed here. A setup code authenticates its whole payload with AES-GCM.
 *
 * In both modes the first leaf SPKI is pinned for the rest of the session.
 */
export type PeerBootstrapMode = "webpki" | "unverified";

export interface PeerBootstrapOptions {
  endpoint: string;
  mode: PeerBootstrapMode;
  /** Replaces the system roots in `webpki` mode. Tests use it for a private CA. */
  ca?: string;
}

export interface PeerBootstrapRequest {
  method?: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  credential?: string;
  /** Sent as `Aiden-Pairing-Secret`. */
  pairingSecret?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The surface pairing and discovery use; tests may substitute it. */
export interface PeerBootstrapClient {
  json(input: PeerBootstrapRequest): Promise<unknown>;
  /** The leaf SPKI pinned by the first connection, once one completed. */
  readonly observedSpki: string | undefined;
}

export type PeerBootstrapFactory = (
  options: PeerBootstrapOptions,
) => PeerBootstrapClient;

const MAX_BODY_BYTES = 262_144;
const MAX_ERROR_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

function bootstrapHeaders(
  input: PeerBootstrapRequest,
  body: Buffer | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    // Connection-request routes are versioned by their path and feature, and
    // take no protocol header.
    ...(/^\/pairing\/requests(?:\/|$)/u.test(input.path) ? {} : { "Aiden-Protocol-Version": "1" }),
    Accept: "application/json",
    "Accept-Encoding": "identity",
  };
  if (input.credential !== undefined) {
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(input.credential))
      throw new Error("Invalid peer credential.");
    headers.Authorization = `Bearer ${input.credential}`;
  }
  if (input.pairingSecret !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.pairingSecret))
      throw new Error("Invalid pairing secret.");
    headers["Aiden-Pairing-Secret"] = input.pairingSecret;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(body.length);
  }
  return headers;
}

/**
 * An unauthenticated JSON client for pairing and discovery routes. Each
 * request opens its own TLS connection. The connection is handed to the HTTP
 * layer only after its leaf SPKI matched the session's pin, so no request
 * byte reaches a host that changed keys mid-session.
 */
export class PeerBootstrapTransport implements PeerBootstrapClient {
  private spki: string | undefined;
  private readonly host: string;
  private readonly port: number;
  constructor(private readonly options: PeerBootstrapOptions) {
    const url = peerRequestUrl(options.endpoint, "/health");
    this.host = url.hostname.replace(/^\[|\]$/gu, "");
    this.port = Number(url.port || 443);
  }

  get observedSpki(): string | undefined {
    return this.spki;
  }

  private connect(callback: (error: Error | null, socket?: Socket) => void): void {
    let called = false;
    const done = (error: Error | null, socket?: Socket) => {
      if (called) return;
      called = true;
      callback(error, socket);
    };
    const socket = tls.connect({
      host: this.host,
      port: this.port,
      ...(isIP(this.host) ? {} : { servername: this.host }),
      rejectUnauthorized: this.options.mode === "webpki",
      ...(this.options.mode === "webpki" && this.options.ca
        ? { ca: this.options.ca }
        : {}),
      ALPNProtocols: ["http/1.1"],
    });
    socket.on("error", (error) => done(error));
    socket.once("secureConnect", () => {
      let fingerprint: string;
      try {
        const certificate = socket.getPeerCertificate(false);
        if (!certificate?.raw) throw new Error("No certificate.");
        fingerprint = peerSpkiFingerprint(certificate.raw);
      } catch {
        const error = identityError("Invalid server identity.");
        socket.destroy(error);
        done(error);
        return;
      }
      if (this.spki !== undefined && this.spki !== fingerprint) {
        const error = identityError("Server identity changed.");
        socket.destroy(error);
        done(error);
        return;
      }
      this.spki = fingerprint;
      done(null, socket);
    });
  }

  json(input: PeerBootstrapRequest): Promise<unknown> {
    const target = peerRequestUrl(this.options.endpoint, input.path);
    const body =
      input.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(input.body));
    if (body && body.length > MAX_BODY_BYTES)
      throw new Error("Peer request is too large.");
    const headers = bootstrapHeaders(input, body);
    if (input.signal?.aborted)
      return Promise.reject(new PeerTransportError("unavailable"));
    const timeoutMs = Math.min(
      Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      MAX_TIMEOUT_MS,
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        input.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const request = https.request(
        target,
        {
          method: input.method ?? "GET",
          headers,
          createConnection: (_options, oncreate) => {
            this.connect((error, socket) =>
              oncreate(error, socket as unknown as Socket),
            );
            return undefined;
          },
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
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity") ||
            mime !== "application/json"
          ) {
            fail(
              status >= 200 && status < 300
                ? new PeerTransportError("invalid_response", status)
                : peerStatusError(status, undefined),
            );
            return;
          }
          const success = status >= 200 && status < 300;
          const limit = success ? MAX_BODY_BYTES : MAX_ERROR_BYTES;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > limit)
              fail(
                success
                  ? new PeerTransportError("invalid_response", status)
                  : peerStatusError(status, undefined),
              );
            else chunks.push(chunk);
          });
          response.on("end", () => {
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              );
            } catch {
              fail(new PeerTransportError("invalid_response", status));
              return;
            }
            if (!success) {
              finish(peerStatusError(status, parsePeerErrorEnvelope(text)));
              return;
            }
            try {
              finish(undefined, parseAidenRemoteJson(text, "peer response"));
            } catch {
              finish(new PeerTransportError("invalid_response", status));
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
      input.signal?.addEventListener("abort", abort, { once: true });
      request.on("error", (error) =>
        finish(
          new PeerTransportError(
            isPeerIdentityTlsError(error) ? "identity_changed" : "unavailable",
          ),
        ),
      );
      deadline = setTimeout(abort, timeoutMs);
      request.end(body);
    });
  }
}

export const createPeerBootstrapTransport: PeerBootstrapFactory = (options) =>
  new PeerBootstrapTransport(options);
