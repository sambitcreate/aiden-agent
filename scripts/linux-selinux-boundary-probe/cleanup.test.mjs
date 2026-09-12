import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const cleanup = fileURLToPath(new URL("./cleanup.sh", import.meta.url));
const shell = `
set -euo pipefail
source "$1"
evidence="$2"
failure="$3"
unit=fixture.service
installation=/fixture/install
runtime=/fixture/run
work=/fixture/work
user=fixture-user
base_installed=true
deny_installed=true
user_created=true
record() { printf '%s\\n' "$*" >> "$evidence/steps"; [[ "$1" != "$failure" ]]; }
systemctl() { record "systemctl-$1"; }
rm() { record "rm-$1"; }
semodule() { record "semodule-$2"; }
userdel() { record userdel; }
trap cleanup EXIT
exit "$4"
`;
const expected = ["systemctl-stop", "rm--f", "systemctl-daemon-reload", "rm--rf", "semodule-aiden_boundary_probe_deny", "semodule-aiden_boundary_probe", "userdel"];
for (const failure of ["none", ...expected]) {
  test(`cleanup attempts every step when ${failure} fails`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aiden-cleanup-test-"));
    try {
      const result = spawnSync("bash", ["-c", shell, "cleanup-test", cleanup, root, failure, "0"], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
      assert.deepEqual(readFileSync(path.join(root, "steps"), "utf8").trim().split("\n"), expected);
      assert.equal(readFileSync(path.join(root, "cleanup.log"), "utf8"), `exit=${result.status}\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test("successful cleanup preserves an unsuccessful experiment exit", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-cleanup-test-"));
  try {
    const result = spawnSync("bash", ["-c", shell, "cleanup-test", cleanup, root, "none", "7"], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 7);
    assert.match(readFileSync(path.join(root, "cleanup.log"), "utf8"), /exit=7/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const failure of ["none", "receiver-wait", "systemctl-stop"]) {
  test(`delegation cleanup reaps receiver and continues when ${failure} fails`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aiden-cleanup-delegation-test-"));
    try {
      const active = shell.replace("trap cleanup EXIT", 'delegation_unit=delegation-fixture.service\nreceiver_pid=12345\nwait() { record receiver-wait; }\ntrap cleanup EXIT');
      const result = spawnSync("bash", ["-c", active, "cleanup-test", cleanup, root, failure, "0"], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
      assert.deepEqual(readFileSync(path.join(root, "steps"), "utf8").trim().split("\n"), ["systemctl-stop", "receiver-wait", ...expected]);
      assert.equal(readFileSync(path.join(root, "cleanup.log"), "utf8"), `exit=${result.status}\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
