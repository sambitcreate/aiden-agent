import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  mkdirSync(path.join(installDir, "Helpers"), { mode: 0o755 });
  chmodSync(path.join(installDir, "Helpers"), 0o755);
  const helper = path.join(installDir, "Helpers", "aiden-package-install");
  writeFileSync(helper, "#!/bin/sh\n", { mode: 0o755 });
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
  return { root, installDir, helper, runtime, tools, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
    writeFileSync(path.join(f.runtime.resourcesPath, "app-update.yml"), "provider: github\n");
    assert.equal(canUpdateLinuxPackage(f.runtime), "deb");

    // Root runs the helper, so the person must not be able to change it.
    chmodSync(f.helper, 0o775);
    assert.equal(canUpdateLinuxPackage(f.runtime), null);
    rmSync(f.helper);
    assert.equal(canUpdateLinuxPackage(f.runtime), null);
  } finally {
    f.cleanup();
  }
});

interface FakeSystem {
  helperExit?: number;
  installedVersion?: string;
}

function fakeHelperRun(tools: LinuxPackageTools, system: FakeSystem = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const run = async (file: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push({ file, args: [...args] });
    if (file === tools.dpkgQuery || file === tools.rpm) {
      return { code: 0, stdout: system.installedVersion ?? "0.67.0", stderr: "" };
    }
    const exit = system.helperExit ?? 0;
    return { code: exit, stdout: "", stderr: exit ? "E: install failed" : "" };
  };
  return { calls, run };
}

const BYTES = "package-bytes";
const SHA512 = createHash("sha512").update(BYTES).digest("base64");
const SHA512_HEX = createHash("sha512").update(BYTES).digest("hex");

test("an update hands root's helper the download, the feed digest and the version through pkexec", async () => {
  const f = installFixture("deb");
  try {
    const installer = path.join(f.root, "download.deb");
    const pm = fakeHelperRun(f.tools);
    const outcome = await installLinuxPackageUpdate({ kind: "deb", helper: f.helper, installer, sha512: SHA512, version: "0.67.0", uid: 1000, run: pm.run, tools: f.tools });
    assert.equal(outcome, "installed");
    assert.deepEqual(pm.calls[0], { file: f.tools.pkexec, args: [f.helper, "deb", installer, SHA512_HEX, "0.67.0"] });
    assert.deepEqual(pm.calls[1], { file: f.tools.dpkgQuery, args: ["--showformat=${Version}", "--show", "aiden-agent"] });
  } finally {
    f.cleanup();
  }
});

test("root runs the helper directly, and RPM reads its version back with rpm", async () => {
  const f = installFixture("rpm");
  try {
    const pm = fakeHelperRun(f.tools);
    const installer = path.join(f.root, "download.rpm");
    assert.equal(await installLinuxPackageUpdate({ kind: "rpm", helper: f.helper, installer, sha512: SHA512, version: "0.67.0", uid: 0, run: pm.run, tools: f.tools }), "installed");
    assert.deepEqual(pm.calls[0], { file: f.helper, args: ["rpm", installer, SHA512_HEX, "0.67.0"] });
    assert.equal(pm.calls[1]?.file, f.tools.rpm);
  } finally {
    f.cleanup();
  }
});

test("a closed password prompt is a cancel; a refused package, a failed install or a wrong version is a failure", async () => {
  const f = installFixture("deb");
  try {
    const installer = path.join(f.root, "download.deb");
    const attempt = async (system: FakeSystem, overrides: { sha512?: string; version?: string; installer?: string } = {}) => {
      const pm = fakeHelperRun(f.tools, system);
      const outcome = await installLinuxPackageUpdate({ kind: "deb", helper: f.helper, installer: overrides.installer ?? installer, sha512: overrides.sha512 ?? SHA512, version: overrides.version ?? "0.67.0", uid: 1000, run: pm.run, tools: f.tools });
      return { outcome, ran: pm.calls.length };
    };
    assert.deepEqual(await attempt({ helperExit: 126 }), { outcome: "cancelled", ran: 1 });
    assert.deepEqual(await attempt({ helperExit: 3 }), { outcome: "failed", ran: 1 });
    assert.deepEqual(await attempt({ helperExit: 100 }), { outcome: "failed", ran: 1 });
    assert.deepEqual(await attempt({ installedVersion: "0.66.0" }), { outcome: "failed", ran: 2 });
    // Malformed inputs never reach pkexec.
    assert.deepEqual(await attempt({}, { version: "0.67.0\nx" }), { outcome: "failed", ran: 0 });
    assert.deepEqual(await attempt({}, { sha512: "not-a-digest" }), { outcome: "failed", ran: 0 });
    assert.deepEqual(await attempt({}, { installer: "relative.deb" }), { outcome: "failed", ran: 0 });
  } finally {
    f.cleanup();
  }
});

const HELPER_SOURCE = new URL("../../scripts/aiden-package-install.sh", import.meta.url);

/**
 * The real helper, with its fixed PATH pointed at fake package tools first.
 * The fake dpkg-deb tampers with the person's download after root copied it,
 * the way a same-user process could; the fake apt-get records what it got.
 */
function helperHarness() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "aiden-package-helper-")));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const log = path.join(root, "install.log");
  const helper = path.join(root, "aiden-package-install");
  writeFileSync(helper, readFileSync(HELPER_SOURCE, "utf8").replace(/^PATH=/mu, `PATH=${bin}:`), { mode: 0o755 });
  writeFileSync(path.join(bin, "dpkg-deb"), `#!/bin/sh
printf 'tampered' > "$FAKE_SOURCE"
printf '%s' "\${FAKE_IDENTITY:-aiden-agent 0.67.0}"
`, { mode: 0o755 });
  writeFileSync(path.join(bin, "apt-get"), `#!/bin/sh
printf '%s\\n%s\\n%s\\n' "$3" "$(sha512sum -- "$3" | cut -d ' ' -f 1)" "$(stat -c %a -- "$(dirname -- "$3")")" > "${log}"
`, { mode: 0o755 });
  const download = path.join(root, "download.deb");
  writeFileSync(download, BYTES);
  const runHelper = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(helper, args, { encoding: "utf8", env: { ...process.env, FAKE_SOURCE: download, ...env } });
  return { root, log, download, runHelper, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("root's helper installs only the copy it verified, even if the download changes afterwards", { skip: process.platform !== "linux" }, () => {
  const h = helperHarness();
  try {
    const result = h.runHelper(["deb", h.download, SHA512_HEX, "0.67.0"]);
    assert.equal(result.status, 0, result.stderr);
    const [installedPath, installedDigest, folderMode] = readFileSync(h.log, "utf8").trim().split("\n");
    // The download was tampered with after the copy; apt-get still got the verified bytes.
    assert.equal(readFileSync(h.download, "utf8"), "tampered");
    assert.notEqual(installedPath, h.download);
    assert.equal(installedDigest, SHA512_HEX);
    assert.equal(folderMode, "700");
    // The private copy is removed once the install finishes.
    assert.equal(existsSync(path.dirname(installedPath!)), false);
  } finally {
    h.cleanup();
  }
});

test("root's helper refuses changed bytes, another package or version, and malformed arguments", { skip: process.platform !== "linux" }, () => {
  const h = helperHarness();
  try {
    writeFileSync(h.download, "changed before root copied it");
    assert.equal(h.runHelper(["deb", h.download, SHA512_HEX, "0.67.0"]).status, 3);
    writeFileSync(h.download, BYTES);
    assert.equal(h.runHelper(["deb", h.download, SHA512_HEX, "0.67.0"], { FAKE_IDENTITY: "evil 0.67.0" }).status, 3);
    writeFileSync(h.download, BYTES);
    assert.equal(h.runHelper(["deb", h.download, SHA512_HEX, "0.67.0"], { FAKE_IDENTITY: "aiden-agent 0.66.0" }).status, 3);
    assert.equal(existsSync(h.log), false, "apt-get never ran");
    writeFileSync(h.download, BYTES);
    assert.equal(h.runHelper(["pacman", h.download, SHA512_HEX, "0.67.0"]).status, 2);
    assert.equal(h.runHelper(["deb", "download.deb", SHA512_HEX, "0.67.0"]).status, 2);
    assert.equal(h.runHelper(["deb", h.download, SHA512, "0.67.0"]).status, 2);
    assert.equal(h.runHelper(["deb", h.download, SHA512_HEX, "0.67.0; rm -rf /"]).status, 2);
    assert.equal(h.runHelper(["deb", h.download, SHA512_HEX]).status, 2);
    assert.equal(existsSync(h.log), false, "apt-get never ran");
  } finally {
    h.cleanup();
  }
});
