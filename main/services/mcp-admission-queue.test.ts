import assert from "node:assert/strict";
import test from "node:test";
import { createMcpAdmissionQueue, McpPendingJournalState, singleFlight } from "./mcp-admission-queue.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("admissions for different servers run concurrently while one server's admissions stay ordered", async () => {
  const queue = createMcpAdmissionQueue();
  const slow = gate();
  const events: string[] = [];
  const slowAdmission = queue.shared("slow", async () => { events.push("slow:start"); await slow.opened; events.push("slow:end"); });
  const slowAgain = queue.shared("slow", async () => { events.push("slow-again"); });
  const fast = queue.shared("fast", async () => { events.push("fast"); });
  await fast;
  assert.deepEqual(events, ["slow:start", "fast"], "a slow server does not hold another server's admission");
  slow.open();
  await Promise.all([slowAdmission, slowAgain]);
  assert.deepEqual(events, ["slow:start", "fast", "slow:end", "slow-again"]);
});

test("a mutation waits for in-flight admissions and later admissions wait for the mutation", async () => {
  const queue = createMcpAdmissionQueue();
  const admitting = gate();
  const mutating = gate();
  const events: string[] = [];
  const first = queue.shared("a", async () => { events.push("admit-a"); await admitting.opened; events.push("admit-a:end"); });
  const mutation = queue.exclusive(async () => { events.push("mutate"); await mutating.opened; events.push("mutate:end"); return "saved"; });
  const later = queue.shared("b", async () => { events.push("admit-b"); });
  await tick();
  assert.deepEqual(events, ["admit-a"]);
  assert.ok(queue.exclusiveBusy());
  admitting.open();
  await first;
  await tick();
  assert.deepEqual(events, ["admit-a", "admit-a:end", "mutate"]);
  mutating.open();
  assert.equal(await mutation, "saved");
  await later;
  assert.deepEqual(events, ["admit-a", "admit-a:end", "mutate", "mutate:end", "admit-b"]);
  assert.ok(!queue.exclusiveBusy());
});

test("a failed operation does not block the operations queued behind it", async () => {
  const queue = createMcpAdmissionQueue();
  const failedMutation = queue.exclusive(async () => { throw new Error("publication failed"); });
  const failedAdmission = queue.shared("a", async () => { throw new Error("configuration changed"); });
  await assert.rejects(failedMutation, /publication failed/u);
  await assert.rejects(failedAdmission, /configuration changed/u);
  assert.equal(await queue.shared("a", async () => "admitted"), "admitted");
  assert.equal(await queue.exclusive(async () => "mutated"), "mutated");
});

test("the journal is read until this process knows it is empty, and again after its own write", async () => {
  const journal = new McpPendingJournalState();
  let fileReads = 0;
  let pendingOnDisk = true;
  const reconcile = singleFlight(async () => {
    fileReads += 1;
    await tick();
    journal.observed(pendingOnDisk);
    if (pendingOnDisk) {
      pendingOnDisk = false;
      journal.cleared();
    }
  });
  const admit = async () => { if (!journal.knownEmpty()) await reconcile(); };

  // Startup: unknown state; concurrent admissions share one read and cleanup.
  await Promise.all([admit(), admit(), admit()]);
  assert.equal(fileReads, 1);
  await admit();
  await admit();
  assert.equal(fileReads, 1, "no disk read while the journal is known to be empty");

  journal.written();
  pendingOnDisk = true;
  await admit();
  assert.equal(fileReads, 2);
  journal.uncertain();
  await admit();
  assert.equal(fileReads, 3, "an I/O failure makes the next admission read again");
});
