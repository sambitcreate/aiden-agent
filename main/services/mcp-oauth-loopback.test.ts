import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import test from "node:test";
import { mcpOAuthLoopbackHolder, startMcpOAuthLoopback, type McpOAuthLoopbackOptions } from "./mcp-oauth-loopback.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function options(port: number, patch: Partial<McpOAuthLoopbackOptions> = {}): McpOAuthLoopbackOptions {
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    label: "Linear",
    timeoutMs: 5_000,
    callbackHtml: "<p>done</p>",
    authorization: {
      callback: (url) => {
        if (url.searchParams.get("state") !== "expected") throw new Error("bad state");
        return { code: url.searchParams.get("code") ?? "" };
      },
    },
    ...patch,
  };
}

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    }).on("error", reject);
  });
}

test("the browser callback delivers the code and closing frees the port", async () => {
  const port = await freePort();
  const loopback = await startMcpOAuthLoopback(options(port));
  assert.equal(await get(port, "/callback?state=forged&code=x"), 400);
  assert.equal(await get(port, "/callback?state=expected&code=abc"), 200);
  assert.equal(await loopback.waitForCode(), "abc");
  loopback.close();
  assert.equal(mcpOAuthLoopbackHolder(port), undefined);
  const again = await startMcpOAuthLoopback(options(port));
  again.close();
});

test("a second sign-in while one waits names the waiting one instead of a port error", async () => {
  const port = await freePort();
  const first = await startMcpOAuthLoopback(options(port, { label: "Notion" }));
  await assert.rejects(
    startMcpOAuthLoopback(options(port, { label: "Linear" })),
    /Another sign-in \(“Notion”\) is waiting in your browser/u,
  );
  first.close();
  const second = await startMcpOAuthLoopback(options(port, { label: "Linear" }));
  second.close();
});

test("cancelling rejects the pending code and releases the port immediately", async () => {
  const port = await freePort();
  const controller = new AbortController();
  const loopback = await startMcpOAuthLoopback(options(port, { signal: controller.signal }));
  const code = loopback.waitForCode();
  controller.abort(new Error("Sign-in was cancelled."));
  await assert.rejects(code, /cancelled/u);
  assert.equal(mcpOAuthLoopbackHolder(port), undefined);
  const next = await startMcpOAuthLoopback(options(port));
  next.close();
});

test("a port held by another app is reported clearly and leaves no holder behind", async () => {
  const port = await freePort();
  const squatter = net.createServer();
  await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  try {
    await assert.rejects(startMcpOAuthLoopback(options(port)), new RegExp(`Port ${port} is in use by another app`, "u"));
    assert.equal(mcpOAuthLoopbackHolder(port), undefined);
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test("an already-cancelled sign-in never binds the port", async () => {
  const port = await freePort();
  const controller = new AbortController();
  controller.abort(new Error("Sign-in was cancelled."));
  await assert.rejects(startMcpOAuthLoopback(options(port, { signal: controller.signal })), /cancelled/u);
  assert.equal(mcpOAuthLoopbackHolder(port), undefined);
});
