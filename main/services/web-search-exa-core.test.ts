import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EXA_MCP_ENDPOINT,
  EXA_MCP_ORIGIN,
  MAX_EXA_MCP_RESPONSE_BYTES,
  buildExaMcpRequest,
  exaMcpHttpError,
  exaMcpTransportError,
  parseExaMcpResponse,
  type ExaMcpErrorCategory,
} from "./web-search-exa-core.js";

const PRIVATE_KEY = "exa-private-key-7dbfe9";
const PRIVATE_BODY = "PRIVATE_UPSTREAM_BODY_7dbfe9";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/exa-mcp/${name}`, import.meta.url), "utf8");
}

test("anonymous and keyed MCP requests are fixed-origin, bounded, and never redirect", () => {
  const anonymous = buildExaMcpRequest("  current Exa docs  ", 3, {
    mode: "anonymous",
  });
  assert.equal(anonymous.url, EXA_MCP_ENDPOINT);
  assert.equal(new URL(anonymous.url).origin, EXA_MCP_ORIGIN);
  assert.equal(anonymous.init.method, "POST");
  assert.equal(anonymous.init.redirect, "error");
  assert.deepEqual(anonymous.init.headers, {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(anonymous.init.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: { query: "current Exa docs", numResults: 3 },
    },
  });

  const keyed = buildExaMcpRequest("current Exa docs", 3, {
    mode: "api-key",
    apiKey: `  ${PRIVATE_KEY}  `,
  });
  assert.equal(keyed.init.headers["x-api-key"], PRIVATE_KEY);
  assert.equal(keyed.url.includes(PRIVATE_KEY), false);
  assert.equal(keyed.init.body.includes(PRIVATE_KEY), false);
  assert.equal(
    Object.keys(keyed.init.headers).some((name) => /author|cookie|client|install/iu.test(name)),
    false,
  );
});

test("request validation closes query, count, and credential bounds without echoing input", () => {
  assert.doesNotThrow(() => buildExaMcpRequest("😀".repeat(2_000), 10, { mode: "anonymous" }));
  for (const operation of [
    () => buildExaMcpRequest("", 5, { mode: "anonymous" }),
    () => buildExaMcpRequest("x\nprivate", 5, { mode: "anonymous" }),
    () => buildExaMcpRequest("x\u0085private", 5, { mode: "anonymous" }),
    () => buildExaMcpRequest("😀".repeat(2_001), 5, { mode: "anonymous" }),
    () => buildExaMcpRequest("query", 0, { mode: "anonymous" }),
    () => buildExaMcpRequest("query", 11, { mode: "anonymous" }),
    () => buildExaMcpRequest("query", 1.5, { mode: "anonymous" }),
    () => buildExaMcpRequest("query", 5, { mode: "api-key", apiKey: `${PRIVATE_KEY}\n` }),
  ]) {
    assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(PRIVATE_KEY), false);
      assert.equal(error.message.includes("private"), false);
      return true;
    });
  }
});

test("the deterministic JSON fixture normalizes capped untrusted evidence", async () => {
  const outcome = parseExaMcpResponse({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: await fixture("json-success.json"),
  });
  assert.deepEqual(outcome, {
    ok: true,
    value: {
      providerId: "exa",
      trust: "untrusted-web-evidence",
      results: [
        {
          title: "Exa documentation",
          url: "https://exa.ai/docs/reference/exa-mcp",
          text: "Hosted MCP search evidence.",
        },
        {
          title: "Source 3",
          url: "https://example.test/second",
          text: "Second result",
        },
      ],
    },
  });
});

test("the deterministic SSE fixture skips non-RPC events and parses formatted results", async () => {
  const outcome = parseExaMcpResponse(
    {
      status: 200,
      contentType: "text/event-stream",
      body: await fixture("sse-success.sse"),
    },
    1,
  );
  assert.deepEqual(outcome, {
    ok: true,
    value: {
      providerId: "exa",
      trust: "untrusted-web-evidence",
      results: [
        {
          title: "First result",
          url: "https://example.test/first",
          text: "First line. Second line.",
        },
      ],
    },
  });
});

test("malformed, oversized, unsupported, and RPC-error responses close without leakage", async () => {
  const cases = [
    parseExaMcpResponse({
      status: 200,
      contentType: "text/event-stream",
      body: await fixture("malformed.sse"),
    }),
    parseExaMcpResponse({
      status: 200,
      contentType: "application/json",
      body: "😀".repeat(Math.ceil(MAX_EXA_MCP_RESPONSE_BYTES / 4) + 1),
    }),
    parseExaMcpResponse({
      status: 200,
      contentType: "text/html",
      body: PRIVATE_BODY,
    }),
    parseExaMcpResponse({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_000, message: PRIVATE_BODY, data: PRIVATE_KEY },
      }),
    }),
    parseExaMcpResponse({
      status: 200,
      contentType: "application/json",
      body: new Uint8Array([0xc3, 0x28]),
    }),
  ];
  for (const outcome of cases) {
    assert.equal(outcome.ok, false);
    assert.equal(JSON.stringify(outcome).includes(PRIVATE_BODY), false);
    assert.equal(JSON.stringify(outcome).includes(PRIVATE_KEY), false);
    if (!outcome.ok) assert.equal(outcome.error.category, "invalid_response");
  }
});

test("HTTP error fixtures map redirects, auth, quota, and upstream failures to closed categories", async () => {
  const cases = JSON.parse(await fixture("http-errors.json")) as Array<{
    status: number;
    category: ExaMcpErrorCategory;
    fallbackEligible: boolean;
  }>;
  for (const expected of cases) {
    const direct = exaMcpHttpError(expected.status);
    assert.equal(direct.category, expected.category);
    assert.equal(direct.fallbackEligible, expected.fallbackEligible);
    const parsed = parseExaMcpResponse({
      status: expected.status,
      contentType: "text/plain",
      body: `${PRIVATE_BODY}:${PRIVATE_KEY}`,
    });
    assert.equal(parsed.ok, false);
    assert.equal(JSON.stringify(parsed).includes(PRIVATE_BODY), false);
    assert.equal(JSON.stringify(parsed).includes(PRIVATE_KEY), false);
    if (!parsed.ok) assert.deepEqual(parsed.error, direct);
  }
});

test("transport errors expose only stable route-policy categories", () => {
  assert.deepEqual(
    ["network", "timeout", "cancelled", "redirect"].map((kind) =>
      exaMcpTransportError(kind as "network" | "timeout" | "cancelled" | "redirect"),
    ),
    [
      {
        providerId: "exa",
        category: "network",
        fallbackEligible: true,
        message: "Exa search could not reach the provider.",
      },
      {
        providerId: "exa",
        category: "timeout",
        fallbackEligible: true,
        message: "Exa search timed out.",
      },
      {
        providerId: "exa",
        category: "cancelled",
        fallbackEligible: false,
        message: "Exa search was cancelled.",
      },
      {
        providerId: "exa",
        category: "policy",
        fallbackEligible: false,
        message: "Exa search was blocked by the network policy.",
      },
    ],
  );
});

test("malformed contract values fail closed without exposing input", () => {
  const privateBody = "PRIVATE_MALFORMED_BODY_7dbfe9";
  const malformedResponses = [
    null,
    undefined,
    { status: "200", body: privateBody },
    { status: 200, body: privateBody, contentType: 42 },
    { status: 200, body: { privateBody } },
  ];
  for (const response of malformedResponses) {
    const outcome = parseExaMcpResponse(response as never);
    assert.equal(outcome.ok, false);
    assert.equal(JSON.stringify(outcome).includes(privateBody), false);
    if (!outcome.ok) assert.equal(outcome.error.category, "invalid_response");
  }

  for (const credential of [
    null,
    { mode: "unknown", apiKey: privateBody },
    { mode: "api-key", apiKey: undefined },
  ]) {
    assert.throws(
      () => buildExaMcpRequest("query", 5, credential as never),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(privateBody), false);
        return true;
      },
    );
  }
});
