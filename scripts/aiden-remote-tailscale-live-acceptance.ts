import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import {
  AidenRemoteTailscaleController,
  createSystemTailscaleCommandRunner,
} from "../main/services/aiden-remote-tailscale.js";

const BASE_PATH = "/api/aiden/v1";
const MAX_RESPONSE_BYTES = 1_024;
const REQUEST_TIMEOUT_MS = 5_000;
const EXTERNAL_PROBE_WINDOW_MS = 60_000;

if (process.platform !== "linux") {
  throw new Error("This live acceptance check must run on the Linux Tailscale node.");
}

const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== `${BASE_PATH}/health`) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
});

const address = server.address();
assert(address && typeof address === "object");
const target = `http://127.0.0.1:${address.port}${BASE_PATH}`;
const runner = await createSystemTailscaleCommandRunner();
const controller = new AidenRemoteTailscaleController(runner);
let ownership: Awaited<ReturnType<typeof controller.connect>> | undefined;

async function readHealth(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, {
      headers: { accept: "application/json", connection: "close" },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Aiden health response exceeded its size limit."));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", reject);
      response.on("end", () => {
        try {
          assert.equal(response.statusCode, 200);
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("Aiden health request timed out.")));
    request.once("error", reject);
  });
}

async function waitForExternalProbe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("External Tailscale probe window expired.")),
      EXTERNAL_PROBE_WINDOW_MS,
    );
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

try {
  const status = await controller.status();
  assert.equal(status.installed, true);
  assert.equal(status.errorCode, undefined);
  assert.equal(status.httpsAvailable, true);
  assert(status.dnsName);

  ownership = await controller.connect(target);
  assert.deepEqual(ownership, { path: BASE_PATH, target });
  assert.deepEqual(await readHealth(`${target}/health`), {
    ok: true,
    protocolVersion: 1,
  });

  if (process.env.AIDEN_TAILSCALE_EXTERNAL_PROBE === "1") {
    process.stdout.write(`${JSON.stringify({ readyForExternalProbe: true })}\n`);
    await waitForExternalProbe();
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      linuxBinary: true,
      tailscaleOnline: true,
      aidenRouteConfigured: true,
      loopbackHealthVerified: true,
    })}\n`);
  }
} finally {
  if (ownership) await controller.disconnect(target, ownership);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
