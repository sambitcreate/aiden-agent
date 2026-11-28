import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
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

function standaloneNegations(source) {
  return source
    .split("\n")
    .map((line, index) => ({ line: line.replace(/(?:^|\s)#.*$/u, ""), number: index + 1 }))
    .filter(({ line }) => !/^\s*(?:if|elif|while|until)\b/u.test(line))
    .filter(({ line }) => /(?:^|[;&|]+)\s*!(?:\s|\(|$)/u.test(line.replace(/\[\[[^\n]*?\]\]/gu, "[[ ]]").replace(/'[^']*'/gu, "''").replace(/"(?:\\.|[^"\\])*"/gu, '""')))
    .map(({ number }) => number);
}

test("run.sh rejects existing fixture users, loaded probe modules, and standalone ! checks", () => {
  const runner = fileURLToPath(new URL("./run.sh", import.meta.url));
  const cleanup = fileURLToPath(new URL("./cleanup.sh", import.meta.url));
  const source = fs.readFileSync(runner, "utf8");
  assert.deepEqual(standaloneNegations(source), []);
  assert.deepEqual(standaloneNegations(fs.readFileSync(cleanup, "utf8")), []);
  assert.equal(standaloneNegations('! getent passwd "$user" >/dev/null\n').length, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-probe-guard-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(dir, "os-release"), "ID=fedora\n");
    for (const [name, body] of [
      ["getenforce", "#!/usr/bin/env bash\necho Enforcing\n"],
      ["getent", '#!/usr/bin/env bash\nif [[ "${MOCK_USER_EXISTS:-0}" == "1" ]]; then echo "aiden-protected-ipc-probe:x:981:981::/:/sbin/nologin"; exit 0; fi\nexit 2\n'],
      ["semodule", '#!/usr/bin/env bash\nif [[ "${MOCK_SEMODULE_EXIT:-0}" != "0" ]]; then exit "$MOCK_SEMODULE_EXIT"; fi\nprintf "%b" "${MOCK_SEMODULE_OUTPUT:-}"\n'],
    ]) {
      fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    }
    const cutoff = source.indexOf('\nmkdir -m 700 -- "$evidence"\n');
    assert.notEqual(cutoff, -1);
    const guardScript = source
      .slice(0, cutoff)
      .replace("export PATH=/usr/sbin:/usr/bin:/sbin:/bin", 'export PATH="$TEST_BIN:$PATH"')
      .replace('"$EUID" -eq 0', '"${TEST_EUID:-0}" -eq 0')
      .replace("/etc/os-release", '"$TEST_ROOT/os-release"')
      .replaceAll("/usr/libexec/", "$TEST_ROOT/libexec/")
      .replaceAll("/run/", "$TEST_ROOT/run/");
    const harness = path.join(dir, "guard.sh");
    fs.writeFileSync(harness, `${guardScript}\n`, { mode: 0o755 });
    const runGuard = (env) => spawnSync("bash", [harness, path.join(dir, "evidence")], {
      encoding: "utf8",
      env: { ...process.env, TEST_BIN: bin, TEST_ROOT: dir, ...env },
    });

    assert.equal(runGuard({ MOCK_SEMODULE_OUTPUT: "unconfined\naiden_ipc_probe_other\n" }).status, 0);

    const existingUser = runGuard({ MOCK_USER_EXISTS: "1", MOCK_SEMODULE_OUTPUT: "unconfined\n" });
    assert.equal(existingUser.status, 1);
    assert.match(existingUser.stderr, /fixture user aiden-protected-ipc-probe already exists/u);

    for (const mod of ["aiden_ipc_probe", "aiden_ipc_probe\t1.0.0", "aiden_ipc_probe_deny"]) {
      const loaded = runGuard({ MOCK_SEMODULE_OUTPUT: `unconfined\n${mod}\n` });
      assert.equal(loaded.status, 1);
      assert.match(loaded.stderr, /aiden_ipc_probe policy module already loaded/u);
    }

    assert.equal(runGuard({ MOCK_SEMODULE_EXIT: "2" }).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
