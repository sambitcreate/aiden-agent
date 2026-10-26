import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  WebFetchError,
  fetchPublicPage,
  isPublicAddress,
  normalizeWebFetchUrl,
} from "./web-fetch-transport.js";

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

async function withServer(handler: Handler, run: (origin: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const loopbackOnly = (address: string) => address === "127.0.0.1";

async function rejectsWith(promise: Promise<unknown>, kind: WebFetchError["kind"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebFetchError, String(error));
    assert.equal(error.kind, kind);
    return true;
  });
}

test("only public unicast addresses are reachable", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "fe80::1",
    "fd00::1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "ff02::1",
    "localhost",
    "",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("model-supplied URLs are http(s) without credentials; bare hosts get https", () => {
  assert.equal(normalizeWebFetchUrl(" example.com/pricing#plans ").href, "https://example.com/pricing");
  assert.equal(normalizeWebFetchUrl("http://example.com/a?b=1").href, "http://example.com/a?b=1");
  for (const bad of [42, "", "ftp://example.com", "file:///etc/passwd", "https://user:secret@example.com", "javascript:alert(1)", `https://example.com/${"a".repeat(2_100)}`]) {
    assert.throws(() => normalizeWebFetchUrl(bad), (error: unknown) => error instanceof WebFetchError && error.kind === "invalid-url", String(bad));
  }
});

test("a page on this computer is refused by default, by address and by name", async () => {
  await withServer((_request, response) => response.end("secret"), async (origin) => {
    await rejectsWith(fetchPublicPage(new URL(origin)), "blocked-address");
    const port = new URL(origin).port;
    // A public-looking name that resolves to loopback is refused when the socket connects.
    const lookup = ((_host: string, _options: unknown, callback: (error: null, addresses: { address: string; family: number }[]) => void) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof import("node:dns").lookup;
    await rejectsWith(fetchPublicPage(new URL(`http://pages.example:${port}/`), { lookup }), "blocked-address");
  });
});

test("a name with one private answer among public ones is refused", async () => {
  const lookup = ((_host: string, _options: unknown, callback: (error: null, addresses: { address: string; family: number }[]) => void) =>
    callback(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }])) as unknown as typeof import("node:dns").lookup;
  await rejectsWith(fetchPublicPage(new URL("http://mixed.example/"), { lookup }), "blocked-address");
});

test("every redirect is checked again", async () => {
  await withServer((request, response) => {
    if (request.url === "/to-private") {
      response.writeHead(302, { Location: "http://10.0.0.1/admin" });
      response.end();
    } else if (request.url === "/to-file") {
      response.writeHead(302, { Location: "file:///etc/passwd" });
      response.end();
    } else if (request.url?.startsWith("/loop")) {
      response.writeHead(302, { Location: `/loop${Number(request.url.slice(5) || 0) + 1}` });
      response.end();
    } else if (request.url === "/moved") {
      response.writeHead(301, { Location: "/final" });
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`at ${request.url}`);
    }
  }, async (origin) => {
    const options = { allowAddress: loopbackOnly };
    await rejectsWith(fetchPublicPage(new URL(`${origin}/to-private`), options), "blocked-address");
    await rejectsWith(fetchPublicPage(new URL(`${origin}/to-file`), options), "invalid-url");
    await rejectsWith(fetchPublicPage(new URL(`${origin}/loop`), options), "too-many-redirects");
    const page = await fetchPublicPage(new URL(`${origin}/moved`), options);
    assert.equal(page.url, `${origin}/final`);
    assert.equal(page.body, "at /final");
  });
});

test("pages are decoded and bounded; non-text content and errors are refused", async () => {
  await withServer((request, response) => {
    switch (request.url) {
      case "/gzip":
        response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
        response.end(gzipSync("<p>compressed</p>"));
        break;
      case "/latin1":
        response.writeHead(200, { "Content-Type": "text/plain; charset=iso-8859-1" });
        response.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
        break;
      case "/large":
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("x".repeat(5_000));
        break;
      case "/pdf":
        response.writeHead(200, { "Content-Type": "application/pdf" });
        response.end("%PDF");
        break;
      case "/missing":
        response.writeHead(404, { "Content-Type": "text/html" });
        response.end("not here");
        break;
      default:
        // Never answers, so the request times out.
        break;
    }
  }, async (origin) => {
    const options = { allowAddress: loopbackOnly };
    assert.equal((await fetchPublicPage(new URL(`${origin}/gzip`), options)).body, "<p>compressed</p>");
    assert.equal((await fetchPublicPage(new URL(`${origin}/latin1`), options)).body, "café");
    const large = await fetchPublicPage(new URL(`${origin}/large`), { ...options, maxBytes: 1_000 });
    assert.equal(large.body.length, 1_000);
    assert.equal(large.truncated, true);
    await rejectsWith(fetchPublicPage(new URL(`${origin}/pdf`), options), "unsupported-content");
    await assert.rejects(fetchPublicPage(new URL(`${origin}/missing`), options), (error: unknown) =>
      error instanceof WebFetchError && error.kind === "http-status" && error.status === 404 && /404/u.test(error.message));
    await rejectsWith(fetchPublicPage(new URL(`${origin}/hang`), { ...options, timeoutMs: 50 }), "timeout");
  });
});

test("stopping the turn rejects with the caller's reason, not a fetch error", async () => {
  await withServer(() => undefined, async (origin) => {
    const controller = new AbortController();
    const pending = fetchPublicPage(new URL(`${origin}/hang`), { allowAddress: loopbackOnly, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stopped")), 20);
    await assert.rejects(pending, /stopped/u);
  });
});

test("a compressed page that stalls or drops after its headers still settles", async () => {
  // Settles within a bound, so a read that never ends fails the test instead of hanging it.
  const settled = (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(
        () => assert.fail("the stalled page resolved"),
        (error: unknown) => error,
      ),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("still pending after 2s")), 2_000).unref()),
    ]);
  await withServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
    // Only the start of the gzip stream, then nothing more.
    response.write(gzipSync("<p>never finished</p>").subarray(0, 12));
    if (request.url === "/reset") setTimeout(() => request.socket.destroy(), 20);
  }, async (origin) => {
    const reset = await settled(fetchPublicPage(new URL(`${origin}/reset`), { allowAddress: loopbackOnly }));
    assert.ok(reset instanceof WebFetchError && reset.kind === "network", String(reset));

    const timedOut = await settled(fetchPublicPage(new URL(`${origin}/stall`), { allowAddress: loopbackOnly, timeoutMs: 50 }));
    assert.ok(timedOut instanceof WebFetchError && timedOut.kind === "timeout", String(timedOut));

    const controller = new AbortController();
    const pending = fetchPublicPage(new URL(`${origin}/stall`), { allowAddress: loopbackOnly, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stopped")), 50);
    const stopped = await settled(pending);
    assert.match(String(stopped), /stopped/u);
  });
});
