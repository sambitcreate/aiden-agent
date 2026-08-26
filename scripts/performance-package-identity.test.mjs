import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  assertPerformancePackageFileIdentity,
  assertBoundedPerformanceAsarHeader,
  copyIdentityBoundPerformanceFile,
  assertReceiptMatchesPerformancePackage,
  capturePerformancePackageFileIdentity,
  parseEmbeddedPerformanceBuildIdentity,
  verifyPerformanceCodeSignature,
} from "./performance-package-identity.mjs";

const embedded = {
  schemaVersion: 1,
  commit: "abc123",
  dirtyStateHash: "dirty123",
  buildMode: "packaged",
  profilingBuild: true,
};
const identity = {
  ...embedded,
  runtimeNodeVersion: "24.8.0",
  runtimeElectronVersion: "43.1.1",
  runtimePlatform: "darwin",
  runtimeArchitecture: "arm64",
  appAsarSha256: "a".repeat(64),
  executableSha256: "b".repeat(64),
  codeDirectoryHash: "c".repeat(40),
};

test("performance build identity is read only from the immutable bundle marker", () => {
  const marker = Buffer.from(JSON.stringify(embedded), "utf8").toString("base64url");
  assert.deepEqual(
    parseEmbeddedPerformanceBuildIdentity(`/* AIDEN_PERFORMANCE_BUILD_IDENTITY_V1 ${marker} */`),
    embedded,
  );
  assert.throws(() => parseEmbeddedPerformanceBuildIdentity("normal package"), /identity marker/u);
});

test("receipt binding requires the exact profiling package and source identity", () => {
  const receipt = {
    ...embedded,
    nodeVersion: identity.runtimeNodeVersion,
    electronVersion: identity.runtimeElectronVersion,
    platform: identity.runtimePlatform,
    architecture: identity.runtimeArchitecture,
    packageIdentity: identity,
  };
  assert.doesNotThrow(() => assertReceiptMatchesPerformancePackage(receipt, identity));
  assert.throws(
    () =>
      assertReceiptMatchesPerformancePackage(receipt, {
        ...identity,
        appAsarSha256: "d".repeat(64),
      }),
    /exact signed package/u,
  );
  assert.throws(
    () =>
      assertReceiptMatchesPerformancePackage(
        { ...receipt, packageIdentity: { ...identity, profilingBuild: false } },
        { ...identity, profilingBuild: false },
      ),
    /source identity/u,
  );
});

test("signature verification requires strict validation and the designated requirement", () => {
  const calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    if (args.includes("-r-")) {
      return { status: 0, stdout: "", stderr: 'designated => identifier "test.aiden"\n' };
    }
    if (args.includes("--verbose=4")) {
      return { status: 0, stdout: "", stderr: `CDHash=${"a".repeat(40)}\n` };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(verifyPerformanceCodeSignature("/Aiden Agent.app", execute), "a".repeat(40));
  assert.equal(
    calls.every(({ command }) => command === "/usr/bin/codesign"),
    true,
  );
  assert.deepEqual(calls[0].args, [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    "/Aiden Agent.app",
  ]);
  assert.ok(calls.some(({ args }) => args.includes('-R=identifier "test.aiden"')));

  assert.throws(
    () =>
      verifyPerformanceCodeSignature("/Aiden Agent.app", (_command, args) =>
        args.includes("--verify")
          ? { status: 1, stdout: "", stderr: "invalid" }
          : { status: 0, stdout: "", stderr: "" },
      ),
    /strict macOS code signature/u,
  );
  assert.throws(
    () =>
      verifyPerformanceCodeSignature("/Aiden Agent.app", (_command, args) => {
        if (args.includes("-r-")) {
          return { status: 0, stdout: 'designated => identifier "test.aiden"\n', stderr: "" };
        }
        return {
          status: args.some((argument) => argument.startsWith("-R=")) ? 1 : 0,
          stdout: "",
          stderr: args.includes("--verbose=4") ? `CDHash=${"a".repeat(40)}\n` : "",
        };
      }),
    /does not satisfy its designated requirement/u,
  );
});

test("package file identity rejects replacement after admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-package-identity-"));
  const file = path.join(await realpath(root), "app.asar");
  try {
    await writeFile(file, "first");
    const options = { maximumBytes: 64, label: "Test package file" };
    const identity = await capturePerformancePackageFileIdentity(file, options);
    const replacement = path.join(await realpath(root), "replacement.asar");
    await writeFile(replacement, "other");
    await rename(replacement, file);
    await assert.rejects(
      () => assertPerformancePackageFileIdentity(file, identity, options),
      /changed during inspection/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package file admission requires canonical bounded regular executable inputs", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-package-admission-")));
  const file = path.join(root, "Aiden Agent");
  const link = path.join(root, "linked-agent");
  try {
    await writeFile(file, "x".repeat(65));
    await assert.rejects(
      () =>
        capturePerformancePackageFileIdentity(file, {
          maximumBytes: 64,
          label: "Test executable",
        }),
      /bounded regular file/u,
    );
    await writeFile(file, "executable");
    await assert.rejects(
      () =>
        capturePerformancePackageFileIdentity(file, {
          maximumBytes: 64,
          executable: true,
          label: "Test executable",
        }),
      /bounded executable regular file/u,
    );
    await chmod(file, 0o755);
    await symlink(file, link);
    await assert.rejects(
      () =>
        capturePerformancePackageFileIdentity(link, {
          maximumBytes: 64,
          executable: true,
          label: "Test executable",
        }),
      /must not use symlinks/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ASAR admission rejects an oversized pickle header before library parsing", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-asar-header-")));
  const file = path.join(root, "app.asar");
  try {
    const corrupt = Buffer.alloc(8);
    corrupt.writeUInt32LE(4, 0);
    corrupt.writeUInt32LE(0xffffffff, 4);
    await writeFile(file, corrupt);
    const identity = await capturePerformancePackageFileIdentity(file, {
      maximumBytes: 64,
      label: "Test ASAR",
    });
    await assert.rejects(
      () => assertBoundedPerformanceAsarHeader(file, identity),
      /invalid bounded header/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ASAR snapshot copy stays bound to the admitted source pathname", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-asar-copy-")));
  const source = path.join(root, "app.asar");
  const destination = path.join(root, "snapshot.asar");
  const replacement = path.join(root, "replacement.asar");
  try {
    await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 1));
    await writeFile(replacement, Buffer.alloc(2 * 1024 * 1024, 2));
    const sourceIdentity = await capturePerformancePackageFileIdentity(source, {
      maximumBytes: 3 * 1024 * 1024,
      label: "Test ASAR",
    });
    await assert.rejects(
      () =>
        copyIdentityBoundPerformanceFile(source, destination, sourceIdentity, {
          afterFirstChunk: () => rename(replacement, source),
        }),
      /changed/u,
    );
    await assert.rejects(() => realpath(destination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "strict signature verification rejects a signed app after a sealed resource is mutated",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiden-signed-package-"));
    const app = path.join(root, "Aiden Agent.app");
    const contents = path.join(app, "Contents");
    const executable = path.join(contents, "MacOS", "Aiden Agent");
    const resource = path.join(contents, "Resources", "fixture.txt");
    try {
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(
        path.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Aiden Agent</string>
<key>CFBundleIdentifier</key><string>test.aiden.performance</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
      );
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      await mkdir(path.dirname(resource), { recursive: true });
      await writeFile(resource, "sealed");
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
        stdio: "ignore",
      });
      assert.match(verifyPerformanceCodeSignature(app), /^[0-9a-f]{40,64}$/u);
      await writeFile(resource, "mutated");
      assert.throws(() => verifyPerformanceCodeSignature(app), /strict macOS code signature/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
