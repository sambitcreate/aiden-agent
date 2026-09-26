import assert from 'node:assert/strict';
export function verifyIpc(read, app) {
  const type = role => `aiden_electron_role_probe_${role}_t`;
  const senderContext = `system_u:system_r:${type('sender')}:s0`;
  const protectedContext = `system_u:object_r:${type('protected')}:s0`;
  const rows = read('ipc-server.jsonl').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.pid)).size, 1, 'one creator must serve all four cells');
  assert.equal(read('ipc-server-status.txt').trim(), '0');
  for (const role of ['main', 'child']) {
    const receiver = role === 'main' ? app : app.worker;
    const pid = role === 'main' ? app.mainPid : app.worker.pid;
    assert.equal(receiver.ipc.length, 2);
    assert.ok(read(`ipc-${role}-fd-use.txt`).trim(), 'creator fd use must survive');
    for (const channel of ['generic', 'protected']) {
      const denied = role === 'child' && channel === 'protected';
      const cell = receiver.ipc.filter(value => value.channel === channel);
      assert.equal(cell.length, 1);
      const result = cell[0];
      const senders = rows.filter(row => row.peerPid === pid && row.channel === channel);
      assert.equal(senders.length, 1);
      const sender = senders[0];
      for (const permission of ['read', 'write']) {
        const allow = read(`ipc-${role}-${channel}-${permission}.txt`).trim();
        if (denied) assert.equal(allow, '', 'protected child socket access must be absent');
        else assert.ok(allow, 'positive socket permission must survive');
      }
      assert.equal(result.pid, pid);
      assert.equal(result.uid, 1000);
      assert.equal(result.context, `system_u:system_r:${type(role)}:s0`);
      assert.equal(result.napiVersion, 8);
      assert.equal(sender.pid, result.serverPid);
      assert.equal(sender.uid, 1000);
      assert.equal(sender.context, senderContext);
      assert.equal(sender.peerContext, result.context);
      assert.equal(result.serverContext, senderContext);
      const label = channel === 'protected' ? protectedContext : senderContext;
      assert.equal(sender.socketContext, label);
      assert.equal(result.receivedFd, !denied);
      assert.equal(result.truncated, denied);
      assert.equal(result.tokenRead, !denied);
      assert.equal(result.ackWritten, !denied);
      assert.equal(sender.roundtrip, !denied);
      assert.equal(sender.reply, denied ? 'D' : 'A');
      assert.equal(result.socketContext, denied ? '' : label);
      if (denied) {
        assert.ok(read('ipc-avc.txt').split('\n').some(line =>
          /denied\s+\{\s*(?:read\s+write|write\s+read|read|write)\s*\}/u.test(line) &&
          line.includes(` pid=${pid} `) && line.includes(`scontext=${result.context} `) &&
          line.includes(`tcontext=${protectedContext} `) && line.includes('tclass=unix_stream_socket ') &&
          line.includes('permissive=0')), 'exact Node utility enforcing socket-object AVC required');
      }
    }
  }
  return { actualElectronMainProtectedRoundtrip: true, actualNodeUtilityProtectedFdOmitted: true,
    genericRoundtripBothRoles: true, sameFdCreator: true, creatorFdUseRetained: true };
}
