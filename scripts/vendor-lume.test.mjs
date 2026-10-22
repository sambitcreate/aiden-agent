/* global Buffer, process, Response, URL */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  LUME_ARCHIVE_MEMBERS,
  LUME_ARTIFACT_KEYS,
  LUME_ARTIFACT_PROVENANCE,
  lumeRequirement,
} from "./bot-computers-lume-pins.mjs";
import {
  assertExactLumeAppTree,
  assertLumeArchiveListing,
  downloadLumeArchive,
  extractLumeApp,
  installLumeApp,
  validateArtifact,
  validateVendoredLume,
  vendorLume,
} from "./vendor-lume.mjs";

// Minimal ustar writer so fixtures can carry entries a well-behaved tar
// refuses to create (absolute paths, `..`, symlinks inside the bundle).
function tarEntry({ name, body = "", type = "0", linkName = "" }) {
  const header = Buffer.alloc(512);
  const content = Buffer.from(body, "utf8");
  const field = (value, offset, length) => header.write(value, offset, length, "utf8");
  const octal = (value, offset, length) => field(value.toString(8).padStart(length - 1, "0"), offset, length - 1);
  field(name, 0, 100);
  octal(type === "5" ? 0o755 : 0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(type === "0" ? content.length : 0, 124, 12);
  octal(0, 136, 12);
  header.fill(" ", 148, 156);
  field(type, 156, 1);
  field(linkName, 157, 100);
  field("ustar", 257, 6);
  field("00", 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, type === "0" ? content : Buffer.alloc(0), padding]);
}

/** The pinned release layout with tiny stand-in contents. */
function releaseEntries(overrides = {}) {
  return LUME_ARCHIVE_MEMBERS.map((name) =>
    overrides[name] ?? (name.endsWith("/") ? { name, type: "5" } : { name, body: `contents of ${name}` }),
  );
}

async function writeTarball(root, entries) {
  const archive = path.join(root, "release.tar.gz");
  await writeFile(archive, gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)])));
  return archive;
}

async function tempRoot(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `aiden-lume-vendor-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Extract the fixture release so the result has the pinned tree. */
async function stagedFixtureApp(t, label) {
  const root = await tempRoot(t, label);
  const archive = await writeTarball(root, releaseEntries());
  const staging = path.join(root, "staging");
  await mkdir(staging);
  const app = await extractLumeApp(archive, staging);
  // Size-match the pinned binary without writing 21 MB (a sparse file).
  await truncate(path.join(app, "Contents", "MacOS", "lume"), LUME_ARTIFACT_PROVENANCE.binaryBytes);
  return { root, app };
}

/** A runner that answers the way a valid pinned bundle would and records every call. */
function recordingRunner(overrides = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "/usr/bin/plutil") {
      const key = args[1];
      return `${overrides[key] ?? (key === "CFBundleIdentifier" ? LUME_ARTIFACT_PROVENANCE.bundleIdentifier : LUME_ARTIFACT_PROVENANCE.bundleVersion)}\n`;
    }
    if (command === "/usr/bin/codesign") {
      if (overrides.codesignFails) throw new Error("code object is not signed at all");
      return "";
    }
    return `${overrides.version ?? LUME_ARTIFACT_PROVENANCE.version}\n`;
  };
  return { runner, calls };
}

const pinnedHash = async () => LUME_ARTIFACT_PROVENANCE.binarySha256;

test("checked-in Lume provenance exactly matches the compiled pins", async () => {
  const checkedIn = JSON.parse(
    await readFile(new URL("../resources/bot-computers/lume-artifact.json", import.meta.url), "utf8"),
  );
  assert.equal(validateArtifact(checkedIn), LUME_ARTIFACT_PROVENANCE);
  assert.deepEqual(checkedIn, LUME_ARTIFACT_PROVENANCE);
});

test("Lume provenance validation rejects missing, additional and drifted fields", async (t) => {
  const missing = { ...LUME_ARTIFACT_PROVENANCE };
  delete missing.binarySha256;
  assert.throws(() => validateArtifact(missing), /provenance keys differ/);
  assert.throws(() => validateArtifact({ ...LUME_ARTIFACT_PROVENANCE, extra: 1 }), /provenance keys differ/);
  for (const field of LUME_ARTIFACT_KEYS) {
    await t.test(field, () => {
      const expected = LUME_ARTIFACT_PROVENANCE[field];
      const drifted = {
        ...LUME_ARTIFACT_PROVENANCE,
        [field]: typeof expected === "number" ? expected + 1 : `${expected}-drifted`,
      };
      assert.throws(() => validateArtifact(drifted), new RegExp(`field '${field}'`));
    });
  }
});

test("the archive listing must be exactly the pinned release, in any order", () => {
  const reversed = [...LUME_ARCHIVE_MEMBERS].reverse();
  assert.deepEqual(assertLumeArchiveListing(`${reversed.join("\n")}\n`), reversed);
  const cases = [
    LUME_ARCHIVE_MEMBERS.filter((name) => name !== "lume.app/Contents/embedded.provisionprofile"),
    [...LUME_ARCHIVE_MEMBERS, "lume.app/Contents/MacOS/helper"],
    [...LUME_ARCHIVE_MEMBERS, "lume.app/Contents/MacOS/lume"],
    LUME_ARCHIVE_MEMBERS.map((name) => (name === "lume" ? "bin/lume" : name)),
  ];
  for (const listing of cases) {
    assert.throws(() => assertLumeArchiveListing(listing.join("\n")), /differs from the pinned release/);
  }
  for (const unsafe of ["/lume.app/x", "../lume.app", "lume.app/../../evil", "lume.app\\x", "./lume", "a\0b"]) {
    assert.throws(() => assertLumeArchiveListing([...LUME_ARCHIVE_MEMBERS, unsafe].join("\n")), /unsafe path/);
  }
});

test("extraction stages only lume.app, never the wrapper script", { skip: process.platform === "win32" }, async (t) => {
  const root = await tempRoot(t, "extract");
  const archive = await writeTarball(root, releaseEntries());
  const staging = path.join(root, "staging");
  await mkdir(staging);
  const app = await extractLumeApp(archive, staging);
  assert.equal(app, path.join(staging, "lume.app"));
  assert.deepEqual(await readdir(staging), ["lume.app"]);
  assert.equal(
    await readFile(path.join(app, "Contents", "MacOS", "lume"), "utf8"),
    "contents of lume.app/Contents/MacOS/lume",
  );
  await assertExactLumeAppTree(app);
});

test("extraction refuses a symlink inside the bundle and unsafe members", { skip: process.platform === "win32" }, async (t) => {
  const root = await tempRoot(t, "unsafe");
  const outside = path.join(root, "outside");
  await writeFile(outside, "not lume");
  const symlinked = path.join(root, "symlinked");
  await mkdir(path.join(symlinked, "staging"), { recursive: true });
  const symlinkArchive = await writeTarball(
    symlinked,
    releaseEntries({
      "lume.app/Contents/MacOS/lume": { name: "lume.app/Contents/MacOS/lume", type: "2", linkName: outside },
    }),
  );
  await assert.rejects(extractLumeApp(symlinkArchive, path.join(symlinked, "staging")), /tree differs/);

  const traversal = path.join(root, "traversal");
  await mkdir(path.join(traversal, "staging"), { recursive: true });
  const traversalArchive = await writeTarball(traversal, [...releaseEntries(), { name: "../escaped", body: "x" }]);
  await assert.rejects(extractLumeApp(traversalArchive, path.join(traversal, "staging")), /unsafe path/);
  assert.equal(existsSync(path.join(root, "escaped")), false);
  assert.deepEqual(await readdir(path.join(traversal, "staging")), []);
});

test("vendored Lume validation checks size and hash before running anything", async (t) => {
  const { app } = await stagedFixtureApp(t, "hash");
  const wrongHash = recordingRunner();
  assert.equal(await validateVendoredLume(app, wrongHash.runner, async () => "0".repeat(64)), false);
  assert.equal(wrongHash.calls.length, 0);

  await truncate(path.join(app, "Contents", "MacOS", "lume"), 1024);
  const wrongSize = recordingRunner();
  let hashed = false;
  assert.equal(
    await validateVendoredLume(app, wrongSize.runner, async () => {
      hashed = true;
      return LUME_ARTIFACT_PROVENANCE.binarySha256;
    }),
    false,
  );
  assert.equal(hashed, false);
  assert.equal(wrongSize.calls.length, 0);
});

test("vendored Lume validation requires the bundle identity, the deep upstream signature and the version", async (t) => {
  const { app } = await stagedFixtureApp(t, "valid");
  const valid = recordingRunner();
  assert.equal(await validateVendoredLume(app, valid.runner, pinnedHash), true);
  assert.deepEqual(
    valid.calls.map((call) => call.command),
    ["/usr/bin/plutil", "/usr/bin/plutil", "/usr/bin/codesign", path.join(app, "Contents", "MacOS", "lume")],
  );
  const codesign = valid.calls[2].args;
  assert.ok(codesign.includes("--deep") && codesign.includes("--strict"));
  assert.ok(codesign.includes(`-R=${lumeRequirement()}`));
  assert.match(lumeRequirement(), /identifier "com\.trycua\.lume"/);
  assert.match(lumeRequirement(), /leaf\[subject\.OU\] = "YCK386LBJ7"/);
  assert.equal(codesign.at(-1), app);

  const versionCall = valid.calls[3];
  assert.deepEqual(versionCall.args, ["--version"]);
  const env = versionCall.options.env;
  assert.equal(env.LUME_TELEMETRY_ENABLED, "false");
  assert.equal(env.LUME_UPDATE_CHECK, "false");
  assert.equal(env.DO_NOT_TRACK, "1");
  assert.notEqual(env.HOME, os.homedir());
  assert.ok(env.HOME.startsWith(os.tmpdir()));
  assert.equal(existsSync(env.HOME), false, "the throwaway HOME is removed after the version check");

  const unsigned = recordingRunner({ codesignFails: true });
  assert.equal(await validateVendoredLume(app, unsigned.runner, pinnedHash), false);
  assert.equal(unsigned.calls.some((call) => call.args[0] === "--version"), false);

  const otherBundle = recordingRunner({ CFBundleIdentifier: "com.example.lume" });
  assert.equal(await validateVendoredLume(app, otherBundle.runner, pinnedHash), false);
  assert.equal(otherBundle.calls.some((call) => call.command === "/usr/bin/codesign"), false);

  const otherVersion = recordingRunner({ version: "0.6.2" });
  assert.equal(await validateVendoredLume(app, otherVersion.runner, pinnedHash), false);
});

test("install keeps the previous bundle when the new one fails final verification", async (t) => {
  const root = await tempRoot(t, "install");
  const destination = path.join(root, "build", "lume.app");
  await mkdir(path.join(destination, "Contents"), { recursive: true });
  await writeFile(path.join(destination, "Contents", "marker"), "previous");
  const staged = path.join(root, "staged.app");
  await mkdir(path.join(staged, "Contents"), { recursive: true });
  await writeFile(path.join(staged, "Contents", "marker"), "new");

  await assert.rejects(installLumeApp(staged, destination, async () => false), /staged lume\.app failed/);
  assert.equal(await readFile(path.join(destination, "Contents", "marker"), "utf8"), "previous");

  let checks = 0;
  await assert.rejects(
    installLumeApp(staged, destination, async () => (checks += 1) === 1),
    /failed final verification/,
  );
  assert.equal(await readFile(path.join(destination, "Contents", "marker"), "utf8"), "previous");
  assert.deepEqual((await readdir(path.dirname(destination))).sort(), ["lume.app"]);

  const replacement = path.join(root, "replacement.app");
  await mkdir(path.join(replacement, "Contents"), { recursive: true });
  await writeFile(path.join(replacement, "Contents", "marker"), "replacement");
  assert.equal(await installLumeApp(replacement, destination, async () => true), destination);
  assert.equal(await readFile(path.join(destination, "Contents", "marker"), "utf8"), "replacement");
  assert.deepEqual(await readdir(path.dirname(destination)), ["lume.app"]);
});

test("vendoring refuses Linux and Intel hosts before any download", async () => {
  const fetchImpl = async () => {
    throw new Error("must not download");
  };
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
  ]) {
    await assert.rejects(vendorLume({ platform, arch, fetchImpl, log: () => {} }), /only on an Apple silicon Mac/);
  }
});

test("vendoring skips the download when the vendored bundle already verifies", async (t) => {
  const { app } = await stagedFixtureApp(t, "skip");
  const { runner } = recordingRunner();
  const logs = [];
  const result = await vendorLume({
    platform: "darwin",
    arch: "arm64",
    destination: app,
    runner,
    hashBinary: pinnedHash,
    fetchImpl: async () => {
      throw new Error("must not download");
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result, app);
  assert.match(logs[0], /already verified/);
});

test("vendoring refuses an archive with the wrong checksum and installs nothing", async (t) => {
  const root = await tempRoot(t, "checksum");
  const tarball = gzipSync(Buffer.concat([...releaseEntries().map(tarEntry), Buffer.alloc(1024)]));
  const destination = path.join(root, "build", "bot-computers", "lume.app");
  const requested = [];
  await assert.rejects(
    vendorLume({
      platform: "darwin",
      arch: "arm64",
      destination,
      runner: recordingRunner().runner,
      hashBinary: pinnedHash,
      fetchImpl: async (url, init) => {
        requested.push({ url, redirect: init.redirect });
        return new Response(tarball, { status: 200, headers: { "content-length": String(tarball.length) } });
      },
      log: () => {},
    }),
    /Lume checksum mismatch/,
  );
  assert.deepEqual(requested, [{ url: LUME_ARTIFACT_PROVENANCE.url, redirect: "follow" }]);
  assert.equal(existsSync(destination), false);
  assert.deepEqual(await readdir(path.dirname(destination)), [], "the staging directory is removed");
});

test("the archive download is capped, private, and never overwrites a file", async (t) => {
  const root = await tempRoot(t, "download");
  const archive = path.join(root, "lume.tar.gz");
  await downloadLumeArchive(archive, {
    maxBytes: 16,
    fetchImpl: async () => new Response(Buffer.from("small archive"), { status: 200 }),
  });
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  await assert.rejects(
    downloadLumeArchive(archive, { fetchImpl: async () => new Response(Buffer.from("again"), { status: 200 }) }),
    /EEXIST/,
  );

  const declared = path.join(root, "declared.tar.gz");
  await assert.rejects(
    downloadLumeArchive(declared, {
      maxBytes: 4,
      fetchImpl: async () => new Response(Buffer.from("too large"), { status: 200, headers: { "content-length": "9" } }),
    }),
    /exceeds 4 bytes/,
  );
  assert.equal(existsSync(declared), false);

  const streamed = path.join(root, "streamed.tar.gz");
  await assert.rejects(
    downloadLumeArchive(streamed, {
      maxBytes: 4,
      fetchImpl: async () => new Response(Buffer.from("too large without a length"), { status: 200 }),
    }),
    /exceeds 4 bytes/,
  );
  await assert.rejects(
    downloadLumeArchive(path.join(root, "missing.tar.gz"), {
      fetchImpl: async () => new Response("gone", { status: 404 }),
    }),
    /HTTP 404/,
  );
});

test("a symlinked lume.app is never treated as the vendored bundle", { skip: process.platform === "win32" }, async (t) => {
  const { root, app } = await stagedFixtureApp(t, "symlink");
  const link = path.join(root, "linked.app");
  await symlink(app, link);
  const { runner, calls } = recordingRunner();
  assert.equal(await validateVendoredLume(link, runner, pinnedHash), false);
  assert.equal(calls.length, 0);
});
