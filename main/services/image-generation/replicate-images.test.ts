import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent, ImagesContext } from "@earendil-works/pi-ai";
import type { ImageModelAdapter } from "../../../renderer/shared/image-generation/types.js";
import { REPLICATE_INLINE_REFERENCE_BYTES, replicateImagesApi } from "./replicate-images.js";
import { bytes, fakeFetch, imageModel, json, png, pngBase64, type RecordedRequest } from "./test-support.js";

const KEY = "r8_secret_token_value";
const DELIVERY = "https://replicate.delivery/xezq/abc/out.png";

type Meta = Extract<ImageModelAdapter, { kind: "replicate" }>;
const META: Record<string, Meta> = {
  "google/nano-banana-2.1": { kind: "replicate", referenceField: "image_input", maxReferences: 3 },
  "black-forest-labs/flux-kontext-max": { kind: "replicate", referenceField: "input_image" },
  "black-forest-labs/flux-schnell": { kind: "replicate" },
};

function api(fetchImpl: typeof fetch) {
  return replicateImagesApi({ fetch: fetchImpl, pollIntervalMs: 1, metadata: (id) => META[id] });
}

function model(id: string) {
  return imageModel("replicate", id, "replicate-images", ["text", "image"]);
}

function context(prompt: string, references: ImageContent[] = []): ImagesContext {
  return { input: [{ type: "text", text: prompt }, ...references] };
}

const smallRef: ImageContent = { type: "image", mimeType: "image/png", data: pngBase64(7) };

function largeRef(): ImageContent {
  const big = Buffer.alloc(REPLICATE_INLINE_REFERENCE_BYTES + 1024);
  Buffer.from(png(9)).copy(big);
  return { type: "image", mimeType: "image/png", data: big.toString("base64") };
}

function isCreate(request: RecordedRequest) {
  return request.method === "POST" && request.url.endsWith("/predictions") && request.url.includes("/models/");
}

test("a prediction finished within Prefer: wait is downloaded once, without the key", async () => {
  const { fetch, requests } = fakeFetch((request) => {
    if (isCreate(request)) return json({ id: "p1", status: "succeeded", output: DELIVERY }, 201);
    if (request.url === DELIVERY) return bytes(png(3));
    return json({}, 500);
  });

  const result = await api(fetch).generateImages(
    model("google/nano-banana-2.1"),
    context("a red fox", [smallRef]),
    { apiKey: KEY },
  );

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: pngBase64(3) }]);
  const [create, download] = requests;
  assert.equal(create!.url, "https://api.replicate.com/v1/models/google/nano-banana-2.1/predictions");
  assert.equal(create!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(create!.headers.prefer, "wait=60");
  assert.deepEqual(create!.body, {
    input: { prompt: "a red fox", image_input: [`data:image/png;base64,${smallRef.data}`] },
  });
  assert.equal(download!.url, DELIVERY);
  assert.equal(download!.headers.authorization, undefined);
  assert.equal(requests.length, 2);
});

test("an unfinished prediction is polled until it succeeds", async () => {
  let polls = 0;
  const outputs = ["https://replicate.delivery/a.png", "https://cdn.replicate.delivery/b.png"];
  const { fetch, requests } = fakeFetch((request) => {
    if (isCreate(request)) return json({ id: "p2", status: "starting", output: null });
    if (request.url === "https://api.replicate.com/v1/predictions/p2") {
      polls += 1;
      return json(polls < 2 ? { id: "p2", status: "processing" } : { id: "p2", status: "succeeded", output: outputs });
    }
    if (outputs.includes(request.url)) return bytes(png(outputs.indexOf(request.url) + 1));
    return json({}, 500);
  });

  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("a fox"), {
    apiKey: KEY,
  });

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(polls, 2);
  assert.equal(result.output.length, 2);
  assert.ok(requests.filter((request) => request.method === "GET" && request.url.includes("/predictions/")).every(
    (request) => request.headers.authorization === `Bearer ${KEY}`,
  ));
});

test("a failed prediction reports Replicate's reason", async () => {
  const { fetch } = fakeFetch((request) =>
    isCreate(request)
      ? json({ id: "p3", status: "failed", error: "NSFW content detected" })
      : json({}, 500),
  );
  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), {
    apiKey: KEY,
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /NSFW content detected/u);
  assert.deepEqual(result.output, []);
});

test("cancelling mid-poll cancels the prediction and reports aborted", async () => {
  const controller = new AbortController();
  const { fetch, requests } = fakeFetch((request) => {
    if (isCreate(request)) return json({ id: "p4", status: "processing" });
    if (request.url.endsWith("/cancel")) return json({ id: "p4", status: "canceled" });
    controller.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  });

  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), {
    apiKey: KEY,
    signal: controller.signal,
  });

  assert.equal(result.stopReason, "aborted");
  const cancel = requests.find((request) => request.url.endsWith("/cancel"));
  assert.equal(cancel?.url, "https://api.replicate.com/v1/predictions/p4/cancel");
  assert.equal(cancel?.method, "POST");
  assert.equal(cancel?.headers.authorization, `Bearer ${KEY}`);
});

test("output outside replicate.delivery is refused without fetching it", async () => {
  for (const output of [
    "https://evil.example/out.png",
    "https://replicate.delivery.evil.example/out.png",
    "http://replicate.delivery/out.png",
  ]) {
    const { fetch, requests } = fakeFetch((request) =>
      isCreate(request) ? json({ id: "p5", status: "succeeded", output: [output] }) : bytes(png(1)),
    );
    const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), {
      apiKey: KEY,
    });
    assert.equal(result.stopReason, "error", output);
    assert.match(result.errorMessage ?? "", /unexpected address/u);
    assert.equal(requests.length, 1, output);
  }
});

test("references over 256 KB are uploaded, smaller ones are inlined", async () => {
  const uploaded = "https://api.replicate.com/v1/files/f1";
  const { fetch, requests } = fakeFetch((request) => {
    if (request.url === "https://api.replicate.com/v1/files") return json({ id: "f1", urls: { get: uploaded } }, 201);
    if (isCreate(request)) return json({ id: "p6", status: "succeeded", output: DELIVERY });
    return bytes(png(2));
  });

  const result = await api(fetch).generateImages(
    model("google/nano-banana-2.1"),
    context("blend", [smallRef, largeRef()]),
    { apiKey: KEY },
  );

  assert.equal(result.stopReason, "stop", result.errorMessage);
  const upload = requests.find((request) => request.url.endsWith("/v1/files"));
  assert.ok(upload?.body instanceof FormData);
  assert.ok((upload.body as FormData).get("content") instanceof Blob);
  const create = requests.find(isCreate);
  const input = (create?.body as { input: { image_input: string[] } }).input;
  assert.equal(input.image_input[0], `data:image/png;base64,${smallRef.data}`);
  assert.equal(input.image_input[1], uploaded);
});

test("an upload answered with a foreign file address is refused", async () => {
  const { fetch, requests } = fakeFetch((request) =>
    request.url.endsWith("/v1/files") ? json({ urls: { get: "https://evil.example/f1" } }) : json({}, 500),
  );
  const result = await api(fetch).generateImages(model("google/nano-banana-2.1"), context("x", [largeRef()]), {
    apiKey: KEY,
  });
  assert.equal(result.stopReason, "error");
  assert.equal(requests.some(isCreate), false);
});

test("a single-image field gets one string; extra or unsupported references fail before any request", async () => {
  const single = fakeFetch((request) =>
    isCreate(request) ? json({ id: "p7", status: "succeeded", output: DELIVERY }) : bytes(png(4)),
  );
  const ok = await api(single.fetch).generateImages(
    model("black-forest-labs/flux-kontext-max"),
    context("edit", [smallRef]),
    { apiKey: KEY },
  );
  assert.equal(ok.stopReason, "stop", ok.errorMessage);
  assert.deepEqual(single.requests.find(isCreate)?.body, {
    input: { prompt: "edit", input_image: `data:image/png;base64,${smallRef.data}` },
  });

  const cases: [string, ImageContent[], RegExp][] = [
    ["black-forest-labs/flux-kontext-max", [smallRef, smallRef], /accepts one reference image/u],
    ["google/nano-banana-2.1", [smallRef, smallRef, smallRef, smallRef], /at most 3 reference images/u],
    ["black-forest-labs/flux-schnell", [smallRef], /doesn't accept reference images/u],
  ];
  for (const [id, references, message] of cases) {
    const { fetch, requests } = fakeFetch(() => json({}, 500));
    const result = await api(fetch).generateImages(model(id), context("x", references), { apiKey: KEY });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", message);
    assert.equal(requests.length, 0);
  }
});

test("errors never carry the key, even when Replicate echoes it", async () => {
  const statuses: [number, unknown][] = [
    [401, { detail: `Invalid token ${KEY}` }],
    [422, { detail: `input rejected for ${KEY}` }],
    [500, { detail: KEY }],
  ];
  for (const [status, body] of statuses) {
    const { fetch } = fakeFetch(() => json(body, status));
    const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), {
      apiKey: KEY,
    });
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage, `status ${status}`);
    assert.equal(result.errorMessage!.includes(KEY), false, `status ${status}`);
  }
  const rejected = fakeFetch(() => json({ detail: "Unauthenticated" }, 401));
  const result = await api(rejected.fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), {
    apiKey: KEY,
  });
  assert.equal(result.errorMessage, "The Replicate image key was rejected.");
});

test("a missing key fails without a request", async () => {
  const { fetch, requests } = fakeFetch(() => json({}, 500));
  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), {});
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /Settings → Image Generation/u);
  assert.equal(requests.length, 0);
});

const VERSION = "5c7d5dc6dd8bf75c1acaa8565735e7986bc5b66206b55cca93cb72c9bf15ccaa";
const PREDICTIONS = "https://api.replicate.com/v1/predictions";

test("a fetched community model runs by its pinned version", async () => {
  const { fetch, requests } = fakeFetch((request) => {
    if (request.method === "POST" && request.url === PREDICTIONS) {
      return json({ id: "v1", status: "succeeded", output: DELIVERY }, 201);
    }
    if (request.url === DELIVERY) return bytes(png(4));
    return json({}, 404);
  });
  const pinned = replicateImagesApi({
    fetch,
    pollIntervalMs: 1,
    metadata: () => ({ kind: "replicate", version: VERSION }),
  });

  const result = await pinned.generateImages(model("someone/community-art"), context("a lighthouse"), { apiKey: KEY });

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(requests[0]!.url, PREDICTIONS);
  assert.deepEqual(requests[0]!.body, { version: VERSION, input: { prompt: "a lighthouse" } });
  assert.equal(requests.some((request) => request.url.includes("/models/")), false);
});

test("a model without a version that 404s by name is retried once through its latest version", async () => {
  const { fetch, requests } = fakeFetch((request) => {
    if (isCreate(request)) return json({ detail: "not found" }, 404);
    if (request.method === "GET" && request.url === "https://api.replicate.com/v1/models/someone/custom-art") {
      return json({ owner: "someone", name: "custom-art", latest_version: { id: VERSION } });
    }
    if (request.method === "POST" && request.url === PREDICTIONS) {
      return json({ id: "v2", status: "succeeded", output: DELIVERY }, 201);
    }
    if (request.url === DELIVERY) return bytes(png(5));
    return json({}, 500);
  });

  const result = await api(fetch).generateImages(model("someone/custom-art"), context("a barn"), { apiKey: KEY });

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "POST https://api.replicate.com/v1/models/someone/custom-art/predictions",
      "GET https://api.replicate.com/v1/models/someone/custom-art",
      `POST ${PREDICTIONS}`,
      `GET ${DELIVERY}`,
    ],
  );
  assert.deepEqual(requests[2]!.body, { version: VERSION, input: { prompt: "a barn" } });
});

test("a transient poll failure is retried and the prediction still completes", async () => {
  let polls = 0;
  const { fetch, requests } = fakeFetch((request) => {
    if (isCreate(request)) return json({ id: "t1", status: "starting" });
    if (request.url === `${PREDICTIONS}/t1`) {
      polls += 1;
      if (polls === 1) return json({ detail: "upstream" }, 503);
      if (polls === 2) return new Response("<html>gateway</html>", { status: 200 });
      return json({ id: "t1", status: "succeeded", output: DELIVERY });
    }
    if (request.url === DELIVERY) return bytes(png(6));
    return json({}, 500);
  });

  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), { apiKey: KEY });

  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(polls, 3);
  assert.equal(requests.some((request) => request.url.endsWith("/cancel")), false);
});

test("a poll that keeps failing gives up, cancels the paid prediction and reports an error", async () => {
  const { fetch, requests } = fakeFetch((request) => {
    if (isCreate(request)) return json({ id: "t2", status: "processing" });
    if (request.url.endsWith("/cancel")) return json({ id: "t2", status: "canceled" });
    return json({ detail: "down" }, 502);
  });

  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), { apiKey: KEY });

  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /Replicate had a problem \(502\)/u);
  const cancels = requests.filter((request) => request.url === `${PREDICTIONS}/t2/cancel`);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0]!.method, "POST");
});

test("a prediction Replicate aborted is reported as cancelled", async () => {
  const { fetch } = fakeFetch((request) =>
    isCreate(request) ? json({ id: "t3", status: "aborted" }) : json({}, 500),
  );
  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), { apiKey: KEY });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Replicate cancelled this prediction.");
});

test("the time-limit message names the limit that applied", async () => {
  const { fetch } = fakeFetch((_request, init) => {
    if (_request.url.endsWith("/cancel")) return json({});
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  // AbortSignal.timeout does not hold the event loop open by itself.
  const keepAlive = setTimeout(() => undefined, 5_000);
  const result = await api(fetch).generateImages(model("black-forest-labs/flux-schnell"), context("x"), {
    apiKey: KEY,
    timeoutMs: 30,
  });
  clearTimeout(keepAlive);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Replicate took longer than 1 second.");
});
