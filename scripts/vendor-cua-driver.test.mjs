/* global Buffer, process, setTimeout, URL */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  assertArchiveListing,
  buildBrokerApp,
  extractDriverMember,
  runBoundedCommand,
  sigstoreBundleArchiveDigest,
  validateArtifact,
  validateVendoredBinary,
  verifySigstoreBundle,
} from "./vendor-cua-driver.mjs";
import {
  CUA_DRIVER_ARTIFACT_KEYS,
  CUA_DRIVER_ARTIFACT_PROVENANCE,
  CUA_DRIVER_SHA256,
} from "./computer-use-signing-pins.mjs";

const PINNED_VERSION = CUA_DRIVER_ARTIFACT_PROVENANCE.version;
const RELEASE_MEMBERS = [
  "cua-driver",
  "cua-cursor-theme",
  "libcua_driver_sdk.dylib",
  "cua_driver_node_runtime.node",
  "cua_driver_abi.h",
];

// Minimal ustar writer so fixtures can carry entries a well-behaved tar
// refuses to create (absolute paths, `..`, symlinks named cua-driver).
function tarEntry({ name, body = "", type = "0", linkName = "" }) {
  const header = Buffer.alloc(512);
  const content = Buffer.from(body, "utf8");
  const field = (value, offset, length) => header.write(value, offset, length, "utf8");
  const octal = (value, offset, length) =>
    field(value.toString(8).padStart(length - 1, "0"), offset, length - 1);
  field(name, 0, 100);
  octal(0o755, 100, 8);
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

async function writeTarball(root, entries) {
  const archive = path.join(root, "release.tar.gz");
  const tar = Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]);
  await writeFile(archive, gzipSync(tar));
  return archive;
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} did not exit.`);
}

async function waitForPidFile(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process id was not written to ${file}.`);
}

test("broker app gives a cold Cargo release build a dedicated bounded timeout", async () => {
  const stoppedAfterCargoCall = new Error("stop after observing Cargo");
  let invocation;

  await assert.rejects(
    buildBrokerApp(async (command, args, options) => {
      invocation = { command, args, options };
      throw stoppedAfterCargoCall;
    }),
    (error) => error === stoppedAfterCargoCall,
  );

  assert.ok(invocation);
  assert.equal(invocation.args[0], "build");
  assert.ok(invocation.args.includes("--locked"));
  assert.ok(invocation.args.includes("--release"));
  assert.equal(invocation.options.timeoutMs, 10 * 60_000);
  assert.match(invocation.options.cwd, /native\/computer-use-broker$/);
});

test("checked-in cua-driver provenance exactly matches the compiled pins", async () => {
  const checkedIn = JSON.parse(
    await readFile(
      new URL("../resources/computer-use/cua-driver-artifact.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(validateArtifact(checkedIn), CUA_DRIVER_ARTIFACT_PROVENANCE);
  assert.deepEqual(checkedIn, CUA_DRIVER_ARTIFACT_PROVENANCE);
});

test("artifact validation rejects missing and additional provenance keys", () => {
  const missing = { ...CUA_DRIVER_ARTIFACT_PROVENANCE };
  delete missing.releaseChannel;
  assert.throws(() => validateArtifact(missing), /provenance keys differ/);
  assert.throws(
    () => validateArtifact({ ...CUA_DRIVER_ARTIFACT_PROVENANCE, unexpected: true }),
    /provenance keys differ/,
  );
});

test("artifact validation rejects drift in every compiled provenance field", async (t) => {
  for (const field of CUA_DRIVER_ARTIFACT_KEYS) {
    await t.test(field, () => {
      const expected = CUA_DRIVER_ARTIFACT_PROVENANCE[field];
      const drifted = {
        ...CUA_DRIVER_ARTIFACT_PROVENANCE,
        [field]: typeof expected === "number" ? expected + 1 : `${expected}-drifted`,
      };
      assert.throws(() => validateArtifact(drifted), new RegExp(`field '${field}'`));
    });
  }
});

test("cached cua-driver validation checks the binary hash before executing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-hash-"));
  const binary = path.join(root, "cua-driver");
  try {
    await writeFile(binary, "#!/bin/sh\necho fake\n", "utf8");
    await chmod(binary, 0o755);
    let runnerCalls = 0;
    assert.equal(
      await validateVendoredBinary(binary, async () => {
        runnerCalls += 1;
        return JSON.stringify({
          schema_version: "1",
          binary_version: PINNED_VERSION,
        });
      }),
      false,
    );
    assert.equal(runnerCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cached cua-driver validation checks the pinned signing identity before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-signature-"));
  const binary = path.join(root, "cua-driver");
  try {
    await writeFile(binary, "not actually signed", "utf8");
    await chmod(binary, 0o755);
    const commands = [];
    assert.equal(
      await validateVendoredBinary(
        binary,
        async (command) => {
          commands.push(command);
          throw new Error("signature mismatch");
        },
        async () => CUA_DRIVER_SHA256,
      ),
      false,
    );
    assert.deepEqual(commands, ["/usr/bin/codesign"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cached cua-driver validation requires both signature and manifest pins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-valid-"));
  const binary = path.join(root, "cua-driver");
  try {
    await writeFile(binary, "simulated pinned binary", "utf8");
    await chmod(binary, 0o755);
    const commands = [];
    assert.equal(
      await validateVendoredBinary(
        binary,
        async (command, args) => {
          commands.push({ command, args });
          if (command === "/usr/bin/codesign") return "";
          return JSON.stringify({
            schema_version: "1",
            binary_version: PINNED_VERSION,
          });
        },
        async () => CUA_DRIVER_SHA256,
      ),
      true,
    );
    assert.equal(commands[0].command, "/usr/bin/codesign");
    assert.match(commands[0].args.join(" "), /identifier "cua-driver"/);
    assert.match(commands[0].args.join(" "), /YCK386LBJ7/);
    assert.equal(commands[1].command, binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cached cua-driver validation rejects a manifest from another release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-manifest-"));
  const binary = path.join(root, "cua-driver");
  try {
    await writeFile(binary, "simulated pinned binary", "utf8");
    for (const manifest of [
      { schema_version: "1", binary_version: "0.8.3" },
      { schema_version: "2", binary_version: PINNED_VERSION },
      { schema_version: 1, binary_version: PINNED_VERSION },
    ]) {
      assert.equal(
        await validateVendoredBinary(
          binary,
          async (command) => (command === "/usr/bin/codesign" ? "" : JSON.stringify(manifest)),
          async () => CUA_DRIVER_SHA256,
        ),
        false,
        JSON.stringify(manifest),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive listing accepts the five-member release and requires one top-level driver", () => {
  assert.deepEqual(assertArchiveListing(`${RELEASE_MEMBERS.join("\n")}\n`), RELEASE_MEMBERS);
  for (const listing of [
    RELEASE_MEMBERS.slice(1).join("\n"),
    ["bin/cua-driver", ...RELEASE_MEMBERS.slice(1)].join("\n"),
    [...RELEASE_MEMBERS, "cua-driver"].join("\n"),
  ]) {
    assert.throws(() => assertArchiveListing(listing), /exactly one top-level cua-driver/);
  }
  for (const unsafe of ["/cua-driver", "../cua-driver", "lib/../../evil", "a\\..\\b"]) {
    assert.throws(
      () => assertArchiveListing([...RELEASE_MEMBERS, unsafe].join("\n")),
      /unsafe path/,
    );
  }
});

test(
  "driver extraction stages only cua-driver from the release tarball",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-extract-"));
    try {
      const archive = await writeTarball(
        root,
        RELEASE_MEMBERS.map((name) => ({ name, body: `contents of ${name}` })),
      );
      const staging = path.join(root, "staging");
      await mkdir(staging);
      const extracted = await extractDriverMember(archive, staging);
      assert.equal(extracted, path.join(staging, "cua-driver"));
      assert.deepEqual(await readdir(staging), ["cua-driver"]);
      assert.equal(await readFile(extracted, "utf8"), "contents of cua-driver");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "driver extraction refuses a symlinked driver and traversal entries before staging them",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-unsafe-"));
    try {
      const outside = path.join(root, "outside");
      await writeFile(outside, "not the driver", "utf8");
      const cases = [
        {
          entries: [{ name: "cua-driver", type: "2", linkName: outside }],
          message: /not a regular file/,
        },
        {
          entries: [
            { name: "cua-driver", body: "driver" },
            { name: "../escaped", body: "x" },
          ],
          message: /unsafe path/,
        },
        {
          entries: [
            { name: "cua-driver", body: "driver" },
            { name: "/tmp/absolute", body: "x" },
          ],
          message: /unsafe path/,
        },
      ];
      for (const [index, { entries, message }] of cases.entries()) {
        const caseRoot = path.join(root, `case-${index}`);
        const staging = path.join(caseRoot, "staging");
        await mkdir(staging, { recursive: true });
        const archive = await writeTarball(caseRoot, entries);
        await assert.rejects(extractDriverMember(archive, staging), message);
      }
      assert.deepEqual(await readdir(path.join(root, "case-1", "staging")), []);
      assert.equal(await readFile(outside, "utf8"), "not the driver");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

function cosignBundle(archiveSha256, { kind = "hashedrekord", algorithm = "sha256" } = {}) {
  const body = {
    apiVersion: "0.0.1",
    kind,
    spec: { data: { hash: { algorithm, value: archiveSha256 } } },
  };
  return {
    base64Signature: "",
    cert: "",
    rekorBundle: {
      SignedEntryTimestamp: "",
      Payload: { body: Buffer.from(JSON.stringify(body)).toString("base64") },
    },
  };
}

test("Sigstore bundle digest extraction reads only a SHA-256 hashedrekord entry", () => {
  const digest = CUA_DRIVER_ARTIFACT_PROVENANCE.sha256;
  assert.equal(sigstoreBundleArchiveDigest(cosignBundle(digest)), digest);
  assert.throws(() => sigstoreBundleArchiveDigest({}), /no Rekor entry/);
  assert.throws(
    () => sigstoreBundleArchiveDigest(cosignBundle(digest, { kind: "intoto" })),
    /hashedrekord/,
  );
  assert.throws(
    () => sigstoreBundleArchiveDigest(cosignBundle(digest, { algorithm: "sha1" })),
    /hashedrekord/,
  );
  assert.throws(
    () => sigstoreBundleArchiveDigest(cosignBundle("not-hex")),
    /invalid archive digest/,
  );
});

test("optional Sigstore verification rejects an unpinned bundle before running cosign", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-sigstore-"));
  try {
    const bundle = path.join(root, "bundle.sigstore.json");
    await writeFile(bundle, JSON.stringify(cosignBundle(CUA_DRIVER_ARTIFACT_PROVENANCE.sha256)));
    const commands = [];
    await assert.rejects(
      verifySigstoreBundle(path.join(root, "archive.tar.gz"), bundle, async (command) => {
        commands.push(command);
        return "";
      }),
      /Sigstore bundle checksum mismatch/,
    );
    assert.deepEqual(commands, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "bounded vendor commands kill descendants that retain an exited leader's stdio",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-tree-"));
    const descendantPidPath = path.join(root, "descendant.pid");
    const descendantSource = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', process.argv[1]], {",
      "  stdio: ['ignore', 'inherit', 'inherit']",
      "});",
      "writeFileSync(process.argv[2], String(descendant.pid));",
      "descendant.unref();",
    ].join("");
    try {
      const startedAt = Date.now();
      await assert.rejects(
        runBoundedCommand(
          process.execPath,
          ["-e", leaderSource, descendantSource, descendantPidPath],
          { timeoutMs: 250, terminateGraceMs: 100, killGraceMs: 100 },
        ),
        /timed out/,
      );
      assert.ok(Date.now() - startedAt < 1_500, "the bounded runner should settle promptly");
      const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
      await waitForProcessExit(descendantPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "bounded vendor commands kill ignored-stdio descendants after successful completion",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-success-tree-"));
    const descendantPidPath = path.join(root, "descendant.pid");
    const descendantSource = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', process.argv[1]], {",
      "  stdio: ['ignore', 'ignore', 'ignore']",
      "});",
      "writeFileSync(process.argv[2], String(descendant.pid));",
      "descendant.unref();",
    ].join("");
    let descendantPid;
    try {
      await runBoundedCommand(
        process.execPath,
        ["-e", leaderSource, descendantSource, descendantPidPath],
        { timeoutMs: 2_000, terminateGraceMs: 100, killGraceMs: 500 },
      );
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
      await waitForProcessExit(descendantPid);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Successful release normally reaps the complete occupied group.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "bounded vendor command guard retains its group lease after its owner crashes",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-owner-"));
    const descendantPidPath = path.join(root, "descendant.pid");
    const runnerPath = path.join(root, "runner.mjs");
    const descendantSource = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "const descendant = spawn(process.execPath, ['-e', process.argv[1]], {",
      "  stdio: ['ignore', 'ignore', 'ignore']",
      "});",
      "writeFileSync(process.argv[2], String(descendant.pid));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const runnerSource = [
      `import { runBoundedCommand } from ${JSON.stringify(new URL("./vendor-cua-driver.mjs", import.meta.url).href)};`,
      `await runBoundedCommand(process.execPath, ${JSON.stringify(["-e", leaderSource, descendantSource, descendantPidPath])}, { timeoutMs: 60_000, terminateGraceMs: 100, killGraceMs: 500 });`,
    ].join("\n");
    let runner;
    let descendantPid;
    try {
      await writeFile(runnerPath, runnerSource, "utf8");
      runner = spawn(process.execPath, [runnerPath], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      descendantPid = await waitForPidFile(descendantPidPath);
      process.kill(runner.pid, "SIGKILL");
      await waitForProcessExit(runner.pid);
      await waitForProcessExit(descendantPid);
    } finally {
      if (runner?.pid) {
        try {
          process.kill(runner.pid, "SIGKILL");
        } catch {
          // The runner normally exited after the deliberate owner-crash step.
        }
      }
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The occupied guard normally reaped the descendant process group.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
