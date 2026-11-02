import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalyticsState } from "./analytics-consent.js";
import { createAnalyticsService } from "./analytics-service.js";
import { gunzipSync } from "node:zlib";

import { ANALYTICS_HOST, createPostHogTransport } from "./analytics-client.js";

const INSTALL_ID = "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b";
const SUPER = { app_version: "1.40.0", platform: "darwin", arch: "arm64", os_major: 26, surface: "desktop", channel: "release" } as const;

interface Recorded {
  readonly url: string;
  readonly events: { event: string; distinct_id: string; uuid?: string; properties: Record<string, unknown> }[];
}

async function decodeBody(init: { body?: unknown; headers?: unknown } | undefined): Promise<unknown> {
  const body = init?.body;
  if (typeof body === "string") return JSON.parse(body);
  const bytes = body instanceof Blob
    ? Buffer.from(await body.arrayBuffer())
    : Buffer.from(body as Uint8Array);
  try {
    return JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch {
    return JSON.parse(bytes.toString("utf8"));
  }
}

function fakeFetch(status: number) {
  const requests: Recorded[] = [];
  const fetch = async (url: string, init?: { body?: unknown; headers?: unknown }) => {
    const payload = await decodeBody(init) as { batch?: Recorded["events"] } & Recorded["events"][number];
    requests.push({ url, events: payload.batch ?? [payload] });
    return { status, text: async () => "", json: async () => ({}) };
  };
  return { fetch, requests };
}

test("batched events reach the US host with person and undeclared data stripped", async () => {
  const { fetch, requests } = fakeFetch(200);
  const transport = createPostHogTransport({ apiKey: "phc_test", fetch: fetch as never });

  transport.capture({
    distinctId: INSTALL_ID,
    event: "web_search_used",
    properties: { search_provider: "brave", query: "my secret search", $set: { email: "jane@example.com" }, ...SUPER },
  });
  transport.capture({ distinctId: INSTALL_ID, event: "rogue_event", properties: { ...SUPER } });
  await transport.flush();

  const events = requests.flatMap((request) => request.events);
  assert.ok(requests.every((request) => request.url.startsWith(`${ANALYTICS_HOST}/`)));
  assert.deepEqual(events.map((event) => event.event), ["web_search_used"]);
  const [event] = events;
  assert.equal(event!.distinct_id, INSTALL_ID);
  assert.equal(event!.properties.search_provider, "brave");
  assert.equal(event!.properties.$process_person_profile, false);
  assert.equal("query" in event!.properties, false);
  assert.equal("$set" in event!.properties, false);
  assert.match(event!.uuid ?? "", /^[0-9a-f-]{36}$/u);

  await transport.shutdown();
});

test("undeclared dollar-prefixed properties never reach the request", async () => {
  const { fetch, requests } = fakeFetch(200);
  const transport = createPostHogTransport({ apiKey: "phc_test", fetch: fetch as never });

  transport.capture({
    distinctId: INSTALL_ID,
    event: "terminal_opened",
    properties: { ...SUPER, $email: "jane.doe@example.com", $ip: "192.0.2.1", $secret: "private content" },
  });
  await transport.flush();

  const body = JSON.stringify(requests);
  assert.equal(requests.flatMap((request) => request.events).length, 1);
  for (const leaked of ["jane.doe@example.com", "192.0.2.1", "private content", "$email", "$secret"]) {
    assert.equal(body.includes(leaked), false, `leaked ${leaked}`);
  }
  await transport.shutdown();
});

test("a batch the server rejects is dropped, not retried or thrown", async () => {
  const { fetch, requests } = fakeFetch(400);
  const errors: unknown[] = [];
  const transport = createPostHogTransport({ apiKey: "phc_test", fetch: fetch as never, onError: (error) => errors.push(error) });

  transport.capture({ distinctId: INSTALL_ID, event: "terminal_opened", properties: { ...SUPER } });
  await transport.flush();
  await transport.flush();

  assert.equal(requests.length, 1);
  assert.equal(errors.length, 1);
  await transport.shutdown();
});

test("discarding drops queued events without sending them", async () => {
  const { fetch, requests } = fakeFetch(200);
  const transport = createPostHogTransport({ apiKey: "phc_test", fetch: fetch as never });

  transport.capture({ distinctId: INSTALL_ID, event: "terminal_opened", properties: { ...SUPER } });
  await transport.discard();
  transport.capture({ distinctId: INSTALL_ID, event: "terminal_opened", properties: { ...SUPER } });
  await transport.flush();

  assert.deepEqual(requests, []);
});

test("discarding during a flush stops its retries from reaching the network", async () => {
  let dispatched = 0;
  let releaseFirst!: (response: unknown) => void;
  const fetch = (_url: string, init?: { signal?: AbortSignal }) => {
    dispatched += 1;
    if (dispatched > 1) return Promise.resolve({ status: 200, text: async () => "", json: async () => ({}) });
    return new Promise((resolve, reject) => {
      releaseFirst = resolve;
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  };
  const transport = createPostHogTransport({ apiKey: "phc_test", fetch: fetch as never, retryDelayMs: 1 });

  transport.capture({ distinctId: INSTALL_ID, event: "terminal_opened", properties: { ...SUPER } });
  const flushing = transport.flush();
  while (dispatched === 0) await new Promise((resolve) => setImmediate(resolve));
  await transport.discard();
  releaseFirst({ status: 500, text: async () => "", json: async () => ({}) });
  await flushing;
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(dispatched, 1);
});

test("an immediate send goes out on its own", async () => {
  const { fetch, requests } = fakeFetch(200);
  const transport = createPostHogTransport({ apiKey: "phc_test", fetch: fetch as never });

  await transport.captureOptOut({ distinctId: INSTALL_ID, event: "analytics_disabled", properties: { ...SUPER } });

  assert.deepEqual(requests.flatMap((request) => request.events).map((event) => event.event), ["analytics_disabled"]);
  await transport.discard();
});

test("quitting while the opt-out response is pending never sends the old lifecycle batch", { timeout: 5000 }, async (t) => {
  const runDirectory = mkdtempSync(join(tmpdir(), "analytics-quit-"));
  t.after(() => rmSync(runDirectory, { recursive: true, force: true }));
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  const responseGate = new EventEmitter();
  let optOutResponses = 0;
  const { fetch: record, requests } = fakeFetch(200);
  const transport = createPostHogTransport({
    apiKey: "phc_test",
    fetch: async (url, init) => {
      const response = await record(url, init);
      if (requests[requests.length - 1]?.events.some(({ event }) => event === "analytics_disabled")) {
        received();
        assert.ok(init.signal);
        await once(responseGate, "release", { signal: init.signal });
        optOutResponses++;
      }
      return response;
    },
  });
  let state: AnalyticsState = { enabled: true, noticeShownAt: new Date().toISOString() };
  const service = createAnalyticsService({
    runDirectory, env: {}, appRoots: [], isBuiltinProvider: () => false,
    superProperties: SUPER,
    store: { read: async () => state, update: async (mutate) => (state = mutate(state)) },
    createTransport: async () => transport,
  });
  await service.start();
  const previousId = state.installId;
  assert.ok(previousId);
  const off = service.setEnabled(false);
  await Promise.race([started, off.then(() => assert.fail("Opt-out ended before the request reached fetch."))]);
  const quit = service.shutdown();
  const consentWhilePending = { enabled: state.enabled, installId: state.installId };
  try {
    await transport.flush(); // Exercise the SDK queue while the final request is held.
  } finally {
    responseGate.emit("release");
    await Promise.all([off, quit]);
  }
  assert.deepEqual(requests.flatMap(r => r.events.map(e => [e.event, e.distinct_id])),
    [["analytics_disabled", previousId]]);
  assert.equal(optOutResponses, 1, "Opt-out was aborted before its response could complete.");
  assert.deepEqual(consentWhilePending, { enabled: false, installId: undefined });
});
