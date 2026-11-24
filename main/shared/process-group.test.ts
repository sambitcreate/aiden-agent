import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureProcessGroupSurvivors,
  createProcessGroupTerminator,
  decodeCappedUtf8,
  observePreExitProcessGroupMembers,
  parseDarwinLsofSharedPipePids,
  parseLinuxLsofUnixPeerInodes,
  parseSsUnixPeerInodes,
  readProcessStartId,
  selectVerifiedProcessGroupSurvivors,
  waitForChildExit,
} from "./process-group.js";
import { processGroupRunning, processRunning } from "./process-liveness-test-support.js";

const posix = process.platform !== "win32";

function spawnGroup(script: string): ChildProcess {
  return spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

async function firstLine(child: ChildProcess): Promise<string> {
  let text = "";
  for await (const chunk of child.stdout!) {
    text += String(chunk);
    if (text.includes("\n")) return text.split("\n")[0]!;
  }
  return text;
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

test("termination keeps escalating after the leader closes until a SIGTERM-ignoring descendant is gone", { skip: !posix }, async (t) => {
  // The descendant ignores SIGTERM and does not hold the leader's pipes, so the
  // leader closes on SIGTERM while the descendant survives it.
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-process-group-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ready = path.join(dir, "ready");
  const child = spawnGroup(
    `sh -c 'trap "" TERM; : > "${ready}"; while :; do sleep 0.05; done' >/dev/null 2>&1 &\necho $!\nwait`,
  );
  const descendant = Number(await firstLine(child));
  t.after(() => { try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ } });
  assert.equal(await eventually(() => existsSync(ready)), true);
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 300 });
  const closed = once(child, "close");
  terminator.terminate();
  await closed;
  assert.equal(processRunning(descendant), true, "the descendant must outlive SIGTERM for this test to mean anything");
  await terminator.finished();
  assert.equal(await eventually(() => !processRunning(descendant)), true, "SIGKILL must still reach the group after the leader closed");
  assert.equal(processGroupRunning(child.pid), false);
});

test("a finished termination means the group is gone, not that SIGKILL was sent", { skip: !posix }, async (t) => {
  const child = spawnGroup(`trap "" TERM; echo ready; while :; do sleep 0.05; done`);
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } });
  await firstLine(child);
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 100 });
  terminator.terminate();
  assert.equal(await terminator.finished(), "exit_confirmed");
  assert.equal(processGroupRunning(child.pid), false);
});

test("a group that outlives SIGKILL is reported unconfirmed, never stopped", { skip: !posix }, async (t) => {
  const child = spawnGroup(`trap "" TERM; echo ready; while :; do sleep 0.05; done`);
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } });
  await firstLine(child);
  // SIGKILL cannot be ignored, so the group is reported as stuck by the probe.
  const terminator = createProcessGroupTerminator(child, {
    killGraceMs: 50,
    killConfirmMs: 100,
    probe: { exists: () => true, stillRuns: async () => true },
  });
  terminator.terminate();
  assert.equal(await terminator.finished(), "cleanup_unconfirmed");
});

test("zombies nobody reaped do not count against a stopped group", { skip: !posix }, async (t) => {
  const child = spawnGroup(`trap "" TERM; echo ready; while :; do sleep 0.05; done`);
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } });
  await firstLine(child);
  const terminator = createProcessGroupTerminator(child, {
    killGraceMs: 50,
    killConfirmMs: 5_000,
    probe: { exists: () => true, stillRuns: async () => false },
  });
  const started = Date.now();
  terminator.terminate();
  assert.equal(await terminator.finished(), "exit_confirmed");
  assert.ok(Date.now() - started < 2_000, "a zombie-only group must not wait out the confirmation window");
});

test("a probe that never answers cannot stretch the wait after SIGKILL", { skip: !posix }, async (t) => {
  const child = spawnGroup(`trap "" TERM; echo ready; while :; do sleep 0.05; done`);
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } });
  await firstLine(child);
  const terminator = createProcessGroupTerminator(child, {
    killGraceMs: 50,
    killConfirmMs: 100,
    probe: { exists: () => true, stillRuns: () => new Promise<boolean>(() => {}) },
  });
  terminator.terminate();
  assert.equal(await terminator.finished(), "cleanup_unconfirmed");
});

test("termination finishes as soon as the group exits instead of waiting out the grace period", { skip: !posix }, async () => {
  const child = spawnGroup("sleep 30");
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 10_000 });
  const started = Date.now();
  terminator.terminate();
  terminator.terminate();
  await terminator.finished();
  assert.ok(Date.now() - started < 2_000);
  assert.equal(terminator.requested, true);
});

test("an unrequested termination is already finished and signals nothing", { skip: !posix }, async () => {
  const child = spawnGroup("echo done");
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 10_000 });
  await terminator.finished();
  const completion = await waitForChildExit(child, { drainMs: 5_000 });
  assert.deepEqual(completion, { code: 0, signal: null, pipesHeld: false });
  assert.equal(terminator.requested, false);
});

test("a leader whose background job keeps stdout open settles after the drain window", { skip: !posix }, async (t) => {
  const child = spawnGroup("sleep 30 &\necho $!\nexit 3");
  const background = Number(await firstLine(child));
  t.after(() => { try { process.kill(background, "SIGKILL"); } catch { /* gone */ } });
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 500 });
  const started = Date.now();
  const completion = await waitForChildExit(child, { drainMs: 200, onPipesHeld: () => terminator.terminate() });
  assert.deepEqual(completion, { code: 3, signal: null, pipesHeld: true });
  assert.ok(Date.now() - started < 5_000, "settling must not wait for the 30 s background job");
  await terminator.finished();
  assert.equal(await eventually(() => !processRunning(background)), true, "the job holding the pipe is stopped with its group");
});

test("a spawn failure rejects the exit wait", async () => {
  const child = spawn("/nonexistent/aiden-binary", [], { stdio: ["ignore", "pipe", "pipe"] });
  await assert.rejects(waitForChildExit(child, { drainMs: 1_000 }), { code: "ENOENT" });
});

test("capped output drops a cut trailing character instead of showing U+FFFD", () => {
  const full = Buffer.from("héllo €", "utf8");
  const cut = full.subarray(0, full.length - 1);
  assert.equal(decodeCappedUtf8(cut, true), "héllo ");
  assert.equal(decodeCappedUtf8(full, true), "héllo €");
  assert.equal(decodeCappedUtf8(full, false), "héllo €");
});

test("selectVerifiedProcessGroupSurvivors fails closed for unproven leaderless groups even when startId >= leaderStartId", () => {
  const processes = [
    { pid: 900, ppid: 1, pgid: 800, uid: 1000, zombie: false, startId: "proc:200" },
    { pid: 901, ppid: 900, pgid: 800, uid: 1000, zombie: false, startId: "proc:201" },
  ];
  assert.deepEqual(
    selectVerifiedProcessGroupSurvivors({
      pgid: 800,
      processes,
      leaderStartId: "proc:100",
      parentPid: 500,
      currentUid: 1000,
    }),
    [],
    "a foreign same-UID leaderless group with newer startId must fail closed without incarnation proof",
  );
  // Stale pre-exit proof with matching PID but different startId must also fail closed.
  assert.deepEqual(
    selectVerifiedProcessGroupSurvivors({
      pgid: 800,
      processes,
      leaderStartId: "proc:100",
      parentPid: 500,
      currentUid: 1000,
      preExitMembers: [{ pid: 900, startId: "proc:105" }],
    }),
    [],
  );
});

test("selectVerifiedProcessGroupSurvivors accepts pre-exit, pipe-verified, and unreaped-tree members and rejects reused leaders", () => {
  const leaderlessProcesses = [
    // Proven via pre-exit observation (now zombie) with a live in-group child.
    { pid: 910, ppid: 1, pgid: 810, uid: 1000, zombie: true, startId: "proc:110" },
    { pid: 911, ppid: 910, pgid: 810, uid: 1000, zombie: false, startId: "proc:111" },
    // Proven via inherited transport pipe, with a live in-group child and a foreign-UID child.
    { pid: 920, ppid: 1, pgid: 810, uid: 1000, zombie: false, startId: "proc:120" },
    { pid: 921, ppid: 920, pgid: 810, uid: 1000, zombie: false, startId: "proc:121" },
    { pid: 922, ppid: 920, pgid: 810, uid: 2000, zombie: false, startId: "proc:122" },
    // Unrelated same-UID member in the same PGID with no proof.
    { pid: 930, ppid: 1, pgid: 810, uid: 1000, zombie: false, startId: "proc:130" },
  ];
  assert.deepEqual(
    selectVerifiedProcessGroupSurvivors({
      pgid: 810,
      processes: leaderlessProcesses,
      leaderStartId: "proc:100",
      parentPid: 500,
      currentUid: 1000,
      preExitMembers: [{ pid: 910, startId: "proc:110" }],
      pipeVerifiedPids: new Set([920]),
    }),
    [
      { pid: 911, startId: "proc:111" },
      { pid: 920, startId: "proc:120" },
      { pid: 921, startId: "proc:121" },
    ],
  );

  // If a foreign leader already reused PID === pgid, nothing may be captured even with proof inputs.
  assert.deepEqual(
    selectVerifiedProcessGroupSurvivors({
      pgid: 810,
      processes: [
        { pid: 810, ppid: 777, pgid: 810, uid: 1000, zombie: false, startId: "proc:150" },
        ...leaderlessProcesses,
      ],
      leaderStartId: "proc:100",
      parentPid: 500,
      currentUid: 1000,
      preExitMembers: [{ pid: 910, startId: "proc:110" }],
      pipeVerifiedPids: new Set([920]),
    }),
    [],
  );

  // If our own leader is still unreaped (matching ppid + leaderStartId), live descendants of parentPid are verified.
  assert.deepEqual(
    selectVerifiedProcessGroupSurvivors({
      pgid: 820,
      processes: [
        { pid: 500, ppid: 400, pgid: 500, uid: 1000, zombie: false, startId: "proc:50" },
        { pid: 820, ppid: 500, pgid: 820, uid: 1000, zombie: true, startId: "proc:100" },
        { pid: 821, ppid: 820, pgid: 820, uid: 1000, zombie: false, startId: "proc:101" },
      ],
      leaderStartId: "proc:100",
      parentPid: 500,
      currentUid: 1000,
    }),
    [{ pid: 821, startId: "proc:101" }],
  );
});

test("Linux ss and lsof socketpair parsers match only anonymous connected peer inodes", () => {
  const ssStdout = [
    "u_str ESTAB 0 0 * 75167340 * 75167341",
    "u_str ESTAB 0 0 * 75167342 * 75167343",
    "u_str ESTAB 0 0 /run/dbus/system_bus_socket 75167344 * 75167345",
    "u_str ESTAB 0 0 * 75167346 /var/run/named.sock 75167347",
    "u_str LISTEN 0 0 * 75167348 * 75167349",
    "u_str ESTAB 0 0 * 75167350 * 0",
  ].join("\n");
  const ssPeers = parseSsUnixPeerInodes(
    ssStdout,
    new Set(["75167340", "75167344", "75167346", "75167348", "75167350"]),
  );
  assert.deepEqual([...ssPeers.entries()], [["75167340", "75167341"]]);

  const lsofStdout = [
    "p1000",
    "f25",
    "tunix",
    "i75167340",
    "ntype=STREAM ->INO=75167341 2000,node,1u",
    "f27",
    "tunix",
    "i75167344",
    "n/run/dbus/system_bus_socket type=STREAM ->INO=75167345",
    "f29",
    "tunix",
    "i75167350",
    "ntype=STREAM ->INO=75167351 2000,node,2u",
    "p9999",
    "f25",
    "tunix",
    "i75167360",
    "ntype=STREAM ->INO=75167361",
  ].join("\n");
  const lsofPeers = parseLinuxLsofUnixPeerInodes(
    lsofStdout,
    1000,
    new Set([25, 27]),
    new Set(["75167340", "75167344", "75167350", "75167360"]),
  );
  assert.deepEqual([...lsofPeers.entries()], [["75167340", "75167341"]]);
});

test("Darwin lsof parser verifies anonymous PIPE and unix socketpairs and rejects named or zero-address entries", () => {
  const darwinLsof = [
    "p1000",
    // Anonymous PIPE held on transport FD 25
    "f25",
    "tPIPE",
    "d0x1111aaaa",
    "n->0x2222bbbb",
    // Anonymous unix socketpair held on transport FD 27
    "f27",
    "tunix",
    "d0x3333cccc",
    "n->0x4444dddd",
    // Named unix socket on FD 29 (must never verify)
    "f29",
    "tunix",
    "d0x5555eeee",
    "n/var/run/syslog ->0x6666ffff",
    // All-zero device address on FD 31 (must never verify)
    "f31",
    "tunix",
    "d0x0000000000000000",
    "n->0x7777aaaa",
    // Non-transport FD 40 (must not verify)
    "f40",
    "tPIPE",
    "d0x8888bbbb",
    "n->0x9999cccc",
    // Candidate 2001: matching PIPE peer of FD 25
    "p2001",
    "f1",
    "tPIPE",
    "d0x2222bbbb",
    "n->0x1111aaaa",
    // Candidate 2002: matching unix socketpair peer of FD 27
    "p2002",
    "f2",
    "tunix",
    "d0x4444dddd",
    "n->0x3333cccc",
    // Candidate 2003: matches named socket FD 29 only (rejected)
    "p2003",
    "f3",
    "tunix",
    "d0x6666ffff",
    "n/var/run/syslog ->0x5555eeee",
    // Candidate 2004: matches non-transport FD 40 only (rejected)
    "p2004",
    "f1",
    "tPIPE",
    "d0x9999cccc",
    "n->0x8888bbbb",
    // Candidate 2005: wrong type (`unix` vs parent `PIPE`) (rejected)
    "p2005",
    "f1",
    "tunix",
    "d0x2222bbbb",
    "n->0x1111aaaa",
    // Candidate 2006: unrelated pipe (rejected)
    "p2006",
    "f1",
    "tPIPE",
    "d0xdeadbeef",
    "n->0xfeedface",
  ].join("\n");
  const matched = parseDarwinLsofSharedPipePids(
    darwinLsof,
    1000,
    new Set([25, 27, 29, 31]),
    new Set([2001, 2002, 2003, 2004, 2005, 2006]),
  );
  assert.deepEqual([...matched].sort((a, b) => a - b), [2001, 2002]);
});

test("captureProcessGroupSurvivors fails closed without proof and verifies pipe-inheriting survivors while rejecting unrelated leaderless groups", { skip: !posix }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-survivor-proof-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. Spawn a wrapper whose grandchild inherits our stdout/stderr pipes, then wrapper exits.
  const ownedWrapper = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write(String(g.pid) + "\\n");
process.exit(0);`,
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const ownedGroup = ownedWrapper.pid!;
  const ownedLeaderStartId = readProcessStartId(ownedGroup);
  const ownedExited = once(ownedWrapper, "exit");
  const ownedGrandchild = Number(await firstLine(ownedWrapper));
  t.after(() => {
    for (const pid of [ownedGroup, ownedGrandchild]) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    ownedWrapper.stdin?.destroy();
    ownedWrapper.stdout?.destroy();
    ownedWrapper.stderr?.destroy();
  });
  await ownedExited;
  assert.equal(await eventually(() => !processRunning(ownedGroup)), true, "owned wrapper should be reaped");
  assert.equal(processRunning(ownedGrandchild), true, "owned grandchild should still run");

  // 2. Spawn an unrelated same-UID leaderless group with stdio ignored (no shared transport pipe).
  const foreignFile = path.join(dir, "foreign.pid");
  const foreignWrapper = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(foreignFile)}, String(g.pid));
process.exit(0);`,
    ],
    { detached: true, stdio: "ignore" },
  );
  const foreignGroup = foreignWrapper.pid!;
  const foreignExited = once(foreignWrapper, "exit");
  await foreignExited;
  assert.equal(await eventually(() => existsSync(foreignFile)), true);
  const foreignGrandchild = Number(
    (await import("node:fs")).readFileSync(foreignFile, "utf8").trim(),
  );
  t.after(() => {
    for (const pid of [foreignGroup, foreignGrandchild]) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  });
  assert.equal(await eventually(() => !processRunning(foreignGroup)), true, "foreign wrapper should be reaped");
  assert.equal(processRunning(foreignGrandchild), true, "foreign leaderless child should still run");

  // Without pre-exit observation or transport FDs, BOTH leaderless groups MUST fail closed.
  assert.deepEqual(
    captureProcessGroupSurvivors(ownedGroup, { leaderStartId: ownedLeaderStartId }),
    [],
    "leaderless capture without pre-exit or transport-pipe proof must fail closed",
  );
  assert.deepEqual(
    captureProcessGroupSurvivors(foreignGroup, { leaderStartId: ownedLeaderStartId }),
    [],
    "foreign same-UID leaderless group with newer startId must fail closed",
  );

  // Extract our open transport FDs from `ownedWrapper`.
  const ownedFds = [ownedWrapper.stdin, ownedWrapper.stdout, ownedWrapper.stderr]
    .map((stream) => (stream && !stream.destroyed ? (stream as unknown as { _handle?: { fd?: number } })._handle?.fd : undefined))
    .filter((fd): fd is number => typeof fd === "number" && Number.isSafeInteger(fd) && fd >= 0);
  assert.ok(ownedFds.length > 0, "expected at least one open stdio pipe FD held by owned grandchild");

  // With our transport's open pipe FDs, the pipe-inheriting grandchild IS captured...
  const capturedOwned = captureProcessGroupSurvivors(ownedGroup, {
    leaderStartId: ownedLeaderStartId,
    transportFds: ownedFds,
  });
  assert.equal(capturedOwned.length, 1);
  assert.equal(capturedOwned[0]!.pid, ownedGrandchild);
  assert.ok(capturedOwned[0]!.startId.length > 0);

  // ...while the unrelated same-UID leaderless group (holding no pipe from ownedWrapper) is REJECTED!
  assert.deepEqual(
    captureProcessGroupSurvivors(foreignGroup, {
      leaderStartId: ownedLeaderStartId,
      transportFds: ownedFds,
    }),
    [],
    "unrelated same-UID leaderless group without inherited transport pipe must be rejected",
  );
});

test("observePreExitProcessGroupMembers proves a stdio-ignored descendant before leader exit", { skip: !posix }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-preexit-proof-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
process.stdout.write(String(g.pid) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));`,
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pgid = child.pid!;
  const leaderStartId = readProcessStartId(pgid);
  const grandchild = Number(await firstLine(child));
  t.after(() => {
    for (const pid of [pgid, grandchild]) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  });
  const preExitMembers = observePreExitProcessGroupMembers(pgid, leaderStartId);
  assert.ok(
    preExitMembers.some((member) => member.pid === grandchild && member.startId.length > 0),
    `expected pre-exit observation of grandchild ${grandchild}, got ${JSON.stringify(preExitMembers)}`,
  );

  // Now let the leader exit and be reaped; grandchild has stdio: "ignore" (no shared pipes).
  const exited = once(child, "exit");
  child.stdin!.end();
  await exited;
  assert.equal(await eventually(() => !processRunning(pgid)), true);
  assert.equal(processRunning(grandchild), true);

  // Without pre-exit proof, capture fails closed.
  assert.deepEqual(captureProcessGroupSurvivors(pgid, { leaderStartId }), []);
  // With pre-exit proof captured alongside the verified live leader, grandchild IS captured.
  const captured = captureProcessGroupSurvivors(pgid, { leaderStartId, preExitMembers });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.pid, grandchild);
});
