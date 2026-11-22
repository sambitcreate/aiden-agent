// The fetch a watch Aiden proposed checks with: it connects only to public
// addresses. The name is resolved once per request; if any address it has is
// this computer, a private or link-local network, or otherwise not public,
// the request is refused before connecting. The socket connects to the
// address that was checked, so a name can't switch to a private address
// between the check and the connection (DNS rebinding).

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateIpAddress } from "../../renderer/shared/scheduled-task-trigger.js";
import { WatchAddressRefused } from "./bot-routine-events/watch-sources.js";

type Resolve = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemResolve: Resolve = (hostname, callback) => dnsLookup(hostname, { all: true, verbatim: true }, callback);

const refused = (host: string) =>
  new WatchAddressRefused(`${host} points at this computer or a private network, which a watch Aiden proposed can't check. Set it up yourself in the task editor to watch it.`);

export function createPublicOnlyFetch(options: { resolve?: Resolve; isPrivate?: (address: string) => boolean } = {}) {
  const resolve = options.resolve ?? systemResolve;
  const isPrivate = options.isPrivate ?? isPrivateIpAddress;

  /** `lookup` for the request: only the checked public addresses are handed to the socket. */
  const lookup = (hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some((entry) => isPrivate(entry.address))) return callback(refused(hostname));
      if (lookupOptions.all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  return (url: string, init: RequestInit): Promise<Response> => {
    const target = new URL(url);
    const literal = target.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(literal) && isPrivate(literal)) return Promise.reject(refused(target.host));
    const client = target.protocol === "https:" ? https : http;
    return new Promise((resolveResponse, reject) => {
      const request = client.request(target, {
        method: "GET",
        headers: { accept: "*/*" },
        agent: false,
        lookup: lookup as never,
        ...(init.signal ? { signal: init.signal } : {}),
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status > 599) {
          response.resume();
          reject(new Error(`Unexpected status ${status}.`));
          return;
        }
        const headers = new Headers();
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
          headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        }
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) response.resume();
        resolveResponse(new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, headers }));
      });
      request.on("error", reject);
      request.end();
    });
  };
}

/** The production fetch for watches Aiden proposed (system DNS). */
export const publicOnlyFetch = createPublicOnlyFetch();
