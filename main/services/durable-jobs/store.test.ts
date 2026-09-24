import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { JobError, LEASE_MS, JOB_LIMITS } from "./contract.js";
import { DurableJobStore } from "./store.js";
import { checkpoint, evidence, fixture, input } from "./test-fixture.js";

const code = (expected: JobError["code"]) => (error: unknown) =>
  error instanceof JobError && error.code === expected;

test("admission is durable, deduplicated, profile-bound and reserves one unresolved chat", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const other = f.open();
  assert.deepEqual(other.enqueue({ ...input }, "actor", "key"), job);
  assert.throws(
    () => other.enqueue({ ...input, modelId: "other" }, "actor", "key"),
    code("conflict"),
  );
  assert.throws(
    () => other.enqueue(input, "actor", "new-key"),
    code("conflict"),
  );
  assert.throws(
    () => other.enqueue({ ...input, profileId: "other" }, "actor", "new-key"),
    code("unsafe"),
  );
  assert.throws(
    () => new DurableJobStore({ root: f.root, profileId: "other" }),
    code("unsafe"),
  );
  assert.equal(other.get(job.id).state, "admitting");
});

test("two connections claim once, renew without public revision, and fence takeover", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const other = f.open();
  const first = f.store.claim("one")!;
  assert.equal(other.claim("two"), null);
  const rev = other.get(job.id).revision;
  f.clock(20_000);
  f.store.heartbeat(first.lease);
  assert.equal(other.get(job.id).revision, rev);
  f.clock(80_000);
  assert.throws(() => f.store.heartbeat(first.lease), code("lost_lease"));
  const second = other.claim("two")!;
  assert.ok(second.lease.fence > first.lease.fence);
  for (const operation of [
    () => f.store.checkpoint(first.lease, checkpoint),
    () => f.store.settle(first.lease, evidence("completed")),
    () => f.store.admitted(first.lease, checkpoint),
  ])
    assert.throws(operation, code("lost_lease"));
  assert.equal(other.get(job.id).resultRef, null);
});

test("expired owner cannot renew or execute before another claimant arrives", (t) => {
  const f = fixture(t);
  f.store.enqueue(input, "actor", "key");
  const { lease } = f.store.claim("one")!;
  f.clock(1_000 + LEASE_MS);
  assert.throws(() => f.store.assertLease(lease), code("lost_lease"));
  assert.throws(
    () => f.store.beginExecution(lease, "start"),
    code("lost_lease"),
  );
  assert.throws(() => f.store.heartbeat(lease), code("lost_lease"));
});

test("persisted high-water clock prevents backward-clock resurrection", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const { lease } = f.store.claim("one")!;
  f.clock(100_000);
  f.store.get(job.id);
  f.clock(1_001);
  const other = f.open();
  assert.throws(() => other.heartbeat(lease), code("lost_lease"));
  assert.ok(other.claim("two"));
});

test("global concurrent lease bound is shared by connections", (t) => {
  const f = fixture(t, 1);
  f.store.enqueue(input, "actor", "key");
  f.store.enqueue(
    { ...input, chatId: "other", messageId: "m2", turnId: "t2" },
    "actor",
    "key2",
  );
  const other = f.open();
  const first = f.store.claim("one")!;
  assert.equal(other.claim("two"), null);
  f.store.settle(first.lease, evidence("completed"));
  assert.equal(other.claim("two")!.job.input.chatId, "other");
});

test("dispatch marker and attempt commit before execution; reclaim does not create an attempt", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const first = f.store.claim("one")!;
  f.store.admitted(first.lease, checkpoint);
  const running = f.store.beginExecution(first.lease, "start");
  assert.equal(running.executionCount, 1);
  f.clock(100_000);
  const next = f.open().claim("two")!;
  assert.equal(next.job.executionCount, 1);
  assert.equal(f.store.attempts(job.id).length, 1);
  assert.throws(
    () => f.store.beginExecution(next.lease, "start"),
    code("unsafe"),
  );
});

for (const action of ["pause", "cancel", "stop"] as const)
  test(`${action} receipt fences old callbacks and survives reopen`, (t) => {
    const f = fixture(t);
    const job = f.store.enqueue(input, "actor", "key");
    const first = f.store.claim("one")!;
    const request = {
      actor: "actor",
      key: "control",
      jobId: job.id,
      expectedRevision: first.job.revision,
    };
    const result =
      action === "stop"
        ? f.store.interrupt({ ...request, turnId: input.turnId })
        : f.store.control({ ...request, action });
    assert.throws(
      () => f.store.admitted(first.lease, checkpoint),
      code("lost_lease"),
    );
    const other = f.open();
    const duplicate =
      action === "stop"
        ? other.interrupt({ ...request, turnId: input.turnId })
        : other.control({ ...request, action });
    assert.deepEqual(duplicate, result);
    const next = other.claim("two")!;
    other.settle(next.lease, evidence("not_started"));
    assert.equal(
      other.get(job.id).state,
      action === "pause"
        ? "paused"
        : action === "cancel"
          ? "cancelled"
          : "interrupted",
    );
    assert.equal(other.claim("three"), null);
  });

test("stale controls, wrong turn and changed idempotency payload cannot change work", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const request = {
    actor: "actor",
    key: "control",
    jobId: job.id,
    expectedRevision: job.revision,
  };
  assert.throws(
    () => f.store.interrupt({ ...request, turnId: "another-turn" }),
    code("conflict"),
  );
  f.store.control({ ...request, action: "pause" });
  assert.throws(
    () => f.store.control({ ...request, action: "cancel" }),
    code("conflict"),
  );
  assert.throws(
    () => f.store.control({ ...request, key: "new-key", action: "cancel" }),
    code("conflict"),
  );
});

test("unknown evidence stays unresolved after cancel and cannot be resumed or retried", (t) => {
  const f = fixture(t);
  let job = f.store.enqueue(input, "actor", "key");
  f.store.settle(f.store.claim("one")!.lease, evidence("unknown"));
  for (const action of ["resume", "retry"] as const) {
    job = f.store.get(job.id);
    assert.throws(
      () =>
        f.store.control({
          actor: "actor",
          key: action,
          jobId: job.id,
          expectedRevision: job.revision,
          action,
        }),
      code("unsafe"),
    );
  }
  job = f.store.get(job.id);
  f.store.control({
    actor: "actor",
    key: "cancel",
    jobId: job.id,
    expectedRevision: job.revision,
    action: "cancel",
  });
  f.store.settle(f.store.claim("two")!.lease, evidence("unknown"));
  assert.equal(f.store.get(job.id).state, "needs_attention");
  assert.throws(
    () => f.store.enqueue(input, "actor", "replacement"),
    code("conflict"),
  );
});

test("completed evidence wins a cancellation race without losing its receipt", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  f.store.control({
    actor: "actor",
    key: "cancel",
    jobId: job.id,
    expectedRevision: job.revision,
    action: "cancel",
  });
  f.store.settle(f.store.claim("one")!.lease, evidence("completed"));
  assert.equal(f.store.get(job.id).state, "succeeded");
  assert.equal(f.store.get(job.id).resultRef, "assistant-result");
});

for (const kind of ["waiting_approval", "waiting_input"] as const)
  test(`${kind} releases the worker lease without granting continuation`, (t) => {
    const f = fixture(t);
    const job = f.store.enqueue(input, "actor", "key");
    f.store.settle(f.store.claim("one")!.lease, evidence(kind));
    const waiting = f.store.get(job.id);
    assert.equal(waiting.state, kind);
    assert.equal(waiting.waitId, "approval-1");
    assert.equal(f.store.claim("two"), null);
    assert.throws(
      () =>
        f.store.control({
          actor: "actor",
          key: "resume",
          jobId: job.id,
          expectedRevision: waiting.revision,
          action: "resume",
        }),
      code("unsafe"),
    );
  });

test("failed commit rolls back admission, dispatch and Stop acknowledgments", (t) => {
  const f = fixture(t);
  f.failWrites(true);
  assert.throws(() => f.store.enqueue(input, "actor", "key"), /disk failure/u);
  f.failWrites(false);
  const job = f.store.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  f.store.admitted(claim.lease, checkpoint);
  const before = f.store.get(job.id);
  f.failWrites(true);
  assert.throws(
    () => f.store.beginExecution(claim.lease, "start"),
    /disk failure/u,
  );
  assert.throws(
    () =>
      f.store.interrupt({
        actor: "actor",
        key: "stop",
        jobId: job.id,
        expectedRevision: before.revision,
        turnId: input.turnId,
      }),
    /disk failure/u,
  );
  f.failWrites(false);
  assert.deepEqual(f.open().get(job.id), before);
  assert.equal(f.store.attempts(job.id).length, 0);
});

test("private database and sidecars are repaired; symlinks and unsupported schemas fail closed", (t) => {
  const f = fixture(t);
  f.store.enqueue(input, "actor", "key");
  chmodSync(f.root, 0o755);
  for (const name of readdirSync(f.root))
    chmodSync(path.join(f.root, name), 0o666);
  f.open();
  assert.equal(statSync(f.root).mode & 0o777, 0o700);
  for (const name of readdirSync(f.root))
    assert.equal(statSync(path.join(f.root, name)).mode & 0o777, 0o600);
  const alias = path.join(f.root, "alias");
  symlinkSync(f.root, alias);
  assert.throws(
    () => new DurableJobStore({ root: alias, profileId: "profile" }),
    code("unsafe"),
  );
  const raw = new DatabaseSync(path.join(f.root, "jobs-v1.sqlite"));
  raw.exec("PRAGMA user_version=99");
  raw.close();
  assert.throws(() => f.open(), /Unsupported/u);
});

test("corrupt database is preserved rather than replaced", (t) => {
  const f = fixture(t);
  f.store.close();
  const file = path.join(f.root, "jobs-v1.sqlite");
  writeFileSync(file, "not a database");
  assert.throws(() => f.open());
  assert.equal(readFileSync(file, "utf8"), "not a database");
});

test("input and persisted record validation fail closed", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.store.enqueue({ ...input, inputDigest: "bad" }, "actor", "key"),
    code("invalid"),
  );
  const job = f.store.enqueue(input, "actor", "key");
  const raw = new DatabaseSync(path.join(f.root, "jobs-v1.sqlite"));
  raw
    .prepare("UPDATE jobs SET data=? WHERE id=?")
    .run(JSON.stringify({ ...job, version: 2 }), job.id);
  raw.close();
  assert.throws(() => f.store.get(job.id), code("invalid"));
});

test("event history is bounded and checkpoint references cannot cross input ownership", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  assert.throws(
    () =>
      f.store.admitted(claim.lease, {
        ...checkpoint,
        inputMessageId: "foreign",
      }),
    code("unsafe"),
  );
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  for (let i = 0; i < 70; i++)
    f.store.checkpoint(claim.lease, { ...checkpoint, headId: `head-${i}` });
  assert.equal(f.store.events(job.id).length, JOB_LIMITS.eventsPerJob);
  assert.equal(f.store.get(job.id).checkpoint?.headId, "head-69");
});

test("observing expiry on a rejected write cannot revive the lease after clock rollback and reopen", (t) => {
  const f = fixture(t);
  f.store.enqueue(input, "actor", "key");
  const claim = f.store.claim("old")!;
  f.clock(100_000);
  assert.throws(() => f.store.heartbeat(claim.lease), code("lost_lease"));
  f.clock(1_001);
  assert.throws(() => f.open().assertLease(claim.lease), code("lost_lease"));
});

test("cancel intent cannot be downgraded to pause or Stop", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const cancelled = f.store.control({
    actor: "actor",
    key: "cancel",
    jobId: job.id,
    expectedRevision: job.revision,
    action: "cancel",
  });
  assert.throws(
    () =>
      f.store.control({
        actor: "actor",
        key: "pause",
        jobId: job.id,
        expectedRevision: cancelled.revision,
        action: "pause",
      }),
    code("conflict"),
  );
  assert.throws(
    () =>
      f.store.interrupt({
        actor: "actor",
        key: "stop",
        jobId: job.id,
        expectedRevision: cancelled.revision,
        turnId: input.turnId,
      }),
    code("conflict"),
  );
});

test("new admission keys cannot reuse a terminal run's transcript/turn identity", (t) => {
  const f = fixture(t);
  f.store.enqueue(input, "actor", "key");
  f.store.settle(f.store.claim("owner")!.lease, evidence("completed"));
  assert.throws(() => f.store.enqueue(input, "actor", "new-key"));
  assert.throws(() =>
    f.store.enqueue({ ...input, messageId: "new-message" }, "actor", "new-key"),
  );
  assert.ok(
    f.store.enqueue(
      { ...input, messageId: "new-message", turnId: "new-turn" },
      "actor",
      "new-key",
    ),
  );
});

test("bounded SQLite contention rejects without partial admission and can retry", (t) => {
  const f = fixture(t);
  const raw = new DatabaseSync(path.join(f.root, "jobs-v1.sqlite"));
  try {
    raw.exec("BEGIN IMMEDIATE");
    assert.throws(() => f.store.enqueue(input, "actor", "key"), /locked/u);
    raw.exec("ROLLBACK");
    assert.ok(f.store.enqueue(input, "actor", "key"));
  } finally {
    raw.close();
  }
});

test("independent profile roots do not share leases, receipts or reservations", (t) => {
  const f = fixture(t);
  const g = fixture(t);
  const first = f.store.enqueue(input, "actor", "key");
  const second = g.store.enqueue(input, "actor", "key");
  assert.notEqual(first.id, second.id);
  assert.ok(f.store.claim("one"));
  assert.ok(g.store.claim("one"));
});

test(
  "simultaneous process contenders admit exactly one SQL owner",
  { timeout: 15_000 },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const f = fixture(t);
    f.store.enqueue(input, "actor", "key");
    const script = `
    import { DurableJobStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
    const store = new DurableJobStore({root: process.env.JOB_TEST_ROOT, profileId: 'profile', now: () => 1000});
    process.on('message', () => {
      try { process.send(store.claim(String(process.pid))?.lease.leaseId ?? null); }
      catch(error) { process.send({error: String(error)}); }
      store.close(); process.disconnect();
    });
    process.send('ready');
  `;
    const children = [0, 1].map(() =>
      spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: { ...process.env, JOB_TEST_ROOT: f.root },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      ),
    );
    t.after(() => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
    });
    const exits = children.map((child) => once(child, "exit"));
    await Promise.all(children.map((child) => once(child, "message")));
    const replies = children.map((child) => once(child, "message"));
    for (const child of children) child.send("claim");
    const values = (await Promise.all(replies)).map(([value]) => value);
    await Promise.all(exits);
    assert.equal(values.filter((value) => typeof value === "string").length, 1);
    assert.equal(values.filter((value) => value === null).length, 1);
  },
);

test("completed history and receipts do not exhaust active admission/control quotas", (t) => {
  const f = fixture(t);
  const first = f.store.enqueue(input, "actor", "key");
  const completed = f.store.settle(
    f.store.claim("one")!.lease,
    evidence("completed"),
  );
  const raw = new DatabaseSync(path.join(f.root, "jobs-v1.sqlite"));
  try {
    raw.exec("BEGIN IMMEDIATE");
    const insert = raw.prepare(
      "INSERT INTO jobs VALUES(?,?,?,?,NULL,NULL,NULL,0,?)",
    );
    for (let i = 1; i < JOB_LIMITS.unresolvedJobs; i++) {
      const job = {
        ...completed,
        id: `history-${i}`,
        input: {
          ...input,
          chatId: `old-chat-${i}`,
          messageId: `old-message-${i}`,
          turnId: `old-turn-${i}`,
        },
      };
      insert.run(
        job.id,
        job.input.chatId,
        job.state,
        job.revision,
        JSON.stringify(job),
      );
    }
    for (let i = 0; i < JOB_LIMITS.unresolvedControls; i++)
      raw
        .prepare(
          "INSERT INTO controls(actor,key,digest,response) VALUES(?,?,?,?)",
        )
        .run("actor", `old-control-${i}`, "old", JSON.stringify(completed));
    raw.exec("COMMIT");
  } finally {
    raw.close();
  }
  const next = f.store.enqueue(
    { ...input, messageId: "new-message", turnId: "new-turn" },
    "actor",
    "new-key",
  );
  assert.doesNotThrow(() =>
    f.store.control({
      actor: "actor",
      key: "new-control",
      jobId: next.id,
      expectedRevision: next.revision,
      action: "pause",
    }),
  );
  assert.equal(f.store.enqueue(input, "actor", "key").id, first.id);
  assert.throws(
    () => f.store.enqueue({ ...input, modelId: "other" }, "actor", "key"),
    code("conflict"),
  );
});

for (const action of ["resume", "retry"] as const) {
  test(`${action} preserves the prior settled execution attempt`, (t) => {
    const f = fixture(t);
    const job = f.store.enqueue(input, "actor", "key");
    const claim = f.store.claim("one")!;
    f.store.admitted(claim.lease, checkpoint);
    f.store.beginExecution(claim.lease, "start");
    const settled = f.store.settle(
      claim.lease,
      evidence(action === "resume" ? "checkpoint" : "failed_safe"),
    );
    const attempts = f.store.attempts(job.id);
    f.clock(2_000);
    f.store.control({
      actor: "actor",
      key: action,
      jobId: job.id,
      expectedRevision: settled.revision,
      action,
    });
    assert.deepEqual(f.store.attempts(job.id), attempts);
  });
}

test("control requests do not finish an unsettled execution attempt", (t) => {
  const f = fixture(t);
  const job = f.store.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  f.store.admitted(claim.lease, checkpoint);
  const running = f.store.beginExecution(claim.lease, "start");
  f.store.control({
    actor: "actor",
    key: "pause",
    jobId: job.id,
    expectedRevision: running.revision,
    action: "pause",
  });
  assert.equal(f.store.attempts(job.id)[0].finished_at, null);
  f.store.settle(f.store.claim("two")!.lease, evidence("checkpoint"));
  assert.equal(f.store.attempts(job.id)[0].outcome, "paused");
});

test("checkpoint input mismatch is an integrity failure, not lease loss", (t) => {
  const f = fixture(t);
  f.store.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  assert.throws(
    () =>
      f.store.checkpoint(claim.lease, {
        ...checkpoint,
        inputMessageId: "other-message",
      }),
    code("unsafe"),
  );
});

test("failed-safe evidence requires a checkpoint for an admissible retry", (t) => {
  const f = fixture(t);
  f.store.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  assert.throws(
    () =>
      f.store.settle(
        claim.lease,
        evidence("failed_safe", { checkpoint: null }),
      ),
    code("invalid"),
  );
});
