import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export function verifyEvidence(read, restored = false) {
  assert.equal(read("enforcement.txt").trim(), "Enforcing");
  const json = name => JSON.parse(read(`${name}.json`));
  const phases = restored ? ["before", "after", "restored"] : ["before", "after"];
  let uid;
  for (const phase of phases) {
    assert.ok(read(`${phase}-fd-use.txt`).trim(), `${phase} must retain creator fd use`);
    for (const channel of ["generic", "protected"]) {
      const denied = phase === "after" && channel === "protected";
      for (const permission of ["read", "write"]) {
        const allow = read(`${phase}-${channel}-${permission}.txt`).trim();
        if (denied) assert.equal(allow, "", `protected ${permission} allow survived`);
        else assert.ok(allow, `${phase} ${channel} ${permission} needs effective allow`);
      }
      const sender = json(`${phase}-${channel}-sender`), receiver = json(`${phase}-${channel}-receiver`);
      uid ??= sender.uid;
      assert.ok(Number.isInteger(uid) && uid > 0);
      for (const receipt of [sender, receiver]) {
        assert.equal(receipt.channel, channel);
        assert.equal(receipt.uid, uid);
        assert.ok(Number.isInteger(receipt.pid) && receipt.pid > 1);
      }
      assert.equal(sender.context, "system_u:system_r:aiden_ipc_sender_t:s0");
      assert.match(receiver.context, /^unconfined_u:unconfined_r:unconfined_t:/u);
      assert.equal(sender.socketContext, channel === "protected" ? "system_u:object_r:aiden_ipc_protected_socket_t:s0" : sender.context);
      assert.equal(sender.roundtrip, !denied);
      assert.equal(sender.receiverReply, denied ? "D" : "A");
      assert.equal(receiver.receivedFd, !denied);
      assert.equal(receiver.truncated, denied);
      assert.equal(receiver.tokenRead, !denied);
      assert.equal(receiver.ackWritten, !denied);
      assert.equal(receiver.errno, 0);
      if (denied) {
        const matching = read("avc.txt").split("\n").some(line => /denied\s+\{\s*(?:read\s+write|write\s+read|read|write)\s*\}/u.test(line) && line.includes(` pid=${receiver.pid} `) && line.includes(`scontext=${receiver.context} `) && line.includes("tcontext=system_u:object_r:aiden_ipc_protected_socket_t:s0 ") && line.includes("tclass=unix_stream_socket ") && line.includes("permissive=0"));
        assert.ok(matching, "protected denial requires exact receiver enforcing socket-object AVC");
      }
    }
  }
  return { scope: "synthetic-typed-SCM_RIGHTS-socketpair", genericRoundtripWithOverlay: true, creatorFdUseRetained: true, protectedEndpointOmitted: true, protectedSocketObjectAvc: true, restored, releaseIdentityEstablished: false, computerUseEnabled: false, inheritedPipeOrElectronRoleProof: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--restored")) throw new Error("Usage: node verify.mjs <evidence-directory> [--restored]");
  process.stdout.write(`${JSON.stringify(verifyEvidence(name => readFileSync(path.join(process.argv[2], name), "utf8"), process.argv[3] === "--restored"), null, 2)}\n`);
}
