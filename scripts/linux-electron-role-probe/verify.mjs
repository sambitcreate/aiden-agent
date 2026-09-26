import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { verifyIpc } from './verify-ipc.mjs';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
const app = JSON.parse(read('app.json'));
const processes = JSON.parse(read('processes.json'));
const negative = JSON.parse(read('negative-status.json'));
assert.equal(read('enforcement-before.txt').trim(), 'Enforcing');
assert.equal(app.electron, '43.1.1');
assert.match(app.mainContext, /:aiden_electron_role_probe_main_t:/);
assert.deepEqual(app.errors, []);
assert.equal(app.renderer, 'Renderer computed 42');
assert.equal(app.network, 'synthetic-network-ok');
assert.equal(app.worker.value, 42);
assert.match(app.worker.context, /:aiden_electron_role_probe_child_t:/);
assert.equal(app.shell.status, 0);
assert.match(app.shell.stdout, /:aiden_electron_role_probe_child_t:/);
assert.equal(app.command.status, 0);
assert.equal(app.mainPid, processes.mainPid);
assert.ok(processes.rows.length >= 6);
assert.equal(processes.rows.filter(row => row.pid === processes.mainPid).length, 1);
const workerRow = processes.rows.find(row => row.pid === app.worker.pid);
assert.ok(workerRow, 'worker absent from root observation');
assert.match(workerRow.cmdline, /--utility-sub-type=node\.mojom\.NodeService/);
assert.match(workerRow.context, /:aiden_electron_role_probe_child_t:/);
for (const row of processes.rows) {
  assert.match(row.context, row.pid === processes.mainPid ? /:aiden_electron_role_probe_main_t:/ : /:aiden_electron_role_probe_child_t:/);
  assert.deepEqual(row.uid.split(/\s+/), ['1000', '1000', '1000', '1000']);
  assert.ok(!row.cmdline.includes('--no-sandbox'));

}
for (const type of ['--type=renderer', '--type=zygote', '--type=gpu-process', '--utility-sub-type=network.mojom.NetworkService', '--utility-sub-type=node.mojom.NodeService']) {
  assert.ok(processes.rows.some(row => row.cmdline.includes(type) && row.exe === '/usr/libexec/aiden-electron-role-probe/electron'), `missing observed ${type}`);
}
for (const row of processes.rows.filter(row => row.cmdline.includes('--type=renderer'))) {
  assert.equal(row.seccomp, 2);
  assert.equal(row.noNewPrivs, 1);
}
assert.equal(negative.direct, 126);
assert.equal(negative.forged, 126);
assert.match(read('direct.txt'), /Permission denied/);
assert.match(read('forged.txt'), /Permission denied/);
assert.equal(read('main-execute-no-trans.txt').trim(), '');
assert.equal(read('outsider-transition.txt').trim(), '');
const ipc = verifyIpc(read, app);
const result = { ipc, scope: 'role-boundary-candidate', passed: true, computerUseEnabled: false,
  firstInstructionIdentityEstablished: false, immutablePayloadEstablished: false,
  jitConstrained: false, descriptorAuthorityEstablished: false, descendantSnapshot: processes.rows.length };
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
