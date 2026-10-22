import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRestoreImageDownloader, type RestoreImagePin } from "./restore-image-download.js";
import { BotComputerError } from "./types.js";

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

type Mode = "normal" | "ignore-range" | "cut-after-half" | "oversize" | "unsatisfiable" | "tampered" | "redirect" | "stall";

const body = randomBytes(256 * 1024);
const pin = (url: string, overrides: Partial<RestoreImagePin> = {}): RestoreImagePin => ({
  version: "26.6.2",
  build: "25G83",
  url,
  bytes: body.length,
  sha256: createHash("sha256").update(body).digest("hex"),
  ...overrides,
});

async function serve(state: { mode: Mode; ranges: (string | undefined)[] }): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    state.ranges.push(request.headers.range);
    if (state.mode === "redirect") {
      response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere.ipsw" }).end();
      return;
    }
    const range = /^bytes=(\d+)-$/u.exec(request.headers.range ?? "");
    if (state.mode === "unsatisfiable" && range) {
      response.writeHead(416).end();
      return;
    }
    const start = range && state.mode !== "ignore-range" ? Number(range[1]) : 0;
    let payload = state.mode === "oversize" ? Buffer.concat([body, Buffer.alloc(4096, 1)]) : body;
    if (state.mode === "tampered") payload = Buffer.from(body).fill(0, 1000, 2000);
    const slice = payload.subarray(start);
    response.writeHead(start > 0 ? 206 : 200, {
      "content-length": String(slice.length),
      ...(start > 0 ? { "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}` } : {}),
    });
    if (state.mode === "stall") {
      response.write(slice.subarray(0, 1024));
      return;
    }
    if (state.mode === "cut-after-half") {
      response.write(slice.subarray(0, Math.floor(slice.length / 2)), () => response.destroy());
      return;
    }
    response.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}/UniversalMac_26.6.2_25G83_Restore.ipsw` };
}

function setup(mode: Mode, free = 1e12, overrides: Partial<RestoreImagePin> = {}) {
  const state = { mode, ranges: [] as (string | undefined)[] };
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "p8-ipsw-")), "restore-images");
  return {
    state,
    dir,
    async start() {
      const { server, url } = await serve(state);
      const downloader = createRestoreImageDownloader({
        dir,
        image: pin(url, overrides),
        freeDiskBytes: async () => free,
        reserveBytes: 1024,
        stallTimeoutMs: 300,
        connectTimeoutMs: 2_000,
        progressIntervalMs: 0,
      });
      return { server, downloader };
    },
  };
}

test("a whole download is verified and kept under its build name, owner-only", async () => {
  const context = setup("normal");
  const { server, downloader } = await context.start();
  const phases: string[] = [];
  try {
    const file = await downloader.download({ onProgress: (progress) => phases.push(progress.phase) });
    assert.deepEqual(readFileSync(file), body);
    assert.equal(path.basename(file), "UniversalMac_25G83_Restore.ipsw");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(existsSync(downloader.paths().partial), false);
    assert.ok(phases.includes("downloading") && last(phases) === "verifying");
  } finally {
    server.close();
  }
});

test("an interrupted download keeps its partial and resumes with Range", async () => {
  const context = setup("cut-after-half");
  const { server, downloader } = await context.start();
  try {
    await assert.rejects(downloader.download(), (error: unknown) => error instanceof BotComputerError && error.code === "download_failed");
    const kept = await downloader.partialBytes();
    assert.ok(kept > 0 && kept < body.length);
    context.state.mode = "normal";
    const file = await downloader.download();
    assert.deepEqual(readFileSync(file), body);
    assert.equal(last(context.state.ranges), `bytes=${kept}-`);
  } finally {
    server.close();
  }
});

test("a server that ignores Range restarts from zero, and 416 verifies the partial", async () => {
  const restart = setup("ignore-range");
  mkdirSync(restart.dir, { recursive: true });
  const first = await restart.start();
  writeFileSync(first.downloader.paths().partial, body.subarray(0, 5000));
  try {
    assert.deepEqual(readFileSync(await first.downloader.download()), body);
  } finally {
    first.server.close();
  }

  const complete = setup("unsatisfiable");
  mkdirSync(complete.dir, { recursive: true });
  const second = await complete.start();
  writeFileSync(second.downloader.paths().partial, body);
  try {
    assert.deepEqual(readFileSync(await second.downloader.download()), body);
  } finally {
    second.server.close();
  }
});

test("a tampered download is refused and deleted; an oversize one is cut off", async () => {
  const tampered = setup("tampered");
  const first = await tampered.start();
  try {
    await assert.rejects(first.downloader.download(), /didn't match/u);
    assert.equal(existsSync(first.downloader.paths().partial), false);
    assert.equal(existsSync(first.downloader.paths().final), false);
  } finally {
    first.server.close();
  }
  const oversize = setup("oversize");
  const second = await oversize.start();
  try {
    await assert.rejects(second.downloader.download(), /larger than expected/u);
    assert.equal(existsSync(second.downloader.paths().partial), false);
  } finally {
    second.server.close();
  }
});

test("low disk space is reported before anything is downloaded", async () => {
  const context = setup("normal", 1000);
  const { server, downloader } = await context.start();
  try {
    await assert.rejects(downloader.download(), (error: unknown) => error instanceof BotComputerError && error.code === "low_disk");
    assert.equal(context.state.ranges.length, 0);
    assert.equal(await downloader.requiredFreeBytes(), body.length + 1024);
  } finally {
    server.close();
  }
});

test("a redirect is refused: only the pinned URL is fetched", async () => {
  const context = setup("redirect");
  const { server, downloader } = await context.start();
  try {
    await assert.rejects(downloader.download(), (error: unknown) => error instanceof BotComputerError && error.code === "download_failed");
    assert.equal(context.state.ranges.length, 1);
  } finally {
    server.close();
  }
});

test("cancel keeps the partial, concurrent calls share one download, and remove deletes it", async () => {
  const context = setup("stall");
  const { server, downloader } = await context.start();
  try {
    const first = downloader.download();
    const second = downloader.download();
    assert.equal(first, second);
    await new Promise((resolve) => setTimeout(resolve, 100));
    downloader.cancel();
    await assert.rejects(first, (error: unknown) => error instanceof BotComputerError && error.code === "cancelled");
    assert.equal(context.state.ranges.length, 1);
    assert.equal(await downloader.partialBytes(), 1024);
    await downloader.remove();
    assert.equal(await downloader.partialBytes(), 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a stalled download stops with a resumable message", async () => {
  const context = setup("stall");
  const { server, downloader } = await context.start();
  try {
    await assert.rejects(downloader.download(), /stalled/u);
    assert.equal(await downloader.partialBytes(), 1024);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
