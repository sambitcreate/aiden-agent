import assert from "node:assert/strict";
import test from "node:test";
import { verifyEvidence } from "./verify.mjs";

function fixture() {
  const files = {
    "enforcement.txt": "Enforcing\n",
    "attacker-context.txt": "unconfined_u:unconfined_r:unconfined_t:s0",
    "holder-context.txt": "system_u:system_r:aiden_boundary_probe_t:s0",
    "hardened-holder-check.txt": "native-context-check-before-socket\n",
    "entry-attempts.json": JSON.stringify({ direct: 126, runcon: 126 }),
    "after-transition-allow.txt": "allow init_t aiden_boundary_probe_t:process transition;\n",
    "after-dyntransition-allow.txt": "",
    "runcon.txt": "runcon: holder: Permission denied\n",
  };
  const avcs = [];
  for (const [i, operation] of ["file", "proc", "socket"].entries()) {
    files[`before-${operation}.json`] = JSON.stringify({ success: true, uid: 981, errno: 0, pid: 100 + i });
    files[`after-${operation}.json`] = JSON.stringify({ success: false, uid: 981, errno: 13, pid: 200 + i });
    files[`restored-${operation}.json`] = files[`before-${operation}.json`];
    files[`before-${operation}-allow.txt`] = "allow stock_attribute fixture_target:file read;\n";
    files[`after-${operation}-allow.txt`] = "";
    avcs.push(`type=AVC avc: denied { ${operation === "socket" ? "connectto" : "read"} } for pid=${200 + i} comm="attacker" scontext=unconfined_u:unconfined_r:unconfined_t:s0 tcontext=system_u:object_r:${operation === "file" ? "aiden_boundary_probe_data_t" : "aiden_boundary_probe_t"}:s0 tclass=${operation === "socket" ? "unix_stream_socket" : "file"} permissive=0`);
  }
  files["before-fd-allow.txt"] = "allow unconfined_domain_type domain:fd use;";
  files["after-fd-allow.txt"] = "";
  for (const [i, operation] of ["scm", "inherited"].entries()) {
    const context = operation === "scm" ? "unconfined_u:unconfined_r:unconfined_t:s0" : "system_u:system_r:unconfined_t:s0";
    files[`before-${operation}.json`] = JSON.stringify({ operation, success: true, stage: "read", truncated: false, uid: 981, pid: 300+i, errno: 0, context });
    files[`restored-${operation}.json`] = files[`before-${operation}.json`];
    files[`after-${operation}.json`] = JSON.stringify({ operation, success: false, stage: operation === "scm" ? "receive-no-fd" : "read", truncated: operation === "scm", uid: 981, pid: 400+i, errno: operation === "scm" ? 0 : 13, context });
    avcs.push(`type=AVC avc: denied { use } for pid=${400+i} path="/run/aiden-selinux-boundary-probe/private.txt" scontext=${context} tcontext=system_u:system_r:aiden_boundary_probe_t:s0 tclass=fd permissive=0`);
  }
  files["avc.txt"] = avcs.join("\n");
  for (const operation of ["proc-fd", "ptrace", "pidfd"]) {
    for (const phase of ["before", "after"]) files[`${phase}-${operation}.json`] = JSON.stringify({ success: false, errno: 1, uid: 981 });
  }
  return files;
}
const reader = files => name => {
  assert.ok(Object.hasOwn(files, name), `Missing evidence ${name}`);
  return files[name];
};
test("baseline, effective policy, matching AVC and positive launch establish only scoped proof", () => {
  const result = verifyEvidence(reader(fixture()));
  assert.equal(result.results.length, 3);
  assert.equal(result.computerUseEnabled, false);
  assert.equal(result.releaseIdentityEstablished, false);
  assert.ok(result.ancillary.every(item => item.conclusion === "not-proven-baseline-denied"));
});
test("denied baseline cannot be counted as successful enforcement", () => {
  const files = fixture(); files["before-file.json"] = JSON.stringify({ success: false });
  assert.throws(() => verifyEvidence(reader(files)), /successful baseline/u);
});
test("surviving effective allow fails even when the syscall was denied", () => {
  const files = fixture(); files["after-file-allow.txt"] = "allow unconfined_t aiden_boundary_probe_data_t:file read;";
  assert.throws(() => verifyEvidence(reader(files)), /effective allow survived/u);
});
test("missing, unrelated, permissive or stale-PID AVCs fail", () => {
  for (const alter of [() => "", value => value.replaceAll("pid=", "pid=9"), value => value.replaceAll("permissive=0", "permissive=1"), value => value.replaceAll("aiden_boundary_probe_data_t", "other_t")]) {
    const files = fixture(); files["avc.txt"] = alter(files["avc.txt"]);
    assert.throws(() => verifyEvidence(reader(files)), /matching fixture AVC/u);
  }
});
test("timeout and an extra transition source fail the entrypoint proof", () => {
  const files = fixture(); files["entry-attempts.json"] = JSON.stringify({ direct: 124, runcon: 1 });
  assert.throws(() => verifyEvidence(reader(files)));
  const extra = fixture(); extra["after-transition-allow.txt"] += "allow unconfined_t aiden_boundary_probe_t:process transition;\n";
  assert.throws(() => verifyEvidence(reader(extra)));
});
test("restoration requires all original operations to succeed again", () => {
  const files = fixture(); assert.equal(verifyEvidence(reader(files), true).restored, true);
  files["restored-file.json"] = JSON.stringify({ success: false });
  assert.throws(() => verifyEvidence(reader(files), true));
});
test("proc audit suppression stays explicit and needs installed dontaudit evidence", () => {
  const files = fixture(); files["avc.txt"] = files["avc.txt"].split("\n").filter(line => !line.includes("pid=201 ")).join("\n");
  assert.throws(() => verifyEvidence(reader(files)), /Missing evidence/u);
  files["after-proc-dontaudit.txt"] = "dontaudit unconfined_usertype domain:file { open read };\n";
  const result = verifyEvidence(reader(files));
  assert.equal(result.results.find(item => item.operation === "proc").audit, "not-observed-stock-dontaudit-applies");
});
test("root or a different UID cannot substitute for same-UID negative evidence", () => {
  for (const uid of [0, 1234]) {
    const files = fixture(); files["after-file.json"] = JSON.stringify({ success: false, uid, errno: 13, pid: 200 });
    assert.throws(() => verifyEvidence(reader(files)));
  }
});

test("delegation needs successful baseline, actual unconfined child, and valid syscall outcome", () => {
  for (const [operation, change] of [["scm", {success: true}], ["scm", {truncated: false}], ["inherited", {context: "system_u:system_r:aiden_boundary_probe_t:s0"}], ["inherited", {errno: 9}], ["inherited", {uid: 0}]]) {
    const files = fixture(), name = `after-${operation}.json`;
    files[name] = JSON.stringify({...JSON.parse(files[name]), ...change});
    assert.throws(() => verifyEvidence(reader(files)));
  }
  const files = fixture(); files["before-inherited.json"] = JSON.stringify({...JSON.parse(files["before-inherited.json"]), success: false});
  assert.throws(() => verifyEvidence(reader(files)), /token-read baseline/u);
});
test("delegation requires exact receiver, private file, source context and effective fd subtraction", () => {
  for (const [oldText, newText] of [["pid=400 ", "pid=999 "], ['path="/run/aiden-selinux-boundary-probe/private.txt"', 'path="/other"'], ["scontext=system_u:system_r:unconfined_t:s0", "scontext=system_u:system_r:other_t:s0"]]) {
    const files = fixture(); files["avc.txt"] = files["avc.txt"].replaceAll(oldText, newText);
    assert.throws(() => verifyEvidence(reader(files)), /exact receiver private-FD use AVC/u);
  }
  const files = fixture(); files["after-fd-allow.txt"] = "allow domain domain:fd use;";
  assert.throws(() => verifyEvidence(reader(files)), /fd use allow survived/u);
});
