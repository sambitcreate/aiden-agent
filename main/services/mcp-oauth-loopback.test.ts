import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import test from "node:test";
import { mcpOAuthLoopbackHolder, startMcpOAuthLoopback, type McpOAuthLoopbackOptions } from "./mcp-oauth-loopback.js";
import { McpOAuthCallbackError } from "./mcp-oauth-session.js";

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
    authorization: {
      callback: (url) => {
        if (url.searchParams.get("state") !== "expected") throw new Error("bad state");
        const error = url.searchParams.get("error");
        if (error) return { error: new McpOAuthCallbackError(error, url.searchParams.get("error_description") ?? undefined) };
        return { code: url.searchParams.get("code") ?? "" };
      },
    },
    ...patch,
  };
}

function page(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

async function get(port: number, path: string): Promise<number> {
  return (await page(port, path)).status;
}

test("the browser callback delivers the code, waits for the outcome, and closing frees the port", async () => {
  const port = await freePort();
  const loopback = await startMcpOAuthLoopback(options(port));
  assert.equal(await get(port, "/callback?state=forged&code=x"), 400);
  let answered = false;
  const browser = page(port, "/callback?state=expected&code=abc").finally(() => { answered = true; });
  assert.equal(await loopback.waitForCode(), "abc");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(answered, false, "the tab is not told anything before the code exchange");
  loopback.finish({ ok: true });
  const shown = await browser;
  assert.equal(shown.status, 200);
  assert.match(shown.body, /Connected/u);
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

test("a failed exchange answers the waiting tab with a failure page, escaped", async () => {
  const port = await freePort();
  const loopback = await startMcpOAuthLoopback(options(port));
  const browser = page(port, "/callback?state=expected&code=abc");
  await loopback.waitForCode();
  loopback.finish({ ok: false, message: "Client <b>secret</b> required." });
  loopback.finish({ ok: true });
  const shown = await browser;
  assert.match(shown.body, /Sign-in failed/u);
  assert.doesNotMatch(shown.body, /Connected|<b>/u);
  assert.match(shown.body, /Client &#60;b&#62;secret&#60;\/b&#62; required\./u);
  loopback.close();
});

test("a callback carrying an OAuth error is answered with the provider's reason at once", async () => {
  const port = await freePort();
  const loopback = await startMcpOAuthLoopback(options(port));
  const code = loopback.waitForCode();
  code.catch(() => undefined);
  const shown = await page(port, `/callback?state=expected&error=access_denied&error_description=${encodeURIComponent("Admin approval required")}`);
  assert.match(shown.body, /Sign-in failed/u);
  assert.match(shown.body, /denied in the browser: Admin approval required/u);
  await assert.rejects(code, /Admin approval required/u);
  loopback.close();
});

test("closing before an outcome answers a waiting tab with a failure page", async () => {
  const port = await freePort();
  const loopback = await startMcpOAuthLoopback(options(port));
  const browser = page(port, "/callback?state=expected&code=abc");
  await loopback.waitForCode();
  loopback.close();
  const shown = await browser;
  assert.match(shown.body, /Sign-in failed/u);
  assert.equal(mcpOAuthLoopbackHolder(port), undefined);
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
