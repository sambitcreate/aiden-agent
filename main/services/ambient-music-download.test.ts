import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AmbientMusicAssetManifest } from "./ambient-music-download-core.js";
import {
  AmbientMusicModelStore,
  type AmbientMusicHttpClient,
  type AmbientMusicHttpResponse,
} from "./ambient-music-download.js";

const bytes = {
  "resources/shared.bin": Buffer.from("shared"),
  "models/mrt2_small/small.bin": Buffer.from("small"),
  "models/mrt2_base/base.bin": Buffer.from("base"),
};
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const manifest: AmbientMusicAssetManifest = {
  version: 1,
  source: "google/magenta-realtime-2",
  revision: "b".repeat(40),
  license: "CC-BY-4.0",
  termsUrl: "https://huggingface.co/google/magenta-realtime-2",
  bundled: false,
  files: [
    { role: "shared", relativePath: "resources/shared.bin", size: 6, sha256: digest(bytes["resources/shared.bin"]) },
    { role: "mrt2_small", relativePath: "models/mrt2_small/small.bin", size: 5, sha256: digest(bytes["models/mrt2_small/small.bin"]) },
    { role: "mrt2_base", relativePath: "models/mrt2_base/base.bin", size: 4, sha256: digest(bytes["models/mrt2_base/base.bin"]) },
  ],
};

class FakeHttpClient implements AmbientMusicHttpClient {
  requests: Array<{ url: URL; headers: Record<string, string> }> = [];

  constructor(private readonly handler: (
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    index: number,
  ) => Promise<AmbientMusicHttpResponse> | AmbientMusicHttpResponse) {}

  async request(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<AmbientMusicHttpResponse> {
    const index = this.requests.length;
    this.requests.push({ url, headers });
    return this.handler(url, headers, signal, index);
  }
}

function assetPath(url: URL): keyof typeof bytes {
  const marker = `/${manifest.revision}/`;
  return decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length)) as keyof typeof bytes;
}

function exactClient(): FakeHttpClient {
  return new FakeHttpClient((url) => ({
    statusCode: 200,
    headers: { etag: `"${digest(bytes[assetPath(url)])}"` },
    body: Readable.from([bytes[assetPath(url)]]),
  }));
}

async function harness(client = exactClient(), available = Number.MAX_SAFE_INTEGER) {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-models-"));
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: client,
    availableBytes: async () => available,
  });
  return {
    root,
    store,
    client,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test("status is offline and an explicit accepted download publishes a verified install", async () => {
  const h = await harness();
  try {
    const status = await h.store.refreshStatus();
    assert.equal(status[0].state, "not_installed");
    assert.equal(h.client.requests.length, 0);
    await assert.rejects(h.store.download("mrt2_small", { termsAccepted: false as true }), /accept/);
    const install = await h.store.download("mrt2_small", { termsAccepted: true });
    assert.equal(install.verified, true);
    assert.equal(h.client.requests.length, 2);
    assert.equal(await h.store.validateModel("mrt2_small", true), true);
    assert.equal(
      await readFile(path.join(install.root, "models/mrt2_small/small.bin"), "utf8"),
      "small",
    );
  } finally {
    await h.cleanup();
  }
});

test("an interrupted download resumes only with matching range and ETag", async () => {
  let failed = false;
  const first = new FakeHttpClient((url) => {
    const value = bytes[assetPath(url)];
    if (assetPath(url) === "resources/shared.bin" && !failed) {
      failed = true;
      return {
        statusCode: 200,
        headers: { etag: "resume-etag" },
        body: Readable.from((async function* () {
          yield value.subarray(0, 3);
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("connection lost");
        })()),
      };
    }
    return { statusCode: 200, headers: { etag: "complete" }, body: Readable.from([value]) };
  });
  const h = await harness(first);
  try {
    await assert.rejects(h.store.download("mrt2_small", { termsAccepted: true }), /download was interrupted/);
    const interrupted = h.store.snapshot()[0];
    assert.equal(interrupted.installedBytes, 3);
    assert.equal(interrupted.additionalDownloadBytes, 8);
    assert.equal(interrupted.reclaimableBytes, 3);
    assert.equal((await stat(path.join(
      h.root,
      "partials",
      manifest.revision,
      "resources/shared.bin.part",
    ))).size, 3);
    const second = new FakeHttpClient((url, headers) => {
      const value = bytes[assetPath(url)];
      if (assetPath(url) === "resources/shared.bin") {
        assert.equal(headers.Range, "bytes=3-");
        assert.equal(headers["If-Range"], "resume-etag");
        return {
          statusCode: 206,
          headers: { etag: "resume-etag", "content-range": "bytes 3-5/6" },
          body: Readable.from([value.subarray(3)]),
        };
      }
      return { statusCode: 200, headers: { etag: "complete" }, body: Readable.from([value]) };
    });
    const resumed = new AmbientMusicModelStore({
      root: h.root,
      manifest,
      httpClient: second,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    await resumed.download("mrt2_small", { termsAccepted: true });
    assert.equal(await resumed.validateModel("mrt2_small", true), true);
  } finally {
    await h.cleanup();
  }
});

test("ETag drift discards the partial and restarts the individual asset", async () => {
  const h = await harness();
  try {
    const partial = path.join(h.root, "partials", manifest.revision, "resources/shared.bin.part");
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(partial, "sha");
    await writeFile(`${partial}.json`, JSON.stringify({
      version: 1,
      revision: manifest.revision,
      relativePath: "resources/shared.bin",
      expectedSize: 6,
      etag: "old",
    }));
    let sharedCalls = 0;
    const drift = new FakeHttpClient((url, headers) => {
      const value = bytes[assetPath(url)];
      if (assetPath(url) === "resources/shared.bin") {
        sharedCalls += 1;
        if (headers.Range) {
          return {
            statusCode: 206,
            headers: { etag: "new", "content-range": "bytes 3-5/6" },
            body: Readable.from([value.subarray(3)]),
          };
        }
      }
      return { statusCode: 200, headers: { etag: "new" }, body: Readable.from([value]) };
    });
    const store = new AmbientMusicModelStore({ root: h.root, manifest, httpClient: drift, availableBytes: async () => Number.MAX_SAFE_INTEGER });
    await store.download("mrt2_small", { termsAccepted: true });
    assert.equal(sharedCalls, 2);
  } finally {
    await h.cleanup();
  }
});

test("low disk and an untrusted redirect fail before publication", async () => {
  const low = await harness(exactClient(), 1);
  try {
    await assert.rejects(low.store.download("mrt2_small", { termsAccepted: true }), /needs .* free bytes/);
    assert.equal(low.client.requests.length, 0);
  } finally {
    await low.cleanup();
  }

  const redirected = await harness(new FakeHttpClient(() => ({
    statusCode: 302,
    headers: { location: "https://example.com/model" },
    body: Readable.from([]),
  })));
  try {
    await assert.rejects(redirected.store.download("mrt2_small", { termsAccepted: true }), /trusted download boundary/);
    assert.equal(await redirected.store.validateModel("mrt2_small"), false);
  } finally {
    await redirected.cleanup();
  }
});

test("hash mismatch is rejected and its invalid partial is removed", async () => {
  const corrupt = new FakeHttpClient((url) => {
    const value = assetPath(url) === "resources/shared.bin" ? Buffer.from("broken") : bytes[assetPath(url)];
    return { statusCode: 200, headers: { etag: "corrupt" }, body: Readable.from([value]) };
  });
  const h = await harness(corrupt);
  try {
    await assert.rejects(h.store.download("mrt2_small", { termsAccepted: true }), /manifest size|failed verification/);
    const partial = path.join(h.root, "partials", manifest.revision, "resources/shared.bin.part");
    await assert.rejects(stat(partial));
  } finally {
    await h.cleanup();
  }
});

test("cancellation settles open streams and leaves a resumable partial", async () => {
  const slow = new FakeHttpClient((url, _headers, signal) => {
    const value = bytes[assetPath(url)];
    return {
      statusCode: 200,
      headers: { etag: "slow-etag" },
      body: Readable.from((async function* () {
        yield value.subarray(0, 2);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
        yield value.subarray(2);
      })()),
    };
  });
  const h = await harness(slow);
  try {
    let resolveFirstChunk!: () => void;
    const firstChunk = new Promise<void>((resolve) => { resolveFirstChunk = resolve; });
    const unsubscribe = h.store.subscribe((models) => {
      if ((models[0].progress?.downloadedBytes ?? 0) >= 2) resolveFirstChunk();
    });
    const operation = h.store.download("mrt2_small", { termsAccepted: true });
    await firstChunk;
    unsubscribe();
    await h.store.cancelDownload();
    await assert.rejects(operation, /cancelled/);
    const partial = path.join(h.root, "partials", manifest.revision, "resources/shared.bin.part");
    assert.equal((await stat(partial)).size, 2);
  } finally {
    await h.cleanup();
  }
});

test("removal retains shared resources until the final installed model is removed", async () => {
  const h = await harness();
  try {
    await h.store.download("mrt2_small", { termsAccepted: true });
    let status = h.store.snapshot();
    assert.equal(status[0].additionalDownloadBytes, 0);
    assert.equal(status[0].reclaimableBytes, 11);
    assert.equal(status[1].additionalDownloadBytes, 4, "Base reuses verified shared resources");
    await h.store.download("mrt2_base", { termsAccepted: true });
    status = h.store.snapshot();
    assert.equal(status[0].reclaimableBytes, 5, "Small removal retains shared resources for Base");
    assert.equal(status[1].reclaimableBytes, 4);
    await h.store.removeModel("mrt2_small");
    assert.equal(await h.store.validateModel("mrt2_base", true), true);
    await h.store.removeModel("mrt2_base");
    assert.equal(await h.store.validateRole("shared"), false);
  } finally {
    await h.cleanup();
  }
});

test("repair restores corruption and a failed Base download preserves the valid Small install", async () => {
  const h = await harness();
  try {
    const small = await h.store.download("mrt2_small", { termsAccepted: true });
    const smallPath = path.join(small.root, "models/mrt2_small/small.bin");
    await writeFile(smallPath, "SMALL");
    assert.equal(await h.store.validateModel("mrt2_small", true), false);

    const repair = new AmbientMusicModelStore({
      root: h.root,
      manifest,
      httpClient: exactClient(),
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    await repair.download("mrt2_small", { termsAccepted: true, repair: true });
    assert.equal(await repair.validateModel("mrt2_small", true), true);

    const offlineBase = new AmbientMusicModelStore({
      root: h.root,
      manifest,
      httpClient: new FakeHttpClient(() => { throw new Error("offline"); }),
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    await assert.rejects(
      offlineBase.download("mrt2_base", { termsAccepted: true }),
      /Could not reach the official model host/,
    );
    assert.equal(await offlineBase.validateModel("mrt2_small", true), true);
    assert.equal(await readFile(smallPath, "utf8"), "small");
  } finally {
    await h.cleanup();
  }
});

test("symlinked storage parents are rejected before any asset write", async () => {
  const h = await harness();
  const outside = await mkdtemp(path.join(tmpdir(), "aiden-ambient-outside-"));
  try {
    await h.store.refreshStatus();
    const revisionParent = path.join(h.root, "partials", manifest.revision);
    await mkdir(revisionParent, { recursive: true });
    await symlink(outside, path.join(revisionParent, "resources"));
    await assert.rejects(
      h.store.download("mrt2_small", { termsAccepted: true }),
      /symlink|non-directory parent/,
    );
    await assert.rejects(stat(path.join(outside, "shared.bin.part")));
  } finally {
    await h.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("same-size corruption earns no disk-budget credit during repair", async () => {
  const h = await harness();
  try {
    const install = await h.store.download("mrt2_small", { termsAccepted: true });
    await writeFile(path.join(install.root, "models/mrt2_small/small.bin"), "SMALL");
    const network = exactClient();
    const repair = new AmbientMusicModelStore({
      root: h.root,
      manifest,
      httpClient: network,
      availableBytes: async () => 512 * 1024 * 1024,
    });
    const damaged = await repair.refreshStatus(true);
    assert.equal(damaged[0].state, "needs_repair");
    assert.equal(damaged[0].installedBytes, 11);
    assert.equal(damaged[0].additionalDownloadBytes, 5);
    assert.equal(damaged[0].reclaimableBytes, 11);
    await assert.rejects(
      repair.download("mrt2_small", { termsAccepted: true, repair: true }),
      /needs .* free bytes/,
    );
    assert.equal(network.requests.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("available storage refreshes after publication and removal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-ambient-free-space-"));
  const readings = [900_000_000, 800_000_000, 900_000_000];
  let index = 0;
  const store = new AmbientMusicModelStore({
    root,
    manifest,
    httpClient: exactClient(),
    availableBytes: async () => readings[Math.min(index++, readings.length - 1)],
  });
  try {
    await store.download("mrt2_small", { termsAccepted: true });
    assert.equal(store.storageSnapshot().availableBytes, 800_000_000);
    await store.removeModel("mrt2_small");
    assert.equal(store.storageSnapshot().availableBytes, 900_000_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaim accounting retains shared files for a damaged second model", async () => {
  const h = await harness();
  try {
    const small = await h.store.download("mrt2_small", { termsAccepted: true });
    await h.store.download("mrt2_base", { termsAccepted: true });
    await writeFile(path.join(small.root, "models/mrt2_base/base.bin"), "BASE");
    const status = await h.store.refreshStatus(true);
    assert.equal(status[1].state, "needs_repair");
    assert.equal(status[0].reclaimableBytes, 5);
    assert.equal(status[1].reclaimableBytes, 4);
    await h.store.removeModel("mrt2_small");
    assert.equal(await h.store.validateRole("shared", true), true);
  } finally {
    await h.cleanup();
  }
});

test("cancellation waits for redirect response destruction to close", async () => {
  let redirectClosed = false;
  let markRedirectCreated: (() => void) | undefined;
  const redirectCreated = new Promise<void>((resolve) => { markRedirectCreated = resolve; });
  class DelayedCloseBody extends Readable {
    _read() {}
    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      setTimeout(() => {
        redirectClosed = true;
        callback(error);
      }, 40);
    }
  }
  const redirected = new FakeHttpClient((_url, _headers, _signal, index) => {
    if (index === 0) {
      markRedirectCreated?.();
      return {
        statusCode: 302,
        headers: { location: "https://us.aws.cdn.hf.co/xet-bridge-us/0123456789abcdef/abcdef0123456789" },
        body: new DelayedCloseBody(),
      };
    }
    return { statusCode: 200, headers: { etag: "never" }, body: Readable.from([]) };
  });
  const h = await harness(redirected);
  try {
    const operation = h.store.download("mrt2_small", { termsAccepted: true });
    await redirectCreated;
    await h.store.cancelDownload();
    await assert.rejects(operation, /cancelled/);
    assert.equal(redirectClosed, true);
  } finally {
    await h.cleanup();
  }
});

test("raw filesystem paths are sanitized from public model errors", async () => {
  const h = await harness(exactClient());
  try {
    const store = new AmbientMusicModelStore({
      root: h.root,
      manifest,
      httpClient: h.client,
      availableBytes: async () => { throw new Error(`EACCES: ${h.root}/secret`); },
    });
    await assert.rejects(
      store.download("mrt2_small", { termsAccepted: true }),
      (error: Error) => !error.message.includes(h.root) && /safely read or write/.test(error.message),
    );
    assert.equal(store.snapshot()[0].error?.message.includes(h.root), false);
  } finally {
    await h.cleanup();
  }
});

test("interrupted publication restores a valid backup over a corrupt target", async () => {
  const h = await harness();
  try {
    const install = await h.store.download("mrt2_small", { termsAccepted: true });
    const target = path.join(install.root, "models/mrt2_small");
    const backup = path.join(install.root, ".models-mrt2_small.backup");
    await rename(target, backup);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "small.bin"), "SMALL");

    assert.equal(await h.store.validateModel("mrt2_small", true), true);
    assert.equal(await readFile(path.join(target, "small.bin"), "utf8"), "small");
    await assert.rejects(stat(backup));
  } finally {
    await h.cleanup();
  }
});

test("a failed new manifest revision preserves the prior verified revision", async () => {
  const h = await harness();
  try {
    await h.store.download("mrt2_small", { termsAccepted: true });
    const nextManifest: AmbientMusicAssetManifest = { ...manifest, revision: "d".repeat(40) };
    const next = new AmbientMusicModelStore({
      root: h.root,
      manifest: nextManifest,
      httpClient: new FakeHttpClient(() => { throw new Error("offline"); }),
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    await assert.rejects(next.download("mrt2_small", { termsAccepted: true }), /official model host/);
    assert.equal(await h.store.validateModel("mrt2_small", true), true);
    assert.equal(await readFile(path.join(
      h.root,
      "installs",
      manifest.revision,
      "models/mrt2_small/small.bin",
    ), "utf8"), "small");
  } finally {
    await h.cleanup();
  }
});

test("model deletion refuses a symlinked owned parent", async () => {
  const h = await harness();
  const outside = await mkdtemp(path.join(tmpdir(), "aiden-ambient-delete-outside-"));
  try {
    await h.store.download("mrt2_small", { termsAccepted: true });
    const models = path.join(h.root, "installs", manifest.revision, "models");
    await rm(models, { recursive: true, force: true });
    await writeFile(path.join(outside, "sentinel"), "keep");
    await symlink(outside, models);
    await assert.rejects(h.store.removeModel("mrt2_small"), /symlink|non-directory parent/);
    assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "keep");
  } finally {
    await h.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});
