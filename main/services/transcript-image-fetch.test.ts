import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { lookup as dnsLookup } from "node:dns";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fetchTranscriptImage, transcriptImageUrl } from "./transcript-image-fetch.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==", "base64");
const loopbackOnly = (address: string) => address === "127.0.0.1";

async function fixture(run: (origin: string, requests: http.IncomingMessage[]) => Promise<void>) {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    if (request.url === "/private") { response.writeHead(302, { location: "http://10.0.0.1/secret" }).end(); return; }
    if (request.url === "/credentials") { response.writeHead(302, { location: "https://user:secret@example.test/image" }).end(); return; }
    if (request.url === "/moved") { response.writeHead(302, { location: "/image" }).end(); return; }
    if (request.url === "/loop") { response.writeHead(302, { location: "/loop" }).end(); return; }
    if (request.url === "/svg") { response.writeHead(200, { "content-type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg"><image href="http://10.0.0.1/private"/></svg>'); return; }
    if (request.url === "/spoof") { response.writeHead(200, { "content-type": "image/png" }).end("<html>Not an image</html>"); return; }
    if (request.url === "/bomb") {
      const huge = Buffer.from(PNG); huge.writeUInt32BE(100_000, 16);
      response.writeHead(200, { "content-type": "image/png" }).end(huge); return;
    }
    if (request.url === "/gzip") { response.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" }).end(gzipSync(PNG)); return; }
    response.writeHead(200, { "content-type": "image/png" }).end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("image transport returns exact verified bytes without credentials or referrer, including compressed and redirected images", async () => {
  await fixture(async (origin, requests) => {
    for (const path of ["/image", "/gzip", "/moved"]) {
      const image = await fetchTranscriptImage(origin + path, { allowAddress: loopbackOnly });
      assert.equal(image.data, PNG.toString("base64"));
      assert.deepEqual([image.width, image.height, image.mimeType], [1, 1, "image/png"]);
    }
    assert.equal(requests.length, 4);
    for (const { headers } of requests) {
      assert.equal(headers.cookie, undefined); assert.equal(headers.authorization, undefined);
      assert.equal(headers.referer, undefined); assert.equal(headers["x-api-key"], undefined);
    }
  });
});

test("production transport rejects private literals and private or mixed DNS before any request", async () => {
  await fixture(async (origin, requests) => {
    await assert.rejects(fetchTranscriptImage(origin), /private network/u);
    const port = new URL(origin).port;
    const lookup = ((_host: string, _options: unknown, callback: Function) => callback(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof dnsLookup;
    await assert.rejects(fetchTranscriptImage(`http://images.example:${port}/image`, { lookup }), /private network/u);
    const mixed = ((_host: string, _options: unknown, callback: Function) => callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }])) as unknown as typeof dnsLookup;
    await assert.rejects(fetchTranscriptImage(`http://images.example:${port}/image`, { lookup: mixed }), /private network/u);
    assert.equal(requests.length, 0);
  });
});

test("every image redirect is checked and only complete bounded raster responses can be decoded", async () => {
  await fixture(async (origin) => {
    const options = { allowAddress: loopbackOnly };
    await assert.rejects(fetchTranscriptImage(origin + "/private", options), /private network/u);
    await assert.rejects(fetchTranscriptImage(origin + "/credentials", options), /unsupported address/u);
    await assert.rejects(fetchTranscriptImage(origin + "/loop", options), /unsupported address/u);
    await assert.rejects(fetchTranscriptImage(origin + "/svg", options), /PNG, JPEG and WebP/u);
    await assert.rejects(fetchTranscriptImage(origin + "/spoof", options), /Only PNG/u);
    await assert.rejects(fetchTranscriptImage(origin + "/bomb", options), /too large/u);
    await assert.rejects(fetchTranscriptImage(origin + "/gzip", { ...options, maxBytes: 32 }), /larger/u);
  });
});

test("URL normalization never accepts local relative paths, credentials or non-HTTP schemes", () => {
  assert.equal(transcriptImageUrl("//example.com/chart.png").href, "https://example.com/chart.png");
  for (const url of ["/chart.png", "chart.png", "file:///secret", "data:image/png;base64,AA==", "https://user:password@example.com/a", "http:example.com/a"]) {
    assert.throws(() => transcriptImageUrl(url));
  }
});
