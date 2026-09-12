import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
const script = fileURLToPath(new URL('./verify.mjs', import.meta.url));
function fixture(change = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-role-verify-'));
  const context = type => `system_u:system_r:aiden_electron_role_probe_${type}_t:s0`;
  const files = {
    'app.json': { electron: '43.1.1', errors: [], mainPid: 1, mainContext: context('main'), renderer: 'Renderer computed 42', network: 'synthetic-network-ok', worker: { value: 42, pid: 6, context: context('child') }, shell: { status: 0, stdout: context('child') }, command: { status: 0 } },
    'processes.json': { mainPid: 1, rows: ['', '--type=renderer', '--type=zygote', '--type=gpu-process', '--utility-sub-type=network.mojom.NetworkService', '--utility-sub-type=node.mojom.NodeService'].map((cmdline, index) => ({ pid: index + 1, context: context(index ? 'child' : 'main'), uid: '1000 1000 1000 1000', cmdline, exe: '/usr/libexec/aiden-electron-role-probe/electron', seccomp: 2, noNewPrivs: 1 })) },
    'enforcement-before.txt': 'Enforcing\n', 'negative-status.json': { direct: 126, forged: 126 }, 'direct.txt': 'Permission denied', 'forged.txt': 'Permission denied', 'main-execute-no-trans.txt': '', 'outsider-transition.txt': '',
  };
  change(files);
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  try { return spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 5000 }).status; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('accepts complete role candidate evidence', () => assert.equal(fixture(), 0));
for (const [name, mutate] of [
  ['non-enforcing receipt', f => f['enforcement-before.txt'] = 'Permissive'],
  ['wrong effective UID', f => f['processes.json'].rows[0].uid = '1000 0 1000 1000'],
  ['main row absent', f => f['processes.json'].rows.shift()],
  ['worker PID mismatch', f => f['app.json'].worker.pid = 77],
  ['renderer remains main', f => f['processes.json'].rows[1].context = f['processes.json'].rows[0].context],
  ['zygote missing', f => f['processes.json'].rows.splice(2, 1)],
  ['renderer seccomp disabled', f => f['processes.json'].rows[1].seccomp = 0],
  ['renderer NNP disabled', f => f['processes.json'].rows[1].noNewPrivs = 0],
  ['sandbox command line disabled', f => f['processes.json'].rows[0].cmdline += ' --no-sandbox'],
  ['direct attack timeout', f => f['negative-status.json'].direct = 124],
  ['forged attack spawn error', f => f['negative-status.json'].forged = 127],
  ['unexpected direct success', f => f['negative-status.json'].direct = 0],
  ['remaining main execute permission', f => f['main-execute-no-trans.txt'] = 'allow main file:file execute_no_trans;'],
  ['remaining main entry', f => f['outsider-transition.txt'] = 'allow outsider main:process transition;'],
  ['shell retains main', f => f['app.json'].shell.stdout = f['app.json'].mainContext],
  ['incorrect executable', f => f['processes.json'].rows[1].exe = '/tmp/imposter'],
  ['renderer work absent', f => f['app.json'].renderer = 'failed'],
]) test(`rejects ${name}`, () => assert.notEqual(fixture(mutate), 0));
