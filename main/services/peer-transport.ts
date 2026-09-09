import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { createHash, X509Certificate } from "node:crypto";
import { TextDecoder } from "node:util";
import {
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
}

const MAX_JSON_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 1_048_576;
const DEADLINE_MS = 30_000;

export class PeerTransportError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "invalid_response"
      | "authentication_required"
      | "request_failed",
    readonly status?: number,
  ) {
    super(
      code === "authentication_required"
        ? "Pair this device again to reconnect."
        : "The other device could not complete this request.",
    );
  }
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

function headers(
  input: PeerRequest,
  streaming: boolean,
): Record<string, string> {
  const result: Record<string, string> = {
    "Aiden-Protocol-Version": "1",
    Accept: streaming ? "text/event-stream" : "application/json",
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
  constructor(trust: PeerTrust) {
    this.trust = validatePeerTrust(trust);
  }

  private async read(
    input: PeerRequest,
    onFrame?: (frame: string) => void,
  ): Promise<unknown> {
    const target = peerRequestUrl(this.trust.endpoint, input.path);
    const requestHeaders = headers(input, !!onFrame);
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
          headers: requestHeaders,
          agent: false,
          rejectUnauthorized: true,
          ...(this.trust.caCertificateDerBase64
            ? {
                ca: new X509Certificate(
                  Buffer.from(this.trust.caCertificateDerBase64, "base64"),
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
              if (fingerprint !== this.trust.serverSpkiSha256)
                return new Error("Server identity changed.");
            } catch {
              return new Error("Invalid server identity.");
            }
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
          if (status < 200 || status >= 300) {
            fail(
              new PeerTransportError(
                status === 401 || status === 403
                  ? "authentication_required"
                  : "request_failed",
                status,
              ),
            );
            return;
          }
          const mime = response.headers["content-type"]?.split(";")[0]?.trim();
          if (
            status !== 204 &&
            mime !== (onFrame ? "text/event-stream" : "application/json")
          ) {
            fail(new PeerTransportError("invalid_response"));
            return;
          }
          if (
            response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity"
          ) {
            fail(new PeerTransportError("invalid_response"));
            return;
          }
          if (onFrame) clearTimeout(deadline);
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let text = "";
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            try {
              bytes += chunk.length;
              if (!onFrame && bytes > MAX_JSON_BYTES)
                throw new Error("Response too large.");
              text += decoder.decode(chunk, { stream: true });
              if (onFrame) {
                let separator: RegExpExecArray | null;
                while ((separator = /\r?\n\r?\n/u.exec(text))) {
                  const frame = text.slice(0, separator.index);
                  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
                    throw new Error("Frame too large.");
                  text = text.slice(separator.index + separator[0].length);
                  if (
                    frame &&
                    !frame.split(/\r?\n/u).every((line) => line.startsWith(":"))
                  )
                    onFrame(frame);
                }
                if (Buffer.byteLength(text) > MAX_FRAME_BYTES)
                  throw new Error("Frame too large.");
              }
            } catch {
              fail(new PeerTransportError("invalid_response"));
            }
          });
          response.on("end", () => {
            try {
              text += decoder.decode();
              if (onFrame && text.trim())
                throw new Error("Incomplete SSE frame.");
              finish(
                undefined,
                onFrame || status === 204
                  ? undefined
                  : parseAidenRemoteJson(text, "peer response"),
              );
            } catch {
              fail(new PeerTransportError("invalid_response"));
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
      request.on("error", () => finish(new PeerTransportError("unavailable")));
      request.setTimeout(onFrame ? 60_000 : DEADLINE_MS, abort);
      deadline = setTimeout(abort, DEADLINE_MS);
      request.end(body);
    });
  }

  json(input: PeerRequest): Promise<unknown> {
    return this.read(input);
  }
  async events(
    input: PeerRequest,
    onFrame: (frame: string) => void,
  ): Promise<void> {
    await this.read(input, onFrame);
  }
}
