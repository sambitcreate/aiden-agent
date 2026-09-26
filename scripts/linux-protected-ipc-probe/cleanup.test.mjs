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
installation=/fixture/install
runtime=/fixture/run
work=/fixture/work
user=fixture-user
base_installed=true
deny_installed=true
user_created=true
delegation_unit=fixture.service
receiver_pid=12345
record() { printf '%s\\n' "$*" >> "$evidence/steps"; [[ "$1" != "$failure" ]]; }
systemctl() { record stop; }
wait() { record wait; }
rm() { record rm; }
semodule() { record "$2"; }
userdel() { record userdel; }
trap cleanup EXIT
exit "$4"
`;
const expected = ["stop", "wait", "rm", "aiden_ipc_probe_deny", "aiden_ipc_probe", "userdel"];
for (const failure of ["none", ...expected]) {
  test(`cleanup completes all steps when ${failure} fails`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aiden-ipc-cleanup-"));
    try {
      const result = spawnSync("bash", ["-c", shell, "test", cleanup, root, failure, "0"], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
      assert.deepEqual(readFileSync(path.join(root, "steps"), "utf8").trim().split("\n"), expected);
      assert.equal(readFileSync(path.join(root, "cleanup.log"), "utf8"), `exit=${result.status}\n`);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}
