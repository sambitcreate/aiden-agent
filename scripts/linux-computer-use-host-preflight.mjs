/* global process */
import { Buffer } from "node:buffer";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 16_384;
const PATHS = Object.freeze({
  distribution: "/etc/os-release",
  lsm: "/sys/kernel/security/lsm",
  enforcement: "/sys/fs/selinux/enforce",
});

// Fixed local files only: never source os-release, invoke a shell, or query a service.
function readBoundedText(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_BYTES) throw Object.assign(new Error(), { code: "E2BIG" });
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readEvidence(readText, path) {
  try {
    const value = readText(path);
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BYTES || value.includes("\0")) {
      return { error: "malformed" };
    }
    return { value };
  } catch (error) {
    return { error: error?.code === "ENOENT" ? "missing" :
      ["EACCES", "EPERM"].includes(error?.code) ? "read-denied" :
        error?.code === "E2BIG" ? "malformed" : "read-failed" };
  }
}

export function inspectLinuxComputerUseHost({
  platform = process.platform,
  env = process.env,
  readText = readBoundedText,
} = {}) {
  const checks = [];
  const add = (id, passed, reason) => checks.push({ id, passed, reason });
  add("linux", platform === "linux", platform === "linux" ? "linux" : "requires-linux");
  if (platform === "linux") {
    const distribution = readEvidence(readText, PATHS.distribution);
    const ids = distribution.value?.split(/\r?\n/u).filter(line => /^ID\s*=/u.test(line)) ?? [];
    const id = ids.length === 1 ? /^ID=(?:([a-z0-9._-]+)|"([a-z0-9._-]+)"|'([a-z0-9._-]+)')$/u.exec(ids[0]) : null;
    const fedora = id?.slice(1).includes("fedora") === true;
    add("fedora", fedora, distribution.error ?? (!id ? "malformed" : fedora ? "fedora" : "requires-fedora"));

    const lsm = readEvidence(readText, PATHS.lsm);
    const names = lsm.value?.trim();
    const validLsm = typeof names === "string" && /^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/u.test(names);
    const active = validLsm && names.split(",").includes("selinux");
    add("selinux-kernel", active, lsm.error ?? (!validLsm ? "malformed" : active ? "active" : "selinux-not-active"));

    const enforcement = readEvidence(readText, PATHS.enforcement);
    const mode = enforcement.value?.trim();
    add("selinux-enforcing", mode === "1", enforcement.error ?? (mode === "1" ? "enforcing" : mode === "0" ? "permissive" : "malformed"));
  } else {
    for (const id of ["fedora", "selinux-kernel", "selinux-enforcing"]) add(id, false, "requires-linux");
  }

  // Session variables are diagnostic hints, not authenticated compositor evidence.
  // Deliberately inspect only these two keys, and never emit their raw values.
  const desktop = env.XDG_CURRENT_DESKTOP;
  const validDesktop = typeof desktop === "string" && desktop.length <= 256 && /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/u.test(desktop);
  const gnome = validDesktop && desktop.toLowerCase().split(":").includes("gnome");
  add("gnome-session", gnome, gnome ? "environment-reports-gnome" : "requires-gnome-session-environment");
  const sessionType = env.XDG_SESSION_TYPE;
  const graphical = sessionType === "wayland" || sessionType === "x11";
  add("graphical-session", graphical, graphical ? `environment-reports-${sessionType}` : "requires-wayland-or-x11-session-environment");

  return {
    schemaVersion: 1,
    scope: "prerequisite-only",
    prerequisitesMet: checks.every(check => check.passed),
    acceptanceEstablished: false,
    trustPolicyVerified: false,
    computerUseEnabled: false,
    sessionEvidence: "untrusted-environment-hints",
    checks,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = inspectLinuxComputerUseHost();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.prerequisitesMet ? 0 : 1;
}
