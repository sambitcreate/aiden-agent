import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export function verifyEvidence(read, restored = false) {
  const json = (name) => JSON.parse(read(`${name}.json`));
  const operations = ["file", "proc", "socket"];
  if (restored) {
    for (const operation of [...operations, "scm", "inherited"]) assert.equal(json(`restored-${operation}`).success, true);
    return { scope: "synthetic-selinux-prerequisite", restored: true, computerUseEnabled: false };
  }
  assert.equal(read("enforcement.txt").trim(), "Enforcing");
  assert.match(read("attacker-context.txt"), /:unconfined_t:/u);
  assert.match(read("holder-context.txt"), /:aiden_boundary_probe_t:/u);
  assert.equal(read("hardened-holder-check.txt").trim(), "native-context-check-before-socket");
  const avc = read("avc.txt");
  const results = [];
  let uid;
  for (const operation of operations) {
    const before = json(`before-${operation}`), after = json(`after-${operation}`);
    assert.equal(before.success, true, `${operation} needs a successful baseline`);
    assert.equal(after.success, false, `${operation} was not denied`);
    assert.ok([1, 13].includes(after.errno), `${operation} must fail with EPERM/EACCES`);
    assert.ok(before.uid > 0);
    uid ??= before.uid;
    assert.equal(before.uid, uid); assert.equal(after.uid, uid);
    assert.ok(read(`before-${operation}-allow.txt`).trim(), `${operation} needs stock allow evidence`);
    assert.equal(read(`after-${operation}-allow.txt`).trim(), "", `${operation} effective allow survived`);
    const target = operation === "file" ? "aiden_boundary_probe_data_t" : "aiden_boundary_probe_t";
    const objectClass = operation === "socket" ? "unix_stream_socket" : "file";
    assert.ok(Number.isInteger(after.pid) && after.pid > 1);
    const permission = operation === "socket" ? /denied\s+\{\s*connectto\s*\}/u : /denied\s+\{\s*read\s*\}/u;
    const matchingAvc = avc.split("\n").some(line => permission.test(line) && line.includes(` pid=${after.pid} `) && line.includes("scontext=unconfined_u:unconfined_r:unconfined_t:") && line.includes(`:${target}:`) && line.includes(`tclass=${objectClass} `) && line.includes("permissive=0"));
    if (!matchingAvc && operation === "proc") assert.ok(read("after-proc-dontaudit.txt").trim(), "Missing proc AVC needs explicit stock dontaudit evidence");
    else assert.ok(matchingAvc, `${operation} needs matching fixture AVC`);
    results.push({ operation, baseline: "allowed", hardened: "denied", effectiveAllowRemoved: true, audit: matchingAvc ? "matching-enforcing-AVC" : "not-observed-stock-dontaudit-applies" });
  }
  assert.ok(read("before-fd-allow.txt").trim(), "descriptor tests need a stock fd use allow");
  assert.equal(read("after-fd-allow.txt").trim(), "", "effective fd use allow survived");
  const delegation = ["scm", "inherited"].map(operation => {
    const before = json(`before-${operation}`), after = json(`after-${operation}`);
    for (const receipt of [before, after]) {
      assert.equal(receipt.operation, operation);
      assert.equal(receipt.uid, uid);
      assert.ok(Number.isInteger(receipt.pid) && receipt.pid > 1);
      assert.match(receipt.context, operation === "scm" ? /^unconfined_u:unconfined_r:unconfined_t:/u : /^system_u:system_r:unconfined_t:s0$/u);
    }
    assert.equal(before.success, true, `${operation} requires successful token-read baseline`);
    assert.equal(before.stage, "read");
    assert.equal(before.errno, 0);
    assert.equal(before.truncated, false);
    assert.equal(after.success, false, `${operation} leaked token`);
    if (operation === "scm") {
      assert.equal(after.stage, "receive-no-fd");
      assert.equal(after.truncated, true);
      assert.equal(after.errno, 0); // recvmsg succeeded but kernel omitted unauthorized FD
    } else {
      assert.equal(after.stage, "read");
      assert.equal(after.truncated, false);
      assert.ok([1, 13].includes(after.errno), "inherited descriptor read needs EPERM/EACCES");
    }
    assert.ok(avc.split("\n").some(line => /denied\s+\{\s*use\s*\}/u.test(line) && line.includes(` pid=${after.pid} `) && line.includes(`scontext=${after.context} `) && line.includes("tcontext=system_u:system_r:aiden_boundary_probe_t:s0 ") && line.includes('path="/run/aiden-selinux-boundary-probe/private.txt"') && line.includes("tclass=fd ") && line.includes("permissive=0")), `${operation} requires exact receiver private-FD use AVC`);
    return { operation, baseline: "token-read", hardened: operation === "scm" ? "SCM_RIGHTS-FD-omitted" : "inherited-FD-read-denied-after-fork-and-setcon", effectiveAllowRemoved: true, audit: "matching-enforcing-private-FD-use-AVC" };
  });
  const entries = json("entry-attempts");
  for (const status of [entries.direct, entries.runcon]) assert.equal(status, 126, "Entry test must reach execution and fail with GNU cannot-invoke status");
  const transition = read("after-transition-allow.txt").trim().split("\n").filter(Boolean);
  assert.ok(transition.length > 0);
  for (const line of transition) assert.match(line, /^allow init_t [a-zA-Z0-9_]+:process /u);
  assert.equal(read("after-dyntransition-allow.txt").trim(), "");
  assert.doesNotMatch(read("runcon.txt"), /invalid context/u);
  const ancillary = ["proc-fd", "ptrace", "pidfd"].map(operation => {
    const before = json(`before-${operation}`), after = json(`after-${operation}`);
    assert.equal(before.uid, uid); assert.equal(after.uid, uid);
    const matchingAvc = ["ptrace", "pidfd"].includes(operation) && avc.split("\n").some(line => line.includes(` pid=${after.pid} `) && line.includes("denied  { ptrace }") && line.includes(":aiden_boundary_probe_t:") && line.includes("tclass=process") && line.includes("permissive=0"));
    const established = before.success && after.success === false && [1, 13].includes(after.errno) && matchingAvc && read("before-ptrace-allow.txt").trim() && !read("after-ptrace-allow.txt").trim();
    return { operation, before, after, conclusion: established ? "matching-enforcing-AVC-and-effective-allow-removed" : before.success ? "not-proven-no-complete-audit-evidence" : "not-proven-baseline-denied" };
  });
  return { scope: "synthetic-selinux-prerequisite", results, delegation, entryAttemptsRejected: true, systemServiceRestartedInDomain: true, ancillary, releaseIdentityEstablished: false, computerUseEnabled: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--restored")) throw new Error("Usage: node verify.mjs <evidence-directory> [--restored]");
  const result = verifyEvidence(name => readFileSync(path.join(directory, name), "utf8"), process.argv[3] === "--restored");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
