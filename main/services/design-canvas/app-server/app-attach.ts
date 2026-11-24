/**
 * Design mode 2c: attaching to a dev server the person already runs (plan D6–D8).
 *
 * Every decision here comes from the process and socket tables. Nothing in
 * this file makes an HTTP request, opens a TCP connection or looks up a name:
 * a server's origin is the loopback address its own sockets hold, never the
 * text a config file or the renderer supplied.
 */
import type { SocketAddress } from "../../follow-through/listening-ports.js";

const ATTACH_URL_MAX = 256;
const ATTACH_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/u;

/**
 * An `apps[].url` from `.aiden/canvas.json` (D7): `http:`, a host of exactly
 * `localhost`, `127.0.0.1` or `[::1]`, an explicit port from 1024 to 65535,
 * no credentials, query or fragment, and a path that is empty or `/`. `url`
 * is the text without its trailing slash, for display only.
 */
export function parseAttachUrl(text: unknown): { ok: true; url: string; port: number } | { ok: false } {
  if (typeof text !== "string" || text.length > ATTACH_URL_MAX) return { ok: false };
  const match = ATTACH_URL.exec(text);
  if (!match) return { ok: false };
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return { ok: false };
  return { ok: true, url: `http://${match[1]}:${match[2]}`, port };
}

const IPV4_LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);

/** Every origin a server holding `sockets` can be loaded at on `port`: exactly 127.0.0.1 (or its mapped form) and ::1. */
export function attachOrigins(sockets: ReadonlyArray<SocketAddress>, port: number): string[] {
  const onPort = sockets.filter((socket) => socket.port === port);
  const origins: string[] = [];
  if (onPort.some((socket) => IPV4_LOOPBACK.has(socket.address))) origins.push(`http://127.0.0.1:${port}`);
  if (onPort.some((socket) => socket.address === "::1")) origins.push(`http://[::1]:${port}`);
  return origins;
}

/** The origin Aiden registers for an attached server (A-M2): 127.0.0.1 when held, else [::1], else none. */
export function attachOrigin(sockets: ReadonlyArray<SocketAddress>, port: number): string | undefined {
  return attachOrigins(sockets, port)[0];
}
