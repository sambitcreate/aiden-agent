import assert from "node:assert/strict";
import test from "node:test";
import { verifyEvidence } from "./verify.mjs";
function fixture() {
  const files = {"enforcement.txt": "Enforcing"};
  let pid = 100;
  for (const phase of ["before", "after", "restored"]) {
    files[`${phase}-fd-use.txt`] = "allow unconfined_t aiden_ipc_sender_t:fd use;";
    for (const channel of ["generic", "protected"]) {
      const denied = phase === "after" && channel === "protected";
      for (const permission of ["read", "write"]) files[`${phase}-${channel}-${permission}.txt`] = denied ? "" : `allow unconfined_t socket_type:unix_stream_socket ${permission};`;
      const sender = {channel, uid: 981, pid: pid++, context: "system_u:system_r:aiden_ipc_sender_t:s0", socketContext: channel === "protected" ? "system_u:object_r:aiden_ipc_protected_socket_t:s0" : "system_u:system_r:aiden_ipc_sender_t:s0", roundtrip: !denied, receiverReply: denied ? "D" : "A"};
      const receiver = {channel, uid: 981, pid: pid++, context: "unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023", receivedFd: !denied, truncated: denied, tokenRead: !denied, ackWritten: !denied, errno: 0};
      files[`${phase}-${channel}-sender.json`] = JSON.stringify(sender);
      files[`${phase}-${channel}-receiver.json`] = JSON.stringify(receiver);
      if (denied) files["avc.txt"] = `type=AVC avc: denied { read write } for pid=${receiver.pid} scontext=${receiver.context} tcontext=system_u:object_r:aiden_ipc_protected_socket_t:s0 tclass=unix_stream_socket permissive=0`;
    }
  }
  return files;
}
const reader = files => name => { assert.ok(Object.hasOwn(files, name), `Missing ${name}`); return files[name]; };
const alter = (files, name, changes) => { files[name] = JSON.stringify({...JSON.parse(files[name]), ...changes}); };
test("typed socket denial preserves generic bidirectional IPC and creator fd use", () => {
  const result = verifyEvidence(reader(fixture()), true);
  assert.equal(result.genericRoundtripWithOverlay, true);
  assert.equal(result.restored, true);
  assert.equal(result.computerUseEnabled, false);
  assert.equal(result.inheritedPipeOrElectronRoleProof, false);
});
test("coarse fd deny, surviving protected allow or lost generic allow cannot substitute", () => {
  for (const [name, value] of [["after-fd-use.txt", ""], ["after-generic-read.txt", ""], ["after-generic-write.txt", ""], ["after-protected-read.txt", "allow survived;"], ["after-protected-write.txt", "allow survived;"]]) {
    const files = fixture(); files[name] = value;
    assert.throws(() => verifyEvidence(reader(files)));
  }
});
test("baseline, restoration and hardened generic channels require both read and write", () => {
  for (const phase of ["before", "after", "restored"]) {
    const files = fixture(); alter(files, `${phase}-generic-receiver.json`, {ackWritten: false});
    assert.throws(() => verifyEvidence(reader(files), true));
  }
  const files = fixture(); alter(files, "before-protected-receiver.json", {tokenRead: false});
  assert.throws(() => verifyEvidence(reader(files)));
});
test("wrong UID, role, creator or socket label invalidates evidence", () => {
  for (const [name, changes] of [["after-protected-receiver.json", {uid: 0}], ["after-protected-receiver.json", {context: "system_u:system_r:aiden_ipc_sender_t:s0"}], ["after-protected-sender.json", {context: "system_u:system_r:other_t:s0"}], ["after-protected-sender.json", {socketContext: "system_u:system_r:aiden_ipc_sender_t:s0"}]]) {
    const files = fixture(); alter(files, name, changes);
    assert.throws(() => verifyEvidence(reader(files)));
  }
});
test("denial must actually omit descriptor with CTRUNC and preserve receiver completion", () => {
  for (const changes of [{receivedFd: true}, {truncated: false}, {errno: 13}, {tokenRead: true}, {ackWritten: true}]) {
    const files = fixture(); alter(files, "after-protected-receiver.json", changes);
    assert.throws(() => verifyEvidence(reader(files)));
  }
});
test("absent, stale, permissive, wrong target or fd-class AVC fails", () => {
  for (const transform of [() => "", s => s.replace("pid=", "pid=9"), s => s.replace("permissive=0", "permissive=1"), s => s.replace("aiden_ipc_protected_socket_t", "aiden_ipc_sender_t"), s => s.replace("tclass=unix_stream_socket", "tclass=fd"), s => s.replace("scontext=unconfined_u", "scontext=system_u")]) {
    const files = fixture(); files["avc.txt"] = transform(files["avc.txt"]);
    assert.throws(() => verifyEvidence(reader(files)), /socket-object AVC/u);
  }
});
