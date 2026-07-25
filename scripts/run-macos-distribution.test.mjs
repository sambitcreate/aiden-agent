/* global process */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AIDEN_UPDATE_FEED_URL,
  discoverMacDistributionArchives,
  distributionElectronBuilderArguments,
  runDistributionTransaction,
  verifyMacDistributionArchives,
  verifyMacUpdateMetadata,
} from "./run-macos-distribution.mjs";
import { updateModelCapabilities } from "./update-model-capabilities.mjs";

test("distribution failures discard staging before anything is promoted", async () => {
  const events = [];
  await assert.rejects(
    runDistributionTransaction({
      prepare: async () => {
        events.push("prepare");
        return { staging: "/stage", distribution: "/distribution" };
      },
      build: async () => {
        events.push("preflight-or-build");
        throw new Error("missing notarization credentials");
      },
      verify: async () => events.push("verify"),
      promote: async () => events.push("promote"),
      discard: async () => events.push("discard"),
    }),
    /missing notarization credentials/u,
  );
  assert.deepEqual(events, ["prepare", "preflight-or-build", "discard"]);
});

test("a model refresh timeout preserves the snapshot and discards distribution staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-distribution-model-timeout-"));
  const destination = path.join(root, "model-capabilities.json");
  const events = [];
  try {
    await writeFile(destination, "prior snapshot\n", "utf8");
    await assert.rejects(
      runDistributionTransaction({
        prepare: async () => {
          events.push("prepare");
          return { staging: path.join(root, "stage"), distribution: path.join(root, "release") };
        },
        build: async () => {
          events.push("refresh");
          await updateModelCapabilities({
            destination,
            timeoutMs: 10,
            fetch: async () => new Promise(() => undefined),
            log: () => undefined,
          });
        },
        verify: async () => events.push("verify"),
        promote: async () => events.push("promote"),
        discard: async () => events.push("discard"),
      }),
      /release refresh deadline/u,
    );
    assert.deepEqual(events, ["prepare", "refresh", "discard"]);
    assert.equal(await readFile(destination, "utf8"), "prior snapshot\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distribution promotion happens only after build and verification", async () => {
  const events = [];
  const result = await runDistributionTransaction({
    prepare: async () => {
      events.push("prepare");
      return { staging: "/stage", distribution: "/distribution" };
    },
    build: async () => events.push("build"),
    verify: async () => events.push("verify"),
    promote: async () => {
      events.push("promote");
      return "/distribution";
    },
    discard: async () => events.push("discard"),
  });
  assert.equal(result, "/distribution");
  assert.deepEqual(events, ["prepare", "build", "verify", "promote"]);
});

test("distribution archive discovery requires exactly one current DMG and ZIP", async () => {
  const staging = await mkdtemp(path.join(os.tmpdir(), "aiden-distribution-artifacts-"));
  try {
    await writeFile(path.join(staging, "Aiden Agent.dmg"), "dmg", "utf8");
    await assert.rejects(discoverMacDistributionArchives(staging), /exactly one DMG and ZIP/u);
    await writeFile(path.join(staging, "Aiden Agent.zip"), "zip", "utf8");
    assert.deepEqual(await discoverMacDistributionArchives(staging), {
      dmg: path.join(staging, "Aiden Agent.dmg"),
      zip: path.join(staging, "Aiden Agent.zip"),
    });
    await writeFile(path.join(staging, "stale.zip"), "stale", "utf8");
    await assert.rejects(discoverMacDistributionArchives(staging), /found 1\/2/u);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("automatic-update distributions generate generic-feed metadata without changing local builds", () => {
  assert.equal(
    AIDEN_UPDATE_FEED_URL,
    "https://github.com/sambitcreate/aiden-agent/releases/latest/download",
  );
  assert.deepEqual(distributionElectronBuilderArguments("/stage"), [
    "--mac",
    "--config.directories.output=/stage",
  ]);
  assert.deepEqual(distributionElectronBuilderArguments("/stage", { enableAutoUpdates: true }), [
    "--mac",
    "--config.directories.output=/stage",
    "--config.publish.provider=generic",
    `--config.publish.url=${AIDEN_UPDATE_FEED_URL}`,
    "--publish",
    "always",
  ]);
});

test("update metadata is version-bound and requires a hashed ZIP payload", async () => {
  const staging = await mkdtemp(path.join(os.tmpdir(), "aiden-update-metadata-"));
  try {
    await writeFile(
      path.join(staging, "latest-mac.yml"),
      "version: 1.0.9\nfiles:\n  - url: Aiden-Agent-1.0.9.zip\n    sha512: YWlkZW4=\n",
      "utf8",
    );
    assert.equal(await verifyMacUpdateMetadata(staging, "1.0.9"), path.join(staging, "latest-mac.yml"));
    await assert.rejects(verifyMacUpdateMetadata(staging, "1.0.10"), /does not match/u);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("distribution verification opens both archives and binds them to staging identity", async () => {
  const staging = await mkdtemp(path.join(os.tmpdir(), "aiden-distribution-verify-"));
  const identity = { cdHash: "verified" };
  const calls = [];
  try {
    await Promise.all([
      writeFile(path.join(staging, "Aiden Agent.dmg"), "fixture", "utf8"),
      writeFile(path.join(staging, "Aiden Agent.zip"), "fixture", "utf8"),
    ]);
    await verifyMacDistributionArchives(staging, identity, {
      verifyDmg: async (file, expected) => calls.push(["dmg", file, expected]),
      verifyZip: async (file, expected) => calls.push(["zip", file, expected]),
    });
    assert.deepEqual(calls, [
      ["dmg", path.join(staging, "Aiden Agent.dmg"), identity],
      ["zip", path.join(staging, "Aiden Agent.zip"), identity],
    ]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test(
  "literal text files named DMG and ZIP cannot pass production archive verification",
  { skip: process.platform !== "darwin" },
  async () => {
    const staging = await mkdtemp(path.join(os.tmpdir(), "aiden-distribution-invalid-"));
    try {
      await Promise.all([
        writeFile(path.join(staging, "Aiden Agent.dmg"), "not a disk image", "utf8"),
        writeFile(path.join(staging, "Aiden Agent.zip"), "not a zip archive", "utf8"),
      ]);
      await assert.rejects(verifyMacDistributionArchives(staging, {}), /hdiutil failed/u);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  },
);
