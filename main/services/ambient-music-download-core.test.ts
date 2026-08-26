import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import rawProductionManifest from "../../resources/ambient-music/asset-manifest.json";
import {
  ambientMusicAssetUrl,
  ambientMusicDiskBudget,
  canResumeAmbientMusicPartial,
  parseAmbientMusicAssetManifest,
  parseAmbientMusicContentRange,
  resolveAmbientMusicOwnedPath,
  validateAmbientMusicRedirect,
} from "./ambient-music-download-core.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const manifest = parseAmbientMusicAssetManifest({
  version: 1,
  source: "google/magenta-realtime-2",
  revision: "a".repeat(40),
  license: "CC-BY-4.0",
  termsUrl: "https://huggingface.co/google/magenta-realtime-2",
  bundled: false,
  files: [
    { role: "shared", relativePath: "resources/shared.bin", size: 6, sha256: hash("shared") },
    { role: "mrt2_small", relativePath: "models/mrt2_small/small.bin", size: 5, sha256: hash("small") },
    { role: "mrt2_base", relativePath: "models/mrt2_base/base.bin", size: 4, sha256: hash("base") },
  ],
});

test("parses a pinned non-bundled manifest and derives the only production URL", () => {
  const url = ambientMusicAssetUrl(manifest, manifest.files[1]);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "huggingface.co");
  assert.equal(url.pathname, `/google/magenta-realtime-2/resolve/${"a".repeat(40)}/models/mrt2_small/small.bin`);
  assert.equal(url.search, "?download=true");
  assert.throws(() => parseAmbientMusicAssetManifest({ ...manifest, bundled: true }), /invalid pinned manifest/);
});

test("rejects path escape and redirect drift", () => {
  assert.throws(() => resolveAmbientMusicOwnedPath("/tmp/safe", "../escape"), /unsafe/);
  assert.equal(resolveAmbientMusicOwnedPath("/tmp/safe", "models/file"), path.join("/tmp/safe", "models/file"));
  const current = new URL("https://huggingface.co/google/model/resolve/revision/file");
  assert.equal(validateAmbientMusicRedirect(current, "https://cdn-lfs.hf.co/objects/file").hostname, "cdn-lfs.hf.co");
  assert.equal(
    validateAmbientMusicRedirect(
      current,
      "https://us.aws.cdn.hf.co/xet-bridge-us/0123456789abcdef/abcdef0123456789",
    ).hostname,
    "us.aws.cdn.hf.co",
  );
  assert.throws(
    () => validateAmbientMusicRedirect(current, "https://huggingface.co/another/repo/resolve/revision/file"),
    /different repository/,
  );
  assert.throws(() => validateAmbientMusicRedirect(current, "https://example.com/file"), /trusted download boundary/);
  assert.throws(() => validateAmbientMusicRedirect(current, "http://cdn-lfs.hf.co/file"), /trusted download boundary/);
});

test("validates content ranges, resumable metadata, and safety-margin disk budget", () => {
  assert.deepEqual(parseAmbientMusicContentRange("bytes 5-9/10"), { start: 5, end: 9, total: 10 });
  assert.equal(parseAmbientMusicContentRange("bytes */10"), null);
  assert.equal(canResumeAmbientMusicPartial({
    version: 1,
    revision: manifest.revision,
    relativePath: manifest.files[1].relativePath,
    expectedSize: 5,
    etag: "etag",
  }, manifest, manifest.files[1], 2), true);
  assert.equal(ambientMusicDiskBudget(100), 512 * 1024 * 1024 + 100);
});

test("production manifest pins every reviewed model asset and exact footprint", () => {
  const production = parseAmbientMusicAssetManifest(rawProductionManifest);
  assert.equal(production.revision, "010aa0dcb0dfd27b24f0ad07b4dad63e8f9521cc");
  assert.equal(production.bundled, false);
  assert.equal(production.files.length, 14);
  const totals = Object.fromEntries(["shared", "mrt2_small", "mrt2_base"].map((role) => [
    role,
    production.files.filter((asset) => asset.role === role).reduce((sum, asset) => sum + asset.size, 0),
  ]));
  assert.deepEqual(totals, {
    shared: 1_375_741_343,
    mrt2_small: 464_331_548,
    mrt2_base: 2_788_354_715,
  });
});
