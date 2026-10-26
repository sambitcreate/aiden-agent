import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { WebFetchService, WEB_FETCH_MAX_TEXT_CHARS } from "./web-fetch.js";
import { WebFetchError, type WebFetchResult } from "./web-fetch-transport.js";
import { WebSearchKeyPoolTracker, type WebSearchKeyPool } from "./web-search-key-pool-core.js";
import { codemodeResultSchema } from "./pi-codemode.js";
import { isPiCodemodeCallable, piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import { defaultWebFetchSettings, type WebFetchSettingsV1 } from "../../renderer/shared/web-fetch-settings.js";
import { parseWebExtractRecap } from "../../renderer/shared/web-extract.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PAGE_HTML = `<html><head><title>Acme Pricing</title></head><body>
  <h1>Pricing</h1><p>Pro is $20 per month, billed monthly.</p><p>Team is $1,299 per year.</p>
</body></html>`;

function extractOn(overrides: Partial<WebFetchSettingsV1["extract"]> = {}): WebFetchSettingsV1 {
  const settings = defaultWebFetchSettings();
  return { ...settings, extract: { ...settings.extract, enabled: true, accountId: ACCOUNT_ID, ...overrides } };
}

interface Harness {
  readonly service: WebFetchService;
  readonly fetched: URL[];
  readonly extractRequests: { url: string; key: string; body: Record<string, unknown> }[];
  readonly tracker: WebSearchKeyPoolTracker;
}

function harness(options: {
  settings?: WebFetchSettingsV1;
  webSearchEnabled?: boolean;
  keys?: readonly string[];
  page?: Partial<WebFetchResult> | Error;
  /** Status and JSON per key, answered in order of the request. */
  clairic?: (key: string) => { status: number; body?: unknown };
}): Harness {
  const fetched: URL[] = [];
  const extractRequests: Harness["extractRequests"] = [];
  const tracker = new WebSearchKeyPoolTracker();
  const pool: WebSearchKeyPool = {
    strategy: "ordered",
    keys: (options.keys ?? ["key-a"]).map((key, index) => ({ id: `k${index}`, key })),
  };
  const service = new WebFetchService({
    getSettings: async () => options.settings ?? defaultWebFetchSettings(),
    webSearchEnabled: async () => options.webSearchEnabled ?? true,
    getExtractKeyPool: async () => pool,
    keyPoolTracker: tracker,
    now: () => new Date(2026, 9, 26),
    fetchPage: async (url) => {
      fetched.push(url);
      if (options.page instanceof Error) throw options.page;
      return { url: url.href, status: 200, mediaType: "text/html", body: PAGE_HTML, truncated: false, ...options.page };
    },
    extractFetch: async (input, init) => {
      const key = String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /u, "");
      extractRequests.push({ url: String(input), key, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const answer = (options.clairic ?? (() => ({ status: 200, body: { success: true, result: { answers: {} } } })))(key);
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
    },
  });
  return { service, fetched, extractRequests, tracker };
}

async function toolOf(h: Harness): Promise<AgentTool> {
  const tool = await h.service.toolForGeneration();
  assert.ok(tool, "web_fetch is offered");
  return tool;
}

function properties(tool: AgentTool): string[] {
  return Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
}

test("web_fetch is offered only while Web Search and page reading are both on", async () => {
  assert.equal(await harness({ webSearchEnabled: false }).service.toolForGeneration(), undefined);
  assert.equal(await harness({ settings: { ...defaultWebFetchSettings(), enabled: false } }).service.toolForGeneration(), undefined);
  const tool = await toolOf(harness({}));
  assert.equal(tool.name, "web_fetch");
  // Scripts may call it; it is never replayed after a crash.
  assert.equal(isPiCodemodeCallable(tool), true);
  assert.equal(piRuntimeReplayPolicy(tool), "never");
});

test("extract options appear only while extract mode is on and set up", async () => {
  // Off by default, and on without a model is still off.
  for (const h of [
    harness({}),
    harness({ settings: extractOn({ accountId: undefined }) }),
    harness({ settings: extractOn(), keys: [] }),
    harness({ settings: { ...extractOn(), extract: { ...extractOn().extract, enabled: false } } }),
  ]) {
    const tool = await toolOf(h);
    assert.deepEqual(properties(tool), ["url"]);
    assert.doesNotMatch(tool.description, /extract/u);
  }
  const tool = await toolOf(harness({ settings: extractOn() }));
  assert.deepEqual(properties(tool), ["url", "mode", "fields"]);
  assert.match(tool.description, /only specific facts/u);
});

test("read mode returns the page as text, with typed structured content for scripts", async () => {
  const h = harness({});
  const result = await (await toolOf(h)).execute("call-1", { url: "acme.example/pricing" });
  assert.equal(h.fetched[0]!.href, "https://acme.example/pricing");
  const text = (result.content[0] as { text: string }).text;
  assert.equal(text, "Acme Pricing\nhttps://acme.example/pricing\n\n# Pricing\nPro is $20 per month, billed monthly.\nTeam is $1,299 per year.");
  assert.deepEqual(result.structuredContent, {
    url: "https://acme.example/pricing",
    title: "Acme Pricing",
    mode: "read",
    text: "# Pricing\nPro is $20 per month, billed monthly.\nTeam is $1,299 per year.",
    truncated: false,
  });
  assert.equal(result.details, null);

  const long = harness({ page: { mediaType: "text/plain", body: "y".repeat(WEB_FETCH_MAX_TEXT_CHARS + 10) } });
  const cut = await (await toolOf(long)).execute("call-2", { url: "https://acme.example/big.txt" });
  assert.equal((cut.structuredContent as { text: string }).text.length, WEB_FETCH_MAX_TEXT_CHARS);
  assert.equal((cut.structuredContent as { truncated: boolean }).truncated, true);
  assert.match((cut.content[0] as { text: string }).text, /\[Page cut at 40,000 characters\.\]$/u);
});

test("extract mode returns typed values with source lines, and the transcript recap", async () => {
  const h = harness({
    settings: extractOn(),
    clairic: () => ({
      status: 200,
      body: {
        success: true,
        result: {
          answers: {
            pro_monthly: { value: 20, confidence: 0.97 },
            team_yearly: { value: 1399, confidence: 0.92 },
            enterprise: { value: null, confidence: 0.88 },
          },
        },
      },
    }),
  });
  const result = await (await toolOf(h)).execute("call-1", {
    url: "https://acme.example/pricing",
    mode: "extract",
    fields: { pro_monthly: "number: Pro plan monthly price", team_yearly: "number", enterprise: "number" },
  });
  const [request] = h.extractRequests;
  assert.equal(request!.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/cloudflare/clairic`);
  assert.equal(request!.key, "key-a");
  assert.equal(request!.body.reference_date, "2026-10-26");
  assert.equal(request!.body.state, "# Pricing\nPro is $20 per month, billed monthly.\nTeam is $1,299 per year.");
  assert.deepEqual(request!.body.fields, {
    pro_monthly: { type: "number", instructions: "Pro plan monthly price" },
    team_yearly: { type: "number" },
    enterprise: { type: "number" },
  });
  assert.deepEqual(result.structuredContent, {
    url: "https://acme.example/pricing",
    title: "Acme Pricing",
    mode: "extract",
    cut: false,
    fields: {
      pro_monthly: { status: "extracted", value: 20, confidence: 0.97, sourceLine: "Pro is $20 per month, billed monthly." },
      // Confident, but 1,399 is not on the page.
      team_yearly: { status: "uncertain", guess: 1399, confidence: 0.92, notFound: true },
      enterprise: { status: "null", value: null },
    },
  });
  assert.deepEqual(parseWebExtractRecap(result.details), result.details);
  assert.deepEqual(result.details, {
    version: 1,
    host: "acme.example",
    cut: false,
    fields: [
      { name: "pro_monthly", status: "extracted", value: "20", confidence: 0.97, sourceLine: "Pro is $20 per month, billed monthly." },
      { name: "team_yearly", status: "uncertain", value: "1399", confidence: 0.92, notFound: true },
      { name: "enterprise", status: "null" },
    ],
  });
  // The model reads three short lines instead of the page.
  const text = (result.content[0] as { text: string }).text;
  assert.doesNotMatch(text, /Team is \$1,299 per year/u);
  assert.match(text, /^pro_monthly: 20 \(0\.97\) from "Pro is \$20 per month, billed monthly\."$/mu);
});

test("a rejected or rate-limited key cools down and the next key is tried", async () => {
  const h = harness({
    settings: extractOn(),
    keys: ["bad", "limited", "good"],
    clairic: (key) =>
      key === "bad"
        ? { status: 401 }
        : key === "limited"
          ? { status: 429 }
          : { status: 200, body: { success: true, result: { answers: { price: { value: 20, confidence: 0.9 } } } } },
  });
  const result = await (await toolOf(h)).execute("call-1", { url: "https://acme.example", fields: { price: "number" } });
  assert.deepEqual(h.extractRequests.map(({ key }) => key), ["bad", "limited", "good"]);
  assert.equal((result.structuredContent as { fields: Record<string, { status: string }> }).fields.price!.status, "extracted");
  // The next call skips the cooled-down keys.
  await (await toolOf(h)).execute("call-2", { url: "https://acme.example", fields: { price: "number" } });
  assert.deepEqual(h.extractRequests.slice(3).map(({ key }) => key), ["good"]);
});

test("when extraction fails the page text still comes back, with the reason", async () => {
  const h = harness({ settings: extractOn(), keys: ["bad"], clairic: () => ({ status: 403 }) });
  const result = await (await toolOf(h)).execute("call-1", { url: "https://acme.example", fields: { price: "number" } });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.mode, "extract");
  assert.match(String(structured.error), /rejected every saved key/u);
  assert.match(String(structured.text), /Pro is \$20 per month/u);
  assert.deepEqual(result.details, { version: 1, host: "acme.example", cut: false, error: "auth", fields: [] });
});

test("bad requests fail before anything is fetched", async () => {
  const off = harness({});
  await assert.rejects((await toolOf(off)).execute("call-1", { url: "https://acme.example", mode: "extract", fields: { a: "text" } }), /Extract mode is off/u);
  const on = harness({ settings: extractOn() });
  const tool = await toolOf(on);
  await assert.rejects(tool.execute("call-1", { url: "https://acme.example", fields: { a: "money" } }), /unknown type/u);
  await assert.rejects(tool.execute("call-2", { url: "https://acme.example", mode: "read", fields: { a: "text" } }), /only with mode "extract"/u);
  await assert.rejects(tool.execute("call-3", { url: "ftp://acme.example", mode: "read" }), WebFetchError);
  assert.equal(on.fetched.length + off.fetched.length, 0);
});

test("scripts see the declared result type, not unknown", async () => {
  const tool = await toolOf(harness({ settings: extractOn() }));
  const schema = codemodeResultSchema(tool.outputSchema) as { properties: { structuredContent: Record<string, unknown> } };
  const declared = (schema.properties.structuredContent as { properties?: Record<string, unknown> }).properties;
  assert.ok(declared?.fields && declared.mode && declared.text, "the typed shape survives the codemode size budget");
});
