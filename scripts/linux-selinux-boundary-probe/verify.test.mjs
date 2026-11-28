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

function standaloneNegations(source) {
  return source
    .split("\n")
    .map((line, index) => ({ line: line.replace(/(?:^|\s)#.*$/u, ""), number: index + 1 }))
    .filter(({ line }) => !/^\s*(?:if|elif|while|until)\b/u.test(line))
    .filter(({ line }) => /(?:^|[;&|]+)\s*!(?:\s|\(|$)/u.test(line.replace(/\[\[[^\n]*?\]\]/gu, "[[ ]]").replace(/'[^']*'/gu, "''").replace(/"(?:\\.|[^"\\])*"/gu, '""')))
    .map(({ number }) => number);
}

test("run.sh rejects existing users, loaded modules, invalid runcon contexts, and standalone ! checks", () => {
  const runner = fileURLToPath(new URL("./run.sh", import.meta.url));
  const cleanup = fileURLToPath(new URL("./cleanup.sh", import.meta.url));
  const source = fs.readFileSync(runner, "utf8");
  assert.deepEqual(standaloneNegations(source), []);
  assert.deepEqual(standaloneNegations(fs.readFileSync(cleanup, "utf8")), []);
  assert.equal(standaloneNegations("! grep -q 'invalid context' \"$evidence/runcon.txt\"\n").length, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-probe-guard-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(dir, "os-release"), "ID=fedora\n");
    for (const [name, body] of [
      ["getenforce", "#!/usr/bin/env bash\necho Enforcing\n"],
      ["getent", '#!/usr/bin/env bash\nif [[ "${MOCK_USER_EXISTS:-0}" == "1" ]]; then echo "aiden-boundary-probe:x:981:981::/:/sbin/nologin"; exit 0; fi\nexit 2\n'],
      ["semodule", '#!/usr/bin/env bash\nif [[ "${MOCK_SEMODULE_EXIT:-0}" != "0" ]]; then exit "$MOCK_SEMODULE_EXIT"; fi\nprintf "%b" "${MOCK_SEMODULE_OUTPUT:-}"\n'],
      ["runuser", '#!/usr/bin/env bash\nif [[ "$*" == *"runcon"* ]]; then printf "%s\\n" "${MOCK_RUNCON_OUTPUT:-}"; exit "${MOCK_RUNCON_STATUS:-126}"; fi\nexit "${MOCK_DIRECT_STATUS:-126}"\n'],
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
      .replaceAll("/etc/systemd/system/", "$TEST_ROOT/systemd/")
      .replaceAll("/run/", "$TEST_ROOT/run/");
    const harness = path.join(dir, "guard.sh");
    fs.writeFileSync(harness, `${guardScript}\n`, { mode: 0o755 });
    const runGuard = (env) => spawnSync("bash", [harness, path.join(dir, "evidence")], {
      encoding: "utf8",
      env: { ...process.env, TEST_BIN: bin, TEST_ROOT: dir, ...env },
    });

    assert.equal(runGuard({ MOCK_SEMODULE_OUTPUT: "unconfined\naiden_boundary_probe_other\n" }).status, 0);

    const existingUser = runGuard({ MOCK_USER_EXISTS: "1", MOCK_SEMODULE_OUTPUT: "unconfined\n" });
    assert.equal(existingUser.status, 1);
    assert.match(existingUser.stderr, /fixture user aiden-boundary-probe already exists/u);

    for (const mod of ["aiden_boundary_probe", "aiden_boundary_probe\t1.0.0", "aiden_boundary_probe_deny"]) {
      const loaded = runGuard({ MOCK_SEMODULE_OUTPUT: `unconfined\n${mod}\n` });
      assert.equal(loaded.status, 1);
      assert.match(loaded.stderr, /aiden_boundary_probe policy module already loaded/u);
    }

    assert.equal(runGuard({ MOCK_SEMODULE_EXIT: "2" }).status, 2);

    const entryStart = source.indexOf("\nset +e\nrunuser -u \"$user\" -- timeout --kill-after=1 2 \"$installation/holder\" holder");
    const entryEnd = source.indexOf("\nsystemctl stop \"$unit\"\n", entryStart);
    assert.notEqual(entryStart, -1);
    assert.notEqual(entryEnd, -1);
    const evidenceDir = path.join(dir, "entry-evidence");
    fs.mkdirSync(evidenceDir);
    const runconHarness = path.join(dir, "runcon-guard.sh");
    fs.writeFileSync(
      runconHarness,
      `#!/usr/bin/env bash\nset -euo pipefail\nexport PATH="${bin}:$PATH"\nuser=aiden-boundary-probe\ninstallation=/nonexistent\nevidence="${evidenceDir}"\n${source.slice(entryStart + 1, entryEnd)}\n`,
      { mode: 0o755 },
    );

    const denied = spawnSync("bash", [runconHarness], {
      encoding: "utf8",
      env: { ...process.env, MOCK_RUNCON_OUTPUT: "runcon: holder: Permission denied", MOCK_RUNCON_STATUS: "126" },
    });
    assert.equal(denied.status, 0, denied.stderr);

    const invalidContext = spawnSync("bash", [runconHarness], {
      encoding: "utf8",
      env: { ...process.env, MOCK_RUNCON_OUTPUT: "runcon: invalid context: system_u:system_r:aiden_boundary_probe_t:s0", MOCK_RUNCON_STATUS: "125" },
    });
    assert.equal(invalidContext.status, 1);
    assert.match(invalidContext.stderr, /invalid context/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
