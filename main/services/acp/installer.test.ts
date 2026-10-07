import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { AcpPlatformAsset, AcpRelease } from "./harness.js";
import { AcpRuntimeInstaller, type AcpInstallerDependencies } from "./installer.js";
import { storedZip, tempDir } from "./test-support.js";

const server = Buffer.from("#!/bin/sh\necho server\n");
const helper = Buffer.from("#!/bin/sh\necho helper\n");

function release(archive: Buffer, overrides: Partial<AcpPlatformAsset> = {}): AcpRelease {
  return {
    version: "2.0.0",
    platforms: {
      "darwin-arm64": {
        url: "https://dl.example.com/runtime.zip",
        sha256: createHash("sha256").update(archive).digest("hex"),
        archiveBytes: archive.length,
        members: [
          { name: "server", bytes: server.length },
          { name: "helper", bytes: helper.length },
        ],
        executable: "server",
        args: [],
        ...overrides,
      },
    },
  };
}

function goodArchive(): Buffer {
  return storedZip([
    { name: "server", data: server },
    { name: "helper", data: helper },
  ]);
}

interface Recorder {
  fetches: number;
  validations: number;
}

function deps(archive: Buffer, recorder: Recorder, overrides: Partial<AcpInstallerDependencies> = {}): AcpInstallerDependencies {
  return {
    fetch: async () => {
      recorder.fetches += 1;
      return new Response(new Uint8Array(archive));
    },
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    validate: async () => {
      recorder.validations += 1;
    },
    ...overrides,
  };
}

function setup(archive = goodArchive(), overrides: Partial<AcpInstallerDependencies> = {}, releaseValue = release(archive)) {
  const dir = tempDir();
  const recorder: Recorder = { fetches: 0, validations: 0 };
  const installer = new AcpRuntimeInstaller(releaseValue, "darwin-arm64", dir, deps(archive, recorder, overrides));
  return { dir, recorder, installer, releaseValue };
}

test("a supported platform starts not installed and states the download and space needed", async () => {
  const { installer, recorder } = setup();
  const state = await installer.load();
  assert.equal(state.status, "not_installed");
  if (state.status !== "not_installed") return;
  assert.equal(state.downloadBytes, goodArchive().length);
  assert.ok(state.requiredBytes > 256 * 1024 * 1024);
  assert.equal(recorder.fetches, 0, "nothing is downloaded until install is requested");
  assert.throws(() => installer.acquire(), /not installed/u);
});

test("a platform without a pinned build is unsupported", async () => {
  const installer = new AcpRuntimeInstaller(release(goodArchive()), "linux-x64", tempDir(), deps(goodArchive(), { fetches: 0, validations: 0 }));
  assert.equal((await installer.load()).status, "unsupported");
  await assert.rejects(installer.install());
});

test("install verifies, validates and activates the exact pinned members", async () => {
  const { installer, recorder } = setup();
  const phases: string[] = [];
  installer.onChange((state) => {
    if (state.status === "installing" && phases[phases.length - 1] !== state.progress.phase) phases.push(state.progress.phase);
  });
  await installer.install();
  assert.equal(recorder.validations, 1);
  const state = installer.state();
  assert.equal(state.status, "installed");
  const lease = installer.acquire();
  for (const name of ["server", "helper"]) {
    const info = statSync(path.join(lease.runtimeDir, name));
    assert.equal(info.mode & 0o111, 0o111, `${name} is executable`);
  }
  lease.release();
  assert.deepEqual(phases, ["downloading", "verifying", "extracting", "validating", "activating"]);
});

test("a tampered download is refused and nothing is installed", async () => {
  const archive = goodArchive();
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 30] ^= 0xff;
  const { installer, dir } = setup(tampered, {}, release(archive));
  await assert.rejects(installer.install(), /size or SHA-256/u);
  assert.equal(installer.state().status, "failed");
  assert.equal(existsSync(path.join(dir, "darwin-arm64", "versions")), false);
});

test("a download larger than pinned is cut off", async () => {
  const archive = goodArchive();
  const { installer } = setup(Buffer.concat([archive, Buffer.alloc(64)]), {}, release(archive));
  await assert.rejects(installer.install(), /larger than expected/u);
});

test("archives with unexpected, missing or resized members are refused", async () => {
  const extra = storedZip([
    { name: "server", data: server },
    { name: "helper", data: helper },
    { name: "payload", data: Buffer.from("x") },
  ]);
  await assert.rejects(setup(extra).installer.install(), /expected files/u);

  const traversal = storedZip([
    { name: "server", data: server },
    { name: "../helper", data: helper },
  ]);
  await assert.rejects(setup(traversal, {}, release(traversal)).installer.install(), /unexpected|could not be extracted/u);

  const resized = storedZip([
    { name: "server", data: server },
    { name: "helper", data: Buffer.from("different length helper\n") },
  ]);
  await assert.rejects(setup(resized, {}, release(resized)).installer.install(), /unexpected files/u);
});

test("low disk space is reported before anything is downloaded", async () => {
  const { installer, recorder } = setup(goodArchive(), { freeBytes: async () => 1024 });
  await assert.rejects(installer.install(), /needs about .* MB free/u);
  assert.equal(recorder.fetches, 0);
});

test("a runtime that fails its identity check is never activated", async () => {
  const { installer } = setup(goodArchive(), {
    validate: async () => {
      throw new Error("The installed runtime is not Google Antigravity.");
    },
  });
  await assert.rejects(installer.install(), /not Google Antigravity/u);
  assert.equal(installer.state().status, "failed");
  assert.throws(() => installer.acquire());
});

test("cancelling an install leaves nothing behind", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const archive = goodArchive();
  const { installer, dir } = setup(archive, {
    fetch: async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(archive.subarray(0, 10)));
          await gate;
          controller.close();
        },
      });
      init.signal.addEventListener("abort", () => release());
      return new Response(body);
    },
  });
  const pending = installer.install();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(installer.state().status, "installing");
  installer.cancel();
  await assert.rejects(pending);
  const state = installer.state();
  assert.equal(state.status, "failed");
  assert.match(state.status === "failed" ? state.message : "", /cancelled/u);
  assert.equal(existsSync(path.join(dir, "darwin-arm64", "versions")), false);
});

test("removal waits for running processes, and a restart recognises an intact install only", async () => {
  const { installer, dir, releaseValue } = setup();
  await installer.install();
  const lease = installer.acquire();
  await assert.rejects(installer.remove(), /Stop running chats/u);
  lease.release();

  const reopened = new AcpRuntimeInstaller(releaseValue, "darwin-arm64", dir, deps(goodArchive(), { fetches: 0, validations: 0 }));
  assert.equal((await reopened.load()).status, "installed");
  const runtimeDir = reopened.acquire();
  rmSync(path.join(runtimeDir.runtimeDir, "helper"));
  runtimeDir.release();
  const damaged = new AcpRuntimeInstaller(releaseValue, "darwin-arm64", dir, deps(goodArchive(), { fetches: 0, validations: 0 }));
  assert.equal((await damaged.load()).status, "not_installed");

  await installer.remove();
  assert.equal(installer.state().status, "not_installed");
  assert.equal(existsSync(path.join(dir, "darwin-arm64")), false);
});

test("a pin newer than the installed runtime offers an update", async () => {
  const { installer, dir } = setup();
  await installer.install();
  const newer = storedZip([
    { name: "server", data: Buffer.from("#!/bin/sh\necho new\n") },
    { name: "helper", data: helper },
  ]);
  const next = new AcpRuntimeInstaller(
    { ...release(newer, { members: [{ name: "server", bytes: 19 }, { name: "helper", bytes: helper.length }] }), version: "2.1.0" },
    "darwin-arm64",
    dir,
    deps(newer, { fetches: 0, validations: 0 }),
  );
  const state = await next.load();
  assert.equal(state.status, "update_available");
  if (state.status === "update_available") assert.equal(state.installedVersion, "2.0.0");
});
