import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
const cleanup = fileURLToPath(new URL('./cleanup.sh', import.meta.url));
for (const failure of ['', 'stop', 'processes', 'rm', 'reload', 'deny', 'base']) {
  test(`cleanup completes all steps after ${failure || 'no'} failure`, () => {
    const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-role-cleanup-'));
    const result = spawnSync('bash', ['-c', `
set -eu
source "$1"
evidence="$2"; failure="$3"; unit=test; unit_created=true
source_dir=/unused; installation=/unused; runtime=/unused; work=/unused
base_installed=true; deny_installed=true
record() { printf '%s\\n' "$1" >>"$evidence/calls"; [[ "$1" != "$failure" ]]; }
systemctl() { if [[ "$1" == stop ]]; then record stop; else record reload; fi; }
python3() { record processes; }
rm() { record rm; }
semodule() { if [[ "$1" == -l ]]; then record list; elif [[ "$2" == *_deny ]]; then record deny; else record base; fi; }
getenforce() { printf 'Enforcing\\n'; }
cleanup
`, 'test', cleanup, evidence, failure], { encoding: 'utf8' });
    try {
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      assert.deepEqual(fs.readFileSync(path.join(evidence, 'calls'), 'utf8').trim().split('\n'), ['stop', 'processes', 'rm', 'reload', 'rm', 'deny', 'base', 'list']);
      assert.equal(fs.readFileSync(path.join(evidence, 'cleanup-status.txt'), 'utf8').trim(), failure ? '1' : '0');
    } finally { fs.rmSync(evidence, { recursive: true, force: true }); }
  });
}
