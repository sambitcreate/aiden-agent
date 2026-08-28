/* global process */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
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

test("development and release packaging vendor Generative UI libraries before building", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    packageJson.scripts.package,
    /computer-use:vendor.+generative-ui:vendor.+build:native.+npm run build/u,
  );

  const distributionSource = await readFile(
    new URL("./run-macos-distribution.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    distributionSource,
    /npm\("computer-use:vendor"\);[\s\S]{0,100}npm\("generative-ui:vendor"\);[\s\S]{0,100}npm\("build:native"\);/u,
  );
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

test("release artifact configuration uses stable GitHub-safe names", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.build.mac.artifactName, "Aiden-Agent-${version}-${arch}-mac.${ext}");
  assert.equal(packageJson.build.dmg.artifactName, "Aiden-Agent-Beta-${version}-${arch}.${ext}");
});

test("release assets stay draft-only until the complete update set is uploaded", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const publisher = await readFile(new URL("./publish-github-release.sh", import.meta.url), "utf8");
  assert.match(workflow, /bash scripts\/publish-github-release\.sh release\/distribution/u);

  const existingReleaseGuard = publisher.indexOf("if lookup_release_with_retry");
  const draftAwareLookup = publisher.indexOf('gh release view "$RELEASE_TAG"');
  const websiteAlias = publisher.indexOf('website_dmg="$RUNNER_TEMP/Aiden-Agent-Beta-arm64.dmg"');
  const createDraft = publisher.indexOf('gh release create "$RELEASE_TAG"');
  const publishDraft = publisher.indexOf('gh release edit "$RELEASE_TAG"');

  assert.ok(existingReleaseGuard >= 0, "release reruns must reject an existing tag or draft");
  assert.ok(draftAwareLookup >= 0, "release lookup must include unpublished drafts");
  assert.ok(websiteAlias > existingReleaseGuard, "the website alias must follow the guard");
  assert.ok(
    createDraft > existingReleaseGuard,
    "draft creation must follow the immutability guard",
  );
  assert.ok(createDraft > websiteAlias, "the website alias must exist before draft upload");
  assert.ok(publishDraft > createDraft, "publication must happen only after draft asset upload");

  const preparation = publisher.slice(websiteAlias, createDraft);
  assert.match(preparation, /cp -- "\$\{dmg_assets\[0\]\}" "\$website_dmg"/u);
  assert.match(preparation, /website_sha256=.*printf '%s {2}%s\\n'/su);

  const upload = publisher.slice(createDraft, publishDraft);
  assert.match(upload, /--draft\s+\\\s+-- "\$\{release_assets\[@\]\}"/u);
  assert.match(upload, /gh release upload[\s\S]*--clobber/u);
  assert.match(upload, /release_matches_identity true/u);
  assert.match(upload, /release_has_expected_assets/u);
  assert.doesNotMatch(upload, /--latest/u);

  const publish = publisher.slice(publishDraft);
  assert.match(publish, /--draft=false\s+\\\s+--latest/u);
  assert.match(publish, /release_matches_identity false/u);
});

test("release publication checks deployed consumers before building", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const consumerCheck = workflow.indexOf("npm run release:check-consumers");
  const distributionBuild = workflow.indexOf("npm run dist");
  const versionResolution = workflow.indexOf("Resolve the declared release version");
  const dependencyInstall = workflow.indexOf("Install locked dependencies");

  assert.match(workflow, /git ls-remote --tags origin/u);
  assert.doesNotMatch(workflow, /GITHUB_RUN_NUMBER|--allow-same-version/u);
  assert.match(workflow, /node scripts\/prepare-ci-release\.mjs "\$base_tag_exists"/u);
  assert.match(workflow, /steps\.version\.outputs\.publish == 'true'/u);
  assert.ok(versionResolution >= 0 && versionResolution < dependencyInstall);
  for (const stepName of [
    "Install locked dependencies",
    "Build, sign, notarize, and verify distribution",
    "Verify diagnostics in the signed packaged app",
    "Publish verified release assets",
  ]) {
    assert.match(
      workflow,
      new RegExp(
        `- name: ${stepName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n` +
          " {8}if: \\$\\{\\{ steps\\.version\\.outputs\\.publish == 'true' \\}\\}",
        "u",
      ),
    );
  }
  assert.ok(consumerCheck >= 0, "the release workflow must check Homebrew and the website");
  assert.ok(
    distributionBuild > consumerCheck,
    "consumer drift must fail before signing and building",
  );
});

test("update metadata is version-bound and requires a hashed ZIP payload", async () => {
  const staging = await mkdtemp(path.join(os.tmpdir(), "aiden-update-metadata-"));
  try {
    const zipContents = "fixture";
    const zipDigest = createHash("sha512").update(zipContents).digest("base64");
    await Promise.all([
      writeFile(path.join(staging, "Aiden-Agent-Beta-1.0.9-arm64.dmg"), "fixture", "utf8"),
      writeFile(path.join(staging, "Aiden-Agent-1.0.9-arm64-mac.zip"), zipContents, "utf8"),
    ]);
    await writeFile(
      path.join(staging, "latest-mac.yml"),
      `version: 1.0.9\nfiles:\n  - url: Aiden-Agent-1.0.9-arm64-mac.zip\n    sha512: ${zipDigest}\npath: Aiden-Agent-1.0.9-arm64-mac.zip\nsha512: ${zipDigest}\n`,
      "utf8",
    );
    assert.equal(
      await verifyMacUpdateMetadata(staging, "1.0.9"),
      path.join(staging, "latest-mac.yml"),
    );
    await assert.rejects(verifyMacUpdateMetadata(staging, "1.0.10"), /does not match/u);
    await writeFile(
      path.join(staging, "latest-mac.yml"),
      `version: 1.0.9\nfiles:\n  - url: Aiden Agent-1.0.9-arm64-mac.zip\n    sha512: ${zipDigest}\npath: Aiden Agent-1.0.9-arm64-mac.zip\nsha512: ${zipDigest}\n`,
      "utf8",
    );
    await assert.rejects(verifyMacUpdateMetadata(staging, "1.0.9"), /exact ZIP release asset/u);
    await writeFile(
      path.join(staging, "latest-mac.yml"),
      `version: 1.0.9\nfiles:\n  - url: Aiden-Agent-1.0.9-arm64-mac.zip\n    sha512: ${zipDigest}\npath: Aiden-Agent-1.0.9-arm64-mac.zip\nsha512: YWlkZW4=\n`,
      "utf8",
    );
    await assert.rejects(verifyMacUpdateMetadata(staging, "1.0.9"), /digest does not match/u);
    await writeFile(
      path.join(staging, "latest-mac.yml"),
      `version: 1.0.9\nreleaseName: version: 1.0.10\nfiles:\n  - url: Aiden-Agent-1.0.9-arm64-mac.zip\n    sha512: ${zipDigest}\npath: Aiden-Agent-1.0.9-arm64-mac.zip\nsha512: ${zipDigest}\n`,
      "utf8",
    );
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
