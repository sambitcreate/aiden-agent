import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
const script = fileURLToPath(new URL('./verify.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./run.sh', import.meta.url));
function fixture(change = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-role-verify-'));
  const context = type => `system_u:system_r:aiden_electron_role_probe_${type}_t:s0`;
  const files = {
    'app.json': { electron: '43.1.1', errors: [], mainPid: 1, mainContext: context('main'), renderer: 'Renderer computed 42', network: 'synthetic-network-ok', worker: { value: 42, pid: 6, context: context('child') }, shell: { status: 0, stdout: context('child') }, command: { status: 0 } },
    'processes.json': { mainPid: 1, rows: ['', '--type=renderer', '--type=zygote', '--type=gpu-process', '--utility-sub-type=network.mojom.NetworkService', '--utility-sub-type=node.mojom.NodeService'].map((cmdline, index) => ({ pid: index + 1, context: context(index ? 'child' : 'main'), uid: '1000 1000 1000 1000', cmdline, exe: '/usr/libexec/aiden-electron-role-probe/electron', seccomp: 2, noNewPrivs: 1 })) },
    'enforcement-before.txt': 'Enforcing\n', 'modules-before.txt': 'unconfined\n', 'negative-status.json': { direct: 126, forged: 126 }, 'direct.txt': 'Permission denied', 'forged.txt': 'Permission denied', 'main-execute-no-trans.txt': '', 'outsider-transition.txt': '',
  };
  const senderContext = context('sender');
  const protectedContext = 'system_u:object_r:aiden_electron_role_probe_protected_t:s0';
  const senders = [];
  for (const role of ['main', 'child']) {
    const receiver = role === 'main' ? files['app.json'] : files['app.json'].worker;
    const pid = role === 'main' ? 1 : 6;
    receiver.ipc = [];
    files[`ipc-${role}-fd-use.txt`] = 'allow creator fd use;';
    for (const channel of ['generic', 'protected']) {
      const denied = role === 'child' && channel === 'protected';
      const label = channel === 'protected' ? protectedContext : senderContext;
      receiver.ipc.push({ channel, pid, uid: 1000, context: context(role), serverPid: 90, serverContext: senderContext, socketContext: denied ? '' : label, receivedFd: !denied, truncated: denied, tokenRead: !denied, ackWritten: !denied, napiVersion: 8 });
      senders.push({ channel, pid: 90, uid: 1000, context: senderContext, peerPid: pid, peerContext: context(role), socketContext: label, roundtrip: !denied, reply: denied ? 'D' : 'A' });
      for (const permission of ['read', 'write']) files[`ipc-${role}-${channel}-${permission}.txt`] = denied ? '' : 'allow socket access;';
    }
  }
  files['ipc-server.jsonl'] = senders.map(row => JSON.stringify(row)).join('\n');
  files['ipc-server-status.txt'] = '0';
  files['ipc-avc.txt'] = `type=AVC avc: denied { read write } for pid=6 scontext=${context('child')} tcontext=${protectedContext} tclass=unix_stream_socket permissive=0`;
  change(files);
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  try { return spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 5000 }).status; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('accepts complete role candidate evidence', () => assert.equal(fixture(), 0));
test('journal evidence uses an absolute epoch independent of host timezone', () => {
  const source = fs.readFileSync(runner, 'utf8');
  assert.match(source, /run_started="@\$\(date \+%s\)"/u);
  assert.doesNotMatch(source, /date -u \+['"]%Y-%m-%d/u);
});
function standaloneNegations(source) {
  return source
    .split('\n')
    .map((line, index) => ({ line: line.replace(/(?:^|\s)#.*$/u, ''), number: index + 1 }))
    .filter(({ line }) => !/^\s*(?:if|elif|while|until)\b/u.test(line))
    .filter(({ line }) => /(?:^|[;&|]+)\s*!(?:\s|\(|$)/u.test(line.replace(/\[\[[^\n]*?\]\]/gu, '[[ ]]').replace(/'[^']*'/gu, "''").replace(/"(?:\\.|[^"\\])*"/gu, '""')))
    .map(({ number }) => number);
}
test('run.sh fails closed on preexisting role modules and avoids standalone ! checks', () => {
  const source = fs.readFileSync(runner, 'utf8');
  assert.deepEqual(standaloneNegations(source), []);
  assert.deepEqual(standaloneNegations(fs.readFileSync(fileURLToPath(new URL('./cleanup.sh', import.meta.url)), 'utf8')), []);
  assert.equal(standaloneNegations('! semodule -l | grep -q aiden_electron_role_probe\n').length, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-role-guard-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(dir, 'os-release'), 'ID=fedora\n');
    fs.writeFileSync(path.join(dir, 'wayland-0'), '');
    for (const [name, body] of [
      ['getenforce', '#!/usr/bin/env bash\necho Enforcing\n'],
      ['id', '#!/usr/bin/env bash\necho 1000\n'],
      ['semodule', '#!/usr/bin/env bash\nif [[ "${MOCK_SEMODULE_EXIT:-0}" != "0" ]]; then exit "$MOCK_SEMODULE_EXIT"; fi\nprintf "%b" "${MOCK_SEMODULE_OUTPUT:-}"\n'],
    ]) {
      const target = path.join(bin, name);
      fs.writeFileSync(target, body, { mode: 0o755 });
    }
    const cutoff = source.indexOf('\npayload=/var/tmp/aiden-electron43/dist\n');
    assert.notEqual(cutoff, -1);
    const guardScript = source
      .slice(0, cutoff)
      .replace('export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C', 'export PATH="$TEST_BIN:$PATH" LC_ALL=C')
      .replace('$EUID -eq 0', '${TEST_EUID:-0} -eq 0')
      .replace('/etc/os-release', '"$TEST_ROOT/os-release"')
      .replace('-S /run/user/1000/wayland-0', '-e "$TEST_ROOT/wayland-0"')
      .replaceAll('/usr/libexec/', '$TEST_ROOT/libexec/')
      .replaceAll('/var/tmp/', '$TEST_ROOT/var-tmp/')
      .replaceAll('/etc/systemd/system/', '$TEST_ROOT/systemd/')
      .replaceAll('/run/', '$TEST_ROOT/run/');
    const harness = path.join(dir, 'guard.sh');
    fs.writeFileSync(harness, `${guardScript}\n`, { mode: 0o755 });
    const runGuard = (env) => spawnSync('bash', [harness, path.join(dir, 'evidence')], {
      encoding: 'utf8',
      env: { ...process.env, TEST_BIN: bin, TEST_ROOT: dir, ...env },
    });

    assert.equal(runGuard({ MOCK_SEMODULE_OUTPUT: 'unconfined\naiden_electron_role_probe_other\n' }).status, 0);
    for (const mod of ['aiden_electron_role_probe', 'aiden_electron_role_probe\t1.0.0', 'aiden_electron_role_probe_deny']) {
      const res = runGuard({ MOCK_SEMODULE_OUTPUT: `unconfined\n${mod}\n` });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /aiden_electron_role_probe policy module already loaded/u);
    }
    assert.equal(runGuard({ MOCK_SEMODULE_EXIT: '2' }).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
for (const [name, mutate] of [
  ['missing modules-before receipt', f => delete f['modules-before.txt']],
  ['preexisting base role module', f => f['modules-before.txt'] = 'unconfined\naiden_electron_role_probe\n'],
  ['preexisting versioned base role module', f => f['modules-before.txt'] = 'unconfined\naiden_electron_role_probe\t1.0.0\n'],
  ['preexisting deny role module', f => f['modules-before.txt'] = 'unconfined\naiden_electron_role_probe_deny\n'],
  ['main protected token missing', f => f['app.json'].ipc[1].tokenRead = false],
  ['child protected descriptor received', f => f['app.json'].worker.ipc[1].receivedFd = true],
  ['child protected CTRUNC absent', f => f['app.json'].worker.ipc[1].truncated = false],
  ['child generic ACK missing', f => f['app.json'].worker.ipc[0].ackWritten = false],
  ['coarse creator-fd denial', f => f['ipc-child-fd-use.txt'] = ''],
  ['surviving protected socket permission', f => f['ipc-child-protected-read.txt'] = 'allow;'],
  ['native receiver PID mismatch', f => f['app.json'].worker.ipc[1].pid = 55],
  ['native receiver context mismatch', f => f['app.json'].worker.ipc[1].context = f['app.json'].ipc[1].context],
  ['missing socket AVC', f => f['ipc-avc.txt'] = ''],
  ['wrong AVC PID', f => f['ipc-avc.txt'] = f['ipc-avc.txt'].replace('pid=6 ', 'pid=66 ')],
  ['permissive AVC', f => f['ipc-avc.txt'] = f['ipc-avc.txt'].replace('permissive=0', 'permissive=1')],
  ['wrong AVC class', f => f['ipc-avc.txt'] = f['ipc-avc.txt'].replace('tclass=unix_stream_socket ', 'tclass=fd ')],
  ['different FD creator', f => f['ipc-server.jsonl'] = f['ipc-server.jsonl'].replace('"pid":90', '"pid":91')],
  ['wrong socket object label', f => f['app.json'].ipc[1].socketContext = f['app.json'].ipc[0].socketContext],
  ['server failed', f => f['ipc-server-status.txt'] = '78'],
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
