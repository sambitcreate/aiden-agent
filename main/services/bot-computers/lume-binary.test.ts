import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LUME_PINS, lumeSigningRequirement, resolveLumeInstallation } from "./lume-binary.js";
import { LUME_PRIVACY_ENVIRONMENT } from "./lume-cli.js";
import { BotComputerError } from "./types.js";

interface PackagingPins {
  LUME_ARTIFACT_PROVENANCE: Record<string, string | number>;
  LUME_PRIVACY_ENVIRONMENT: Record<string, string>;
  lumeRequirement(): string;
}

test("the compiled pins, the packaging pins and the provenance JSON agree", async () => {
  const packaging = (await import(path.resolve("scripts/bot-computers-lume-pins.mjs"))) as PackagingPins;
  const provenance = JSON.parse(readFileSync(path.resolve("resources/bot-computers/lume-artifact.json"), "utf8")) as Record<
    string,
    string | number
  >;
  for (const source of [packaging.LUME_ARTIFACT_PROVENANCE, provenance]) {
    assert.equal(source.version, LUME_PINS.version);
    assert.equal(source.tag, LUME_PINS.tag);
    assert.equal(source.bundleIdentifier, LUME_PINS.bundleIdentifier);
    assert.equal(source.bundleVersion, LUME_PINS.bundleVersion);
    assert.equal(source.binarySha256, LUME_PINS.binarySha256);
    assert.equal(source.binaryBytes, LUME_PINS.binaryBytes);
    assert.equal(source.upstreamSigningTeamId, LUME_PINS.upstreamSigningTeamId);
    assert.equal(source.sha256, LUME_PINS.archiveSha256);
  }
  assert.equal(packaging.lumeRequirement(), lumeSigningRequirement());
  assert.deepEqual({ ...packaging.LUME_PRIVACY_ENVIRONMENT }, { ...LUME_PRIVACY_ENVIRONMENT });
});

function bundle(root: string): { appPath: string; binary: string } {
  const app = path.join(root, "build", "bot-computers", "lume.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  const binary = path.join(app, "Contents", "MacOS", "lume");
  writeFileSync(binary, "", { mode: 0o755 });
  truncateSync(binary, LUME_PINS.binaryBytes);
  writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist/>");
  return { appPath: root, binary };
}

function tools(calls: string[][], overrides: { identifier?: string; codesign?: number } = {}) {
  return async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/plutil") {
      const key = args[1];
      return { exitCode: 0, stdout: key === "CFBundleIdentifier" ? (overrides.identifier ?? LUME_PINS.bundleIdentifier) : LUME_PINS.bundleVersion };
    }
    return { exitCode: overrides.codesign ?? 0, stdout: "" };
  };
}

const options = (appPath: string, extra: Partial<Parameters<typeof resolveLumeInstallation>[0]> = {}) => ({
  platform: "darwin" as const,
  arch: "arm64",
  isPackaged: false,
  resourcesPath: "/unused",
  appPath,
  hash: async () => LUME_PINS.binarySha256,
  ...extra,
});

test("the pinned development bundle resolves to its own binary after hash, identity and signature checks", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "p8-lume-binary-"));
  const { appPath } = bundle(root);
  const calls: string[][] = [];
  const installation = await resolveLumeInstallation(options(appPath, { run: tools(calls) }));
  assert.equal(installation.invocation.command, installation.binaryPath);
  assert.equal(path.basename(installation.binaryPath), "lume");
  const codesign = calls.find(([command]) => command === "/usr/bin/codesign");
  assert.ok(codesign?.includes(`-R=${lumeSigningRequirement()}`));
});

test("a symlinked binary, a changed binary, another bundle id or a failed signature is refused", async () => {
  const refused = async (run: Parameters<typeof resolveLumeInstallation>[0]) =>
    assert.rejects(resolveLumeInstallation(run), (error: unknown) => error instanceof BotComputerError);

  const linked = mkdtempSync(path.join(tmpdir(), "p8-lume-link-"));
  const { binary } = bundle(linked);
  const elsewhere = path.join(linked, "elsewhere");
  writeFileSync(elsewhere, "", { mode: 0o755 });
  truncateSync(elsewhere, LUME_PINS.binaryBytes);
  const { rmSync } = await import("node:fs");
  rmSync(binary);
  symlinkSync(elsewhere, binary);
  const calls: string[][] = [];
  await refused(options(linked, { run: tools(calls) }));
  assert.equal(calls.length, 0, "no tool runs on a symlinked binary");

  const changed = mkdtempSync(path.join(tmpdir(), "p8-lume-hash-"));
  bundle(changed);
  const hashCalls: string[][] = [];
  await refused(options(changed, { run: tools(hashCalls), hash: async () => "0".repeat(64) }));
  assert.equal(hashCalls.length, 0, "the hash is checked before any tool runs");

  const other = mkdtempSync(path.join(tmpdir(), "p8-lume-id-"));
  bundle(other);
  await refused(options(other, { run: tools([], { identifier: "com.example.lume" }) }));
  await refused(options(other, { run: tools([], { codesign: 1 }) }));
});

test("Linux and Intel never look for Lume", async () => {
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
  ] as const) {
    const calls: string[][] = [];
    await assert.rejects(
      resolveLumeInstallation({ ...options("/nonexistent", { run: tools(calls) }), platform, arch }),
      (error: unknown) => error instanceof BotComputerError && error.code === "unsupported",
    );
    assert.equal(calls.length, 0);
  }
});

test("the packaged bundle is looked up beside Resources in Contents/Helpers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "p8-lume-packaged-"));
  const contents = path.join(root, "Aiden Agent.app", "Contents");
  mkdirSync(path.join(contents, "Resources"), { recursive: true });
  const app = path.join(contents, "Helpers", "lume.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  const binary = path.join(app, "Contents", "MacOS", "lume");
  writeFileSync(binary, "", { mode: 0o755 });
  truncateSync(binary, LUME_PINS.binaryBytes);
  const installation = await resolveLumeInstallation(
    options("/unused", { isPackaged: true, resourcesPath: path.join(contents, "Resources"), run: tools([]) }),
  );
  assert.ok(installation.appPath.endsWith(path.join("Contents", "Helpers", "lume.app")));
});
