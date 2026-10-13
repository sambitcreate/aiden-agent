import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent, ImagesContext } from "@earendil-works/pi-ai";
import type { ImageModelAdapter } from "../../../renderer/shared/image-generation/types.js";
import { FAL_INLINE_REFERENCE_BYTES, falImagesApi } from "./fal-images.js";
import {
  bytes,
  fakeFetch,
  imageModel,
  json,
  png,
  pngBase64,
  secretFragmentIn,
  straddlingPads,
  type RecordedRequest,
} from "./test-support.js";

const KEY = "fal-key-1234:secret";
type Meta = Extract<ImageModelAdapter, { kind: "fal" }>;
const META: Record<string, Meta> = {
  "google/nano-banana-2.1": {
    kind: "fal",
    textEndpoint: "google/nano-banana-2.1",
    editEndpoint: "google/nano-banana-2.1/edit",
    referenceField: "image_urls",
    maxReferences: 4,
  },
  "fal-ai/flux-pro/kontext/max/text-to-image": {
    kind: "fal",
    textEndpoint: "fal-ai/flux-pro/kontext/max/text-to-image",
    editEndpoint: "fal-ai/flux-pro/kontext/max",
    referenceField: "image_url",
  },
  "fal-ai/flux/schnell": { kind: "fal", textEndpoint: "fal-ai/flux/schnell" },
};

const api = (fetchImpl: typeof fetch) => falImagesApi({ fetch: fetchImpl, pollIntervalMs: 1, metadata: (id) => META[id] });
const model = (id: string) => imageModel("fal", id, "fal-images", ["text", "image"]);
const context = (prompt: string, references: ImageContent[] = []): ImagesContext => ({
  input: [{ type: "text", text: prompt }, ...references],
});
const ref: ImageContent = { type: "image", mimeType: "image/png", data: pngBase64(5) };

function queue(endpoint: string, overrides: Record<string, string> = {}) {
  const base = `https://queue.fal.run/${endpoint.split("/").slice(0, 2).join("/")}/requests/r1`;
  return {
    request_id: "r1",
    status_url: `${base}/status`,
    response_url: base,
    cancel_url: `${base}/cancel`,
    ...overrides,
  };
}

function scripted(
  endpoint: string,
  options: { statuses?: string[]; result?: unknown; queueOverrides?: Record<string, string>; cdn?: Uint8Array } = {},
) {
  const statuses = [...(options.statuses ?? ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"])];
  const info = queue(endpoint, options.queueOverrides);
  return fakeFetch((request: RecordedRequest) => {
    if (request.method === "POST") return json(info);
    if (request.url === info.status_url) return json({ status: statuses.shift() ?? "COMPLETED" });
    if (request.url === info.response_url) return json(options.result);
    if (request.url.startsWith("https://v3.fal.media/")) return bytes(options.cdn ?? png(2));
    return json({}, 500);
  });
}

test("a queued text request is submitted, polled and read back", async () => {
  const dataUri = `data:image/png;base64,${pngBase64(1)}`;
  const { fetch, requests } = scripted("fal-ai/flux/schnell", { result: { images: [{ url: dataUri }] } });

  const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("a lighthouse"), {
    apiKey: KEY,
  });

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: pngBase64(1) }]);
  const submit = requests[0]!;
  assert.equal(submit.url, "https://queue.fal.run/fal-ai/flux/schnell");
  assert.equal(submit.headers.authorization, `Key ${KEY}`);
  assert.equal(submit.headers["x-fal-store-io"], "0");
  assert.deepEqual(submit.body, { prompt: "a lighthouse", num_images: 1, sync_mode: true });
  assert.equal(requests.filter((request) => request.url.endsWith("/status")).length, 3);
});

test("reference images switch to the edit endpoint and its field", async () => {
  const many = scripted("google/nano-banana-2.1", { result: { images: [{ url: "https://v3.fal.media/files/out.png" }] } });
  const result = await api(many.fetch).generateImages(model("google/nano-banana-2.1"), context("restyle", [ref, ref]), {
    apiKey: KEY,
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(many.requests[0]!.url, "https://queue.fal.run/google/nano-banana-2.1/edit");
  assert.deepEqual((many.requests[0]!.body as { image_urls: string[] }).image_urls, [
    `data:image/png;base64,${ref.data}`,
    `data:image/png;base64,${ref.data}`,
  ]);
  const download = many.requests.find((request) => request.url.startsWith("https://v3.fal.media/"));
  assert.equal(download?.headers.authorization, undefined);

  const single = scripted("fal-ai/flux-pro/kontext/max", {
    result: { images: [{ url: `data:image/png;base64,${pngBase64(3)}` }] },
  });
  const edited = await api(single.fetch).generateImages(
    model("fal-ai/flux-pro/kontext/max/text-to-image"),
    context("edit", [ref]),
    { apiKey: KEY },
  );
  assert.equal(edited.stopReason, "stop", edited.errorMessage);
  assert.equal(single.requests[0]!.url, "https://queue.fal.run/fal-ai/flux-pro/kontext/max");
  assert.equal((single.requests[0]!.body as { image_url: string }).image_url, `data:image/png;base64,${ref.data}`);
});

test("a text-only model refuses reference images before any request", async () => {
  const { fetch, requests } = fakeFetch(() => json({}, 500));
  const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x", [ref]), { apiKey: KEY });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "This model doesn't accept reference images.");
  assert.equal(requests.length, 0);
});

test("queue addresses outside https://queue.fal.run are never followed", async () => {
  const validCancel = "https://queue.fal.run/fal-ai/flux/requests/r1/cancel";
  const cases: { overrides: Record<string, string>; followUps: string[] }[] = [
    { overrides: { status_url: "https://evil.example/requests/r1/status" }, followUps: [`PUT ${validCancel}`] },
    { overrides: { response_url: "http://queue.fal.run/fal-ai/flux/requests/r1" }, followUps: [`PUT ${validCancel}`] },
    { overrides: { cancel_url: "https://queue.fal.run.evil.example/cancel" }, followUps: [] },
  ];
  for (const { overrides, followUps } of cases) {
    const { fetch, requests } = scripted("fal-ai/flux/schnell", { queueOverrides: overrides, result: { images: [] } });
    const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), { apiKey: KEY });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /unexpected queue address/u);
    // Nothing is polled; the only follow-up is cancelling the paid job at a valid cancel address.
    assert.deepEqual(
      requests.slice(1).map((request) => `${request.method} ${request.url}`),
      followUps,
      JSON.stringify(overrides),
    );
  }
});

test("image URLs off fal.media are refused", async () => {
  const { fetch, requests } = scripted("fal-ai/flux/schnell", {
    result: { images: [{ url: "https://evil.example/out.png" }] },
  });
  const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), { apiKey: KEY });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /unexpected address/u);
  assert.equal(requests.some((request) => request.url.includes("evil.example")), false);
});

test("cancelling while queued sends PUT cancel_url and reports aborted", async () => {
  const controller = new AbortController();
  const info = queue("fal-ai/flux/schnell");
  const { fetch, requests } = fakeFetch((request) => {
    if (request.method === "POST") return json(info);
    if (request.method === "PUT") return json({ status: "CANCELLATION_REQUESTED" });
    controller.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), {
    apiKey: KEY,
    signal: controller.signal,
  });
  assert.equal(result.stopReason, "aborted");
  const cancel = requests.find((request) => request.method === "PUT");
  assert.equal(cancel?.url, info.cancel_url);
  assert.equal(cancel?.headers.authorization, `Key ${KEY}`);
});

test("a rejected key maps to a friendly message without the key", async () => {
  const { fetch } = fakeFetch(() => json({ detail: `No user found for Key ${KEY}` }, 401));
  const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), { apiKey: KEY });
  assert.equal(result.errorMessage, "The fal image key was rejected.");

  const validation = fakeFetch(() => json({ detail: [{ msg: `bad prompt ${KEY}` }] }, 422));
  const rejected = await api(validation.fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), {
    apiKey: KEY,
  });
  assert.equal(rejected.stopReason, "error");
  assert.equal(rejected.errorMessage!.includes(KEY), false);
  assert.match(rejected.errorMessage!, /bad prompt/u);
});

test("a key straddling the error-length cutoff leaks no fragment of itself", async () => {
  const key = "fal_Zq7Xk2Pv9Lm4Tw6Yb3N";
  assert.equal(key.length, 23);
  const info = queue("fal-ai/flux/schnell");
  const sources: [string, (detail: string) => (request: RecordedRequest) => Response][] = [
    ["submit 422", (detail) => () => json({ detail: [{ msg: detail }] }, 422)],
    [
      "result 422",
      (detail) => (request) => {
        if (request.method === "POST") return json(info);
        if (request.url === info.status_url) return json({ status: "COMPLETED" });
        return json({ detail }, 422);
      },
    ],
  ];
  for (const [label, respond] of sources) {
    for (const pad of straddlingPads(key.length)) {
      const { fetch } = fakeFetch(respond(`${"x".repeat(pad)}${key} tail`));
      const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), { apiKey: key });
      assert.equal(result.stopReason, "error", `${label} pad ${pad}`);
      assert.equal(
        secretFragmentIn(result.errorMessage ?? "", key),
        undefined,
        `${label} pad ${pad}: ${result.errorMessage}`,
      );
    }
  }
});

test("references over fal's inline budget fail clearly before anything is sent", async () => {
  const { fetch, requests } = fakeFetch(() => json({}, 500));
  const half = Buffer.alloc(Math.ceil(FAL_INLINE_REFERENCE_BYTES / 2) + 1024);
  Buffer.from(png(3)).copy(half);
  const big: ImageContent = { type: "image", mimeType: "image/png", data: half.toString("base64") };

  const result = await api(fetch).generateImages(model("google/nano-banana-2.1"), context("x", [big, big]), {
    apiKey: KEY,
  });

  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "These reference images are too large for fal; use smaller images.");
  assert.equal(requests.length, 0);
});

test("a transient status failure is retried and the request still completes", async () => {
  const info = queue("fal-ai/flux/schnell");
  const dataUri = `data:image/png;base64,${pngBase64(1)}`;
  let polls = 0;
  const { fetch, requests } = fakeFetch((request) => {
    if (request.method === "POST") return json(info);
    if (request.url === info.status_url) {
      polls += 1;
      if (polls === 1) return json({ detail: "busy" }, 429);
      if (polls === 2) throw new TypeError("fetch failed");
      return json({ status: "COMPLETED" });
    }
    if (request.url === info.response_url) return json({ images: [{ url: dataUri }] });
    return json({}, 500);
  });

  const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), { apiKey: KEY });

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(polls, 3);
  assert.equal(requests.some((request) => request.method === "PUT"), false);
});

test("a status poll that keeps failing gives up, cancels the queued request and reports an error", async () => {
  const info = queue("fal-ai/flux/schnell");
  const { fetch, requests } = fakeFetch((request) => {
    if (request.method === "POST") return json(info);
    if (request.method === "PUT") return json({ status: "CANCELLATION_REQUESTED" });
    return json({ detail: "maintenance" }, 503);
  });

  const result = await api(fetch).generateImages(model("fal-ai/flux/schnell"), context("x"), { apiKey: KEY });

  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /fal had a problem \(503\)/u);
  const cancels = requests.filter((request) => request.method === "PUT");
  assert.deepEqual(cancels.map((request) => request.url), [info.cancel_url]);
});
