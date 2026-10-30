import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { ANALYTICS_HOST, createPostHogTransport } from "./analytics-client.js";

const INSTALL_ID = "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b";
const SUPER = { app_version: "1.40.0", platform: "darwin", arch: "arm64", os_major: 26, surface: "desktop", channel: "release" };

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

test("an immediate send goes out on its own", async () => {
  const { fetch, requests } = fakeFetch(200);
  const transport = createPostHogTransport({ apiKey: "phc_test", fetch: fetch as never });

  await transport.captureNow({ distinctId: INSTALL_ID, event: "analytics_disabled", properties: { ...SUPER } });

  assert.deepEqual(requests.flatMap((request) => request.events).map((event) => event.event), ["analytics_disabled"]);
  await transport.discard();
});
