import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shouldEnableAppUpdates } from "./app-updater-core.js";
import {
  canUpdateLinuxPackage,
  installLinuxPackageUpdate,
  type CommandResult,
  type LinuxPackageTools,
} from "./app-updater-linux-package.js";

function installFixture(kind: "deb" | "rpm") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "aiden-package-update-")));
  chmodSync(root, 0o755);
  const installDir = path.join(root, "opt", "Aiden Agent");
  const resourcesPath = path.join(installDir, "resources");
  mkdirSync(resourcesPath, { recursive: true, mode: 0o755 });
  for (const dir of [path.join(root, "opt"), installDir, resourcesPath]) chmodSync(dir, 0o755);
  const executablePath = path.join(installDir, "aiden-agent");
  writeFileSync(executablePath, "executable", { mode: 0o755 });
  writeFileSync(path.join(resourcesPath, "app-update.yml"), "provider: github\n");
  writeFileSync(path.join(resourcesPath, "package-type"), kind);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const tools: LinuxPackageTools = {
    pkexec: path.join(bin, "pkexec"),
    aptGet: path.join(bin, "apt-get"),
    dpkgDeb: path.join(bin, "dpkg-deb"),
    dpkgQuery: path.join(bin, "dpkg-query"),
    dnf: path.join(bin, "dnf"),
    rpm: path.join(bin, "rpm"),
  };
  for (const tool of Object.values(tools)) writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
  const dpkgInfoDir = path.join(root, "dpkg-info");
  mkdirSync(dpkgInfoDir);
  writeFileSync(path.join(dpkgInfoDir, "aiden-agent.list"), `/.\n/opt\n${installDir}\n${executablePath}\n`);
  const runtime = {
    resourcesPath,
    executablePath,
    uid: 1000,
    tools,
    dpkgInfoDir,
    systemUid: process.getuid?.() ?? 0,
  };
  return { root, installDir, runtime, tools, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Linux updates turn on for an eligible DEB or RPM install as well as an AppImage", () => {
  const base = { platform: "linux", isPackaged: true, runtimeProfile: "production", updateConfigExists: true } as const;
  assert.equal(shouldEnableAppUpdates({ ...base, linuxPackageEligible: true }), true);
  assert.equal(shouldEnableAppUpdates({ ...base, linuxAppImageEligible: true }), true);
  assert.equal(shouldEnableAppUpdates({ ...base }), false);
  assert.equal(shouldEnableAppUpdates({ ...base, runtimeProfile: "development", linuxPackageEligible: true }), false);
  assert.equal(shouldEnableAppUpdates({ ...base, isPackaged: false, linuxPackageEligible: true }), false);
});

test("a system-owned DEB or RPM install with its package tools can update itself", () => {
  for (const kind of ["deb", "rpm"] as const) {
    const f = installFixture(kind);
    try {
      assert.equal(canUpdateLinuxPackage(f.runtime), kind);
    } finally {
      f.cleanup();
    }
  }
});

test("AppImages, unknown formats, unowned or writable installs and missing tools keep manual updates", () => {
  const f = installFixture("deb");
  try {
    assert.equal(canUpdateLinuxPackage({ ...f.runtime, appImage: "/home/me/Aiden.AppImage" }), null);
    // Installed by someone other than the package manager.
    assert.equal(canUpdateLinuxPackage({ ...f.runtime, systemUid: 4242 }), null);
    // dpkg does not own the running copy.
    writeFileSync(path.join(f.runtime.dpkgInfoDir, "aiden-agent.list"), "/opt/Other/aiden-agent\n");
    assert.equal(canUpdateLinuxPackage(f.runtime), null);
    writeFileSync(path.join(f.runtime.dpkgInfoDir, "aiden-agent.list"), `${f.runtime.executablePath}\n`);
    assert.equal(canUpdateLinuxPackage(f.runtime), "deb");

    // No password prompt available: only root can still install.
    rmSync(f.tools.pkexec);
    assert.equal(canUpdateLinuxPackage(f.runtime), null);
    assert.equal(canUpdateLinuxPackage({ ...f.runtime, uid: 0 }), "deb");
    writeFileSync(f.tools.pkexec, "#!/bin/sh\n", { mode: 0o755 });

    rmSync(f.tools.aptGet);
    assert.equal(canUpdateLinuxPackage(f.runtime), null);
    writeFileSync(f.tools.aptGet, "#!/bin/sh\n", { mode: 0o755 });

    chmodSync(f.installDir, 0o777);
    assert.equal(canUpdateLinuxPackage(f.runtime), null);
    chmodSync(f.installDir, 0o755);

    for (const type of ["appimage", "pacman", "unknown"]) {
      writeFileSync(path.join(f.runtime.resourcesPath, "package-type"), type);
      assert.equal(canUpdateLinuxPackage(f.runtime), null);
    }
    writeFileSync(path.join(f.runtime.resourcesPath, "package-type"), "deb");
    rmSync(path.join(f.runtime.resourcesPath, "app-update.yml"));
    assert.equal(canUpdateLinuxPackage(f.runtime), null);
  } finally {
    f.cleanup();
  }
});

interface FakeSystem {
  packageName?: string;
  packageVersion?: string;
  installExit?: number;
  installedVersion?: string;
}

function fakePackageManager(tools: LinuxPackageTools, system: FakeSystem = {}) {
  const calls: { file: string; args: string[]; staged?: string; stagedExists?: boolean }[] = [];
  const run = async (file: string, args: readonly string[]): Promise<CommandResult> => {
    const staged = args.find((arg) => arg.endsWith(".deb") || arg.endsWith(".rpm"));
    calls.push({ file, args: [...args], staged, stagedExists: staged ? existsSync(staged) : undefined });
    if (file === tools.dpkgDeb || (file === tools.rpm && args[0] === "-qp")) {
      return { code: 0, stdout: `${system.packageName ?? "aiden-agent"}\n${system.packageVersion ?? "0.67.0"}\n`, stderr: "" };
    }
    if (file === tools.dpkgQuery || (file === tools.rpm && args[0] === "-q")) {
      return { code: 0, stdout: system.installedVersion ?? "0.67.0", stderr: "" };
    }
    const exit = system.installExit ?? 0;
    return { code: exit, stdout: "", stderr: exit ? "E: install failed" : "" };
  };
  return { calls, run };
}

function downloadedPackage(root: string, bytes = "package-bytes") {
  const installer = path.join(root, "download.deb");
  writeFileSync(installer, bytes);
  return { installer, sha512: createHash("sha512").update(bytes).digest("base64") };
}

test("a DEB update installs the verified bytes through pkexec and apt-get, then checks the installed version", async () => {
  const f = installFixture("deb");
  try {
    const { installer, sha512 } = downloadedPackage(f.root);
    const pm = fakePackageManager(f.tools);
    const outcome = await installLinuxPackageUpdate({ kind: "deb", installer, sha512, version: "0.67.0", uid: 1000, run: pm.run, tools: f.tools, tmpdir: f.root });
    assert.equal(outcome, "installed");
    const install = pm.calls.find((call) => call.file === f.tools.pkexec);
    assert.ok(install);
    assert.deepEqual(install.args.slice(0, 3), [f.tools.aptGet, "install", "--yes"]);
    // The staged copy, not the user-cache download, is what root installs.
    assert.notEqual(install.staged, installer);
    assert.equal(install.stagedExists, true);
    assert.equal(pm.calls[pm.calls.length - 1]?.file, f.tools.dpkgQuery);
    // The private staging folder is gone afterwards.
    assert.equal(existsSync(path.dirname(install.staged!)), false);
  } finally {
    f.cleanup();
  }
});

test("an RPM update installs with dnf, and root skips the password prompt", async () => {
  const f = installFixture("rpm");
  try {
    const { installer, sha512 } = downloadedPackage(f.root);
    const pm = fakePackageManager(f.tools);
    assert.equal(await installLinuxPackageUpdate({ kind: "rpm", installer, sha512, version: "0.67.0", uid: 0, run: pm.run, tools: f.tools, tmpdir: f.root }), "installed");
    assert.equal(pm.calls.some((call) => call.file === f.tools.pkexec), false);
    const install = pm.calls.find((call) => call.file === f.tools.dnf);
    assert.deepEqual(install?.args.slice(0, 2), ["install", "--assumeyes"]);
  } finally {
    f.cleanup();
  }
});

test("a closed password prompt is a cancel, not a failure", async () => {
  const f = installFixture("deb");
  try {
    const { installer, sha512 } = downloadedPackage(f.root);
    const pm = fakePackageManager(f.tools, { installExit: 126 });
    assert.equal(await installLinuxPackageUpdate({ kind: "deb", installer, sha512, version: "0.67.0", uid: 1000, run: pm.run, tools: f.tools, tmpdir: f.root }), "cancelled");
    assert.equal(pm.calls.some((call) => call.file === f.tools.dpkgQuery), false);
  } finally {
    f.cleanup();
  }
});

test("changed bytes, another package, another version or a failed install never report success", async () => {
  const f = installFixture("deb");
  try {
    const { installer, sha512 } = downloadedPackage(f.root);
    const attempt = async (system: FakeSystem, overrides: { sha512?: string; version?: string } = {}) => {
      const pm = fakePackageManager(f.tools, system);
      const outcome = await installLinuxPackageUpdate({ kind: "deb", installer, sha512: overrides.sha512 ?? sha512, version: overrides.version ?? "0.67.0", uid: 1000, run: pm.run, tools: f.tools, tmpdir: f.root });
      return { outcome, installed: pm.calls.some((call) => call.file === f.tools.pkexec) };
    };
    const otherDigest = createHash("sha512").update("other").digest("base64");
    assert.deepEqual(await attempt({}, { sha512: otherDigest }), { outcome: "failed", installed: false });
    assert.deepEqual(await attempt({ packageName: "evil" }), { outcome: "failed", installed: false });
    assert.deepEqual(await attempt({ packageVersion: "0.66.0" }), { outcome: "failed", installed: false });
    assert.deepEqual(await attempt({}, { version: "0.67.0\nx" }), { outcome: "failed", installed: false });
    assert.deepEqual(await attempt({ installExit: 100 }), { outcome: "failed", installed: true });
    assert.deepEqual(await attempt({ installedVersion: "0.66.0" }), { outcome: "failed", installed: true });
    // The download itself is left for electron-updater to manage.
    assert.equal(readFileSync(installer, "utf8"), "package-bytes");
  } finally {
    f.cleanup();
  }
});
