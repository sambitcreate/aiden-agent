import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { inspectLinuxComputerUseHost } from "./linux-computer-use-host-preflight.mjs";

const files = {
  "/etc/os-release": 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=44\n',
  "/sys/kernel/security/lsm": "capability,selinux,landlock,yama,bpf\n",
  "/sys/fs/selinux/enforce": "1\n",
};
const session = { XDG_CURRENT_DESKTOP: "GNOME", XDG_SESSION_TYPE: "wayland" };
function inspect(overrides = {}, env = session) {
  return inspectLinuxComputerUseHost({ platform: "linux", env, readText(path) {
    assert.ok(Object.hasOwn(files, path));
    const value = Object.hasOwn(overrides, path) ? overrides[path] : files[path];
    if (value instanceof Error) throw value;
    return value;
  } });
}
const check = (result, id) => result.checks.find(item => item.id === id);

test("Fedora GNOME enforcing prerequisites never establish acceptance or trust", () => {
  for (const type of ["wayland", "x11"]) {
    const result = inspect({}, { ...session, XDG_CURRENT_DESKTOP: "GNOME:GNOME-Classic", XDG_SESSION_TYPE: type });
    assert.equal(result.prerequisitesMet, true);
    assert.equal(result.scope, "prerequisite-only");
    assert.equal(result.acceptanceEstablished, false);
    assert.equal(result.trustPolicyVerified, false);
    assert.equal(result.computerUseEnabled, false);
    assert.equal(result.sessionEvidence, "untrusted-environment-hints");
  }
});

test("non-Linux skips file reads and fails prerequisites", () => {
  const result = inspectLinuxComputerUseHost({ platform: "darwin", env: session, readText() { assert.fail("must not read Linux files"); } });
  assert.equal(result.prerequisitesMet, false);
  assert.equal(check(result, "linux").passed, false);
});

test("OrbStack LSM list fails even with Fedora userspace and enforcing fixture", () => {
  const result = inspect({ "/sys/kernel/security/lsm": "capability,landlock,yama,bpf\n" });
  assert.equal(result.prerequisitesMet, false);
  assert.equal(check(result, "selinux-kernel").reason, "selinux-not-active");
});

for (const [path, id] of [["/etc/os-release", "fedora"], ["/sys/kernel/security/lsm", "selinux-kernel"], ["/sys/fs/selinux/enforce", "selinux-enforcing"]]) {
  for (const [code, reason] of [["ENOENT", "missing"], ["EACCES", "read-denied"], ["EPERM", "read-denied"], ["EIO", "read-failed"]]) {
    test(`${id} fails closed on ${code} without exposing error text`, () => {
      const result = inspect({ [path]: Object.assign(new Error("SECRET"), { code }) });
      assert.equal(result.prerequisitesMet, false);
      assert.equal(check(result, id).reason, reason);
      assert.doesNotMatch(JSON.stringify(result), /SECRET/u);
    });
  }
  for (const value of ["", "\0", "x".repeat(16_385)]) {
    test(`${id} rejects malformed input length ${value.length}`, () => {
      const result = inspect({ [path]: value });
      assert.equal(result.prerequisitesMet, false);
      assert.equal(check(result, id).reason, "malformed");
    });
  }
}

test("SELinux permissive and malformed enforcement never pass", () => {
  for (const value of ["0\n", "disabled", "2", "1\n0", "true"]) {
    const result = inspect({ "/sys/fs/selinux/enforce": value });
    assert.equal(result.prerequisitesMet, false);
    assert.equal(check(result, "selinux-enforcing").reason, value === "0\n" ? "permissive" : "malformed");
  }
});

test("LSM token parsing rejects substring matches and malformed lists", () => {
  for (const value of ["noselinux", "capability,selinux_fake", "capability,selinux,", "selinux\nbpf"]) {
    assert.equal(inspect({ "/sys/kernel/security/lsm": value }).prerequisitesMet, false);
  }
});

test("Fedora ID must be exact and unique, never shell evaluated", () => {
  for (const value of ["ID=ubuntu\nID_LIKE=fedora", "NAME=Fedora", "ID=fedora\nID=ubuntu", 'ID="$(echo fedora)"', "ID=notfedora"]) {
    assert.equal(inspect({ "/etc/os-release": value }).prerequisitesMet, false);
  }
  for (const value of ['ID="fedora"', "ID='fedora'"]) assert.equal(inspect({ "/etc/os-release": value }).prerequisitesMet, true);
});

test("session environment must report GNOME and a graphical session", () => {
  for (const env of [{}, { ...session, XDG_CURRENT_DESKTOP: "KDE" }, { ...session, XDG_CURRENT_DESKTOP: "notgnome" }, { ...session, XDG_SESSION_TYPE: "tty" }, { ...session, XDG_CURRENT_DESKTOP: "GNOME\nSECRET" }]) {
    assert.equal(inspect({}, env).prerequisitesMet, false);
  }
  const env = new Proxy(session, { get(target, key) {
    assert.ok(["XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"].includes(key));
    return target[key];
  } });
  assert.equal(inspect({}, env).prerequisitesMet, true);
});

test("CLI emits JSON and nonzero for absent session without leaking unrelated environment", () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./linux-computer-use-host-preflight.mjs", import.meta.url))], {
    env: { PATH: process.env.PATH, PRIVATE_TOKEN: "SECRET" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.prerequisitesMet, false);
  assert.equal(result.acceptanceEstablished, false);
  assert.doesNotMatch(child.stdout, /SECRET|PRIVATE_TOKEN/u);
});
