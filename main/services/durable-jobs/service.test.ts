import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import type { DurableJobSnapshot } from "../../../renderer/shared/durable-jobs.js";
import {
  DurableJobService,
  type DurableJobRuntime,
  type JobExecutionContext,
  type JobRuntimeSession,
} from "./service.js";
import { DurableJobWorker } from "./worker.js";
import {
  checkpoint,
  deferred,
  evidence,
  fixture,
  input,
} from "./test-fixture.js";
import { type RecoveryEvidence, JobError } from "./contract.js";

function setup(t: TestContext) {
  const f = fixture(t);
  let current = evidence("not_started");
  let calls = 0;
  let appendCalls = 0;
  let active = false;
  const messages = new Set<string>();
  const modes: string[] = [];
  const errors: unknown[] = [];
  let execute = async (
    context: JobExecutionContext,
  ): Promise<RecoveryEvidence> => {
    context.beforeEffect();
    calls++;
    modes.push(context.mode);
    current = evidence("completed");
    return current;
  };
  const runtime: DurableJobRuntime = {
    validateInput: async (value) => {
      assert.equal(value.inputDigest, input.inputDigest);
    },
    acquire: async (job): Promise<JobRuntimeSession | null> => {
      if (active) return null;
      active = true;
      return {
        evidence: async () => current,
        appendInput: async () => {
          appendCalls++;
          messages.add(job.input.messageId);
          return { ...checkpoint, inputMessageId: job.input.messageId };
        },
        execute: (context) => execute(context),
        close: async () => {
          active = false;
        },
      };
    },
  };
  const service = new DurableJobService(f.store, runtime);
  const worker = new DurableJobWorker(service, (error) => {
    errors.push(error);
  });
  t.after(async () => {
    await worker.stop();
  });
  return {
    ...f,
    runtime,
    service,
    worker,
    errors,
    messages,
    modes,
    counts: () => ({ calls, appendCalls }),
    setEvidence: (value: RecoveryEvidence) => {
      current = value;
    },
    setExecute: (value: typeof execute) => {
      execute = value;
    },
  };
}
const control = (
  job: DurableJobSnapshot,
  action: "pause" | "resume" | "cancel" | "retry",
  key = action,
) => ({
  actor: "actor",
  key,
  jobId: job.id,
  expectedRevision: job.revision,
  action,
});

test("accepted request completes with one input and no duplicate after reopen", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "succeeded");
  assert.deepEqual(f.counts(), { calls: 1, appendCalls: 1 });
  assert.equal(f.messages.size, 1);
  const restarted = new DurableJobWorker(
    new DurableJobService(f.open(), f.runtime),
    (error) => assert.fail(String(error)),
  );
  await restarted.tick();
  assert.equal(f.counts().calls, 1);
});

test("input appended before lost receipt is reconciled by stable message ID", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  f.messages.add(input.messageId); // external chat commit survived, SQL receipt did not
  f.store.claim("dead-process");
  f.clock(100_000);
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "succeeded");
  assert.equal(f.messages.size, 1);
  assert.equal(f.counts().calls, 1);
});

test("final transcript before missing terminal receipt recovers without generation", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const claim = f.store.claim("dead-process")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  f.setEvidence(evidence("completed"));
  f.clock(100_000);
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "succeeded");
  assert.deepEqual(f.counts(), { calls: 0, appendCalls: 0 });
});

for (const kind of [
  "unknown",
  "missing",
  "unsettled",
  "stale_authority",
  "interrupted",
  "waiting_approval",
  "waiting_input",
] as const)
  test(`recovery ${kind} never repeats a previously dispatched request`, async (t) => {
    const f = setup(t);
    const job = await f.service.enqueue(input, "actor", "key");
    const claim = f.store.claim("dead-process")!;
    f.store.admitted(claim.lease, checkpoint);
    f.store.beginExecution(claim.lease, "start");
    f.setEvidence(evidence(kind));
    f.clock(100_000);
    await f.worker.tick();
    await f.worker.tick();
    assert.equal(f.counts().calls, 0);
    assert.equal(f.store.get(job.id).recovery, kind);
  });

test("external mutation with lost response cannot run again under lease expiry or new keys", async (t) => {
  const f = setup(t);
  let externalMutations = 0;
  f.setExecute(async (context) => {
    context.beforeEffect();
    externalMutations++;
    f.setEvidence(evidence("unknown"));
    throw new Error("provider accepted mutation then dropped connection");
  });
  const job = await f.service.enqueue(input, "actor", "key");
  await f.worker.tick();
  assert.equal(externalMutations, 1);
  // A crash-recovery observer can see the preserved authoritative effect.
  f.store.control(control(f.store.get(job.id), "cancel"));
  f.clock(100_000);
  await f.worker.tick();
  assert.equal(f.store.get(job.id).recovery, "unknown");
  for (const action of ["resume", "retry"] as const)
    assert.throws(() => f.store.control(control(f.store.get(job.id), action)));
  await f.worker.tick();
  assert.equal(externalMutations, 1);
});

test("queued pause, safe resume and interrupt preserve request identity", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  f.store.control(control(job, "pause"));
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "paused");
  assert.equal(f.counts().calls, 0);
  f.store.control(control(f.store.get(job.id), "resume"));
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "succeeded");
  assert.equal(f.messages.size, 1);
});

test("safe checkpoint requires explicit resume and does not append the input again", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const dead = f.store.claim("dead")!;
  f.store.admitted(dead.lease, checkpoint);
  f.store.beginExecution(dead.lease, "start");
  f.setEvidence(evidence("checkpoint"));
  f.clock(100_000);
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "interrupted");
  assert.equal(f.counts().calls, 0);
  f.store.control(control(f.store.get(job.id), "resume"));
  await f.worker.tick();
  assert.deepEqual(f.modes, ["resume"]);
  assert.equal(f.counts().appendCalls, 0);
  assert.equal(f.store.get(job.id).executionCount, 2);
});

test("changed session head between Resume admission and execution does not dispatch", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  f.store.settle(claim.lease, evidence("checkpoint"));
  f.store.control(control(f.store.get(job.id), "resume"));
  f.setEvidence(
    evidence("checkpoint", {
      checkpoint: { ...checkpoint, headId: "changed" },
    }),
  );
  await f.worker.tick();
  assert.equal(f.counts().calls, 0);
  assert.equal(f.store.get(job.id).state, "needs_attention");
});

test("explicit retry requires safe failure evidence and consumes one new attempt", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  f.store.settle(claim.lease, evidence("failed_safe"));
  f.setEvidence(evidence("failed_safe"));
  f.store.control(control(f.store.get(job.id), "retry"));
  await f.worker.tick();
  assert.deepEqual(f.modes, ["retry"]);
  assert.equal(f.store.attempts(job.id).length, 2);
});

test("Stop after dispatch never automatically restarts its turn, even at a safe checkpoint", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const claim = f.store.claim("old")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  const current = f.store.get(job.id);
  f.store.interrupt({
    actor: "actor",
    key: "stop",
    jobId: job.id,
    expectedRevision: current.revision,
    turnId: input.turnId,
  });
  f.setEvidence(evidence("checkpoint"));
  f.clock(100_000);
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "interrupted");
  assert.equal(f.store.get(job.id).intent, "stop");
  assert.equal(f.counts().calls, 0);
});

test("in-flight control fences callback before its external effect and next owner waits for settlement", async (t) => {
  const f = setup(t);
  const entered = deferred();
  const resume = deferred();
  let mutations = 0;
  f.setExecute(async (context) => {
    entered.resolve();
    await resume.promise;
    context.beforeEffect();
    mutations++;
    return evidence("completed");
  });
  const job = await f.service.enqueue(input, "actor", "key");
  const running = f.worker.tick();
  await entered.promise;
  f.store.control(control(f.store.get(job.id), "cancel"));
  const replacement = new DurableJobWorker(
    new DurableJobService(f.open(), f.runtime),
    (error) => assert.fail(String(error)),
  );
  await replacement.tick();
  assert.equal(f.store.get(job.id).state, "needs_attention");
  assert.equal(f.store.get(job.id).recovery, "unsettled");
  resume.resolve();
  await running;
  assert.equal(mutations, 0);
});

test("lease expiry while the old handler is alive cannot admit overlapping execution", async (t) => {
  const f = setup(t);
  const entered = deferred();
  const resume = deferred();
  f.setExecute(async (context) => {
    entered.resolve();
    await resume.promise;
    context.beforeEffect();
    return evidence("completed");
  });
  const job = await f.service.enqueue(input, "actor", "key");
  const first = f.worker.tick();
  await entered.promise;
  f.clock(100_000);
  const second = new DurableJobWorker(
    new DurableJobService(f.open(), f.runtime),
    (error) => assert.fail(String(error)),
  );
  await second.tick();
  assert.equal(f.store.get(job.id).recovery, "unsettled");
  resume.resolve();
  await first;
  assert.equal(f.store.get(job.id).state, "needs_attention");
});

test("failed dispatch commit makes zero provider calls", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const original = f.runtime.acquire;
  f.runtime.acquire = async (value, signal) => {
    const session = (await original(value, signal))!;
    return {
      ...session,
      appendInput: async () => {
        const cp = await session.appendInput();
        f.failWrites(true);
        return cp;
      },
    };
  };
  await f.worker.tick();
  f.failWrites(false);
  assert.equal(f.counts().calls, 0);
  assert.equal(f.store.get(job.id).dispatched, false);
  assert.ok(f.errors.length > 0);
});

test("invalid durable input is never acknowledged", async (t) => {
  const f = setup(t);
  f.runtime.validateInput = async () => {
    throw new Error("missing staged input");
  };
  await assert.rejects(
    f.service.enqueue(input, "actor", "key"),
    /missing staged/u,
  );
  assert.equal(f.store.claim("one"), null);
});

test("heartbeat loss aborts the runtime and stale completion cannot publish", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = setup(t);
  const entered = deferred();
  let observedAbort = false;
  f.setExecute(async (context) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          resolve();
        },
        { once: true },
      ),
    );
    context.beforeEffect();
    return evidence("completed");
  });
  const job = await f.service.enqueue(input, "actor", "key");
  const run = f.worker.tick();
  await entered.promise;
  f.clock(100_000);
  t.mock.timers.tick(20_000);
  await run;
  assert.equal(observedAbort, true);
  assert.notEqual(f.store.get(job.id).state, "succeeded");
});

test("bounded shutdown preserves reservation while non-abortable work settles", async (t) => {
  const f = setup(t);
  const entered = deferred();
  const release = deferred();
  f.setExecute(async () => {
    entered.resolve();
    await release.promise;
    return evidence("checkpoint");
  });
  await f.service.enqueue(input, "actor", "key");
  const run = f.worker.tick();
  await entered.promise;
  assert.equal(await f.worker.stop(0), false);
  release.resolve();
  await run;
  assert.equal(await f.worker.stop(0), true);
});

test("worker errors are reported without restarting the same failed operation", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  f.runtime.acquire = async () => {
    throw new JobError("unsafe");
  };
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.errors.length, 1);
  assert.equal(f.store.get(job.id).state, "needs_attention");
});

test("host reconciliation after a held predecessor settles does not implicitly resume", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const claim = f.store.claim("old")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  f.store.settle(claim.lease, evidence("unsettled"));
  f.setEvidence(evidence("checkpoint"));
  f.store.reconcile(job.id, f.store.get(job.id).revision);
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "interrupted");
  assert.equal(f.counts().calls, 0);
});

test("failed runtime settlement retains its lease and never publishes a completed run", async (t) => {
  const f = setup(t);
  let closeCalls = 0;
  const original = f.runtime.acquire;
  f.runtime.acquire = async (job, signal) => {
    const session = (await original(job, signal))!;
    return {
      ...session,
      close: async () => {
        closeCalls++;
        throw new Error("unsettled journal writer");
      },
    };
  };
  const job = await f.service.enqueue(input, "actor", "key");
  await f.worker.tick();
  assert.equal(closeCalls, 1);
  assert.equal(f.store.get(job.id).state, "running");
  assert.equal(f.store.claim("other"), null);
  assert.equal(f.errors.length, 1);
});

test("unknown child effects block safe-looking parent continuation", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const claim = f.store.claim("old")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  f.setEvidence(
    evidence("unknown", {
      checkpoint: { ...checkpoint, childRunIds: ["unsettled-child"] },
    }),
  );
  f.clock(100_000);
  await f.worker.tick();
  assert.equal(f.store.get(job.id).state, "needs_attention");
  assert.throws(() => f.store.control(control(f.store.get(job.id), "resume")));
  assert.equal(f.counts().calls, 0);
});

test(
  "SIGKILL after durable dispatch marker preserves recovery without repeating execution",
  { timeout: 15_000 },
  async (t) => {
    const { spawn } = await import("node:child_process");
      const f = setup(t);
    const job = await f.service.enqueue(input, "actor", "key");
    const script = `
    import { DurableJobStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
    const store = new DurableJobStore({root: process.env.JOB_TEST_ROOT, profileId: 'profile', now: () => 1000});
    const claim = store.claim('killed-process');
    store.admitted(claim.lease, ${JSON.stringify(checkpoint)});
    store.beginExecution(claim.lease, 'start');
    process.send('dispatch-committed');
    setInterval(() => {}, 1000);
  `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: { ...process.env, JOB_TEST_ROOT: f.root },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    const exit = once(child, "exit");
    await once(child, "message");
    child.kill("SIGKILL");
    await exit;
    f.setEvidence(evidence("unknown"));
    f.clock(100_000);
    await f.worker.tick();
    assert.equal(f.store.get(job.id).state, "needs_attention");
    assert.equal(f.store.get(job.id).executionCount, 1);
    assert.equal(f.counts().calls, 0);
  },
);

test("original audience survives restart and revoked authority cannot resume", async (t) => {
  const f = setup(t);
  const job = await f.service.enqueue(input, "actor", "key");
  const claim = f.store.claim("one")!;
  f.store.admitted(claim.lease, checkpoint);
  f.store.beginExecution(claim.lease, "start");
  f.store.settle(claim.lease, evidence("checkpoint"));
  f.store.control(control(f.store.get(job.id), "resume"));
  f.runtime.acquire = async (restored) => {
    assert.equal(restored.input.audienceId, input.audienceId);
    return {
      evidence: async () => evidence("stale_authority"),
      appendInput: async () => assert.fail("revoked"),
      execute: async () => assert.fail("revoked"),
      close: async () => {},
    };
  };
  const worker = new DurableJobWorker(
    new DurableJobService(f.open(), f.runtime),
    (error) => assert.fail(String(error)),
  );
  await worker.tick();
  assert.equal(f.store.get(job.id).state, "needs_attention");
  assert.equal(f.counts().calls, 0);
});
