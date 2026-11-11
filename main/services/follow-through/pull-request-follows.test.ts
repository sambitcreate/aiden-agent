import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PULL_REQUEST_FOLLOWS_PER_CHAT } from "../../../renderer/shared/follow-through.js";
import type { FollowProbe, FollowReadResult } from "./pull-request-follow-github.js";
import type { FollowedCheck, FollowNotice, PullRequestObservation } from "./pull-request-follow.js";
import { PullRequestFollows, type FollowTimers, type StartFollowInput } from "./pull-request-follows.js";

const T0 = Date.parse("2026-10-26T12:00:00Z");

function input(number = 42, chatId = "chat-1"): StartFollowInput {
  return {
    chatId,
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    startedBy: "agent",
  };
}

function open(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    title: "Add export",
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    headSha: "a".repeat(40),
    mergeable: true,
    checksState: "failing",
    checks: [{ name: "unit", status: "failure", url: "https://github.com/acme/app/actions/runs/1/job/2" }],
    comments: [],
    ...overrides,
  };
}

function harness(options: { answering?: (chatId: string, at: number) => boolean } = {}) {
  let now = T0;
  const posted: Array<{ chatId: string; notice: FollowNotice }> = [];
  const persisted: number[] = [];
  let answer: (follow: { number: number }) => FollowReadResult | Promise<FollowReadResult> = () => ({ kind: "ok", observation: open() });
  const logReads: string[] = [];
  const reads: Array<{ number: number; at: number; probe?: FollowProbe }> = [];
  // Fake one-shot timers: they fire only when the test moves the clock past them.
  const pending = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  const timers: FollowTimers = {
    set: (run, ms) => {
      nextTimer += 1;
      pending.set(nextTimer, { at: now + ms, run });
      return nextTimer;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  const follows = new PullRequestFollows({
    timers,
    reader: {
      read: async (follow, _signal, probe) => {
        reads.push({ number: follow.number, at: now, ...(probe ? { probe } : {}) });
        return answer(follow);
      },
      jobLogTail: async (_follow, check: FollowedCheck) => {
        logReads.push(check.name);
        return "Error: expected 2, got 3";
      },
    },
    post: (chatId, notice) => posted.push({ chatId, notice }),
    persist: (records) => persisted.push(records.length),
    chatWasAnswering: options.answering ?? (() => false),
    now: () => now,
  });
  return {
    follows,
    posted,
    persisted,
    logReads,
    reads,
    timers: pending,
    now: () => now,
    setAnswer: (next: typeof answer) => {
      answer = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    /** Move the clock, fire the timers that came due, and wait for the reads they start. */
    elapse: async (ms: number) => {
      now += ms;
      let fired = false;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.run();
        fired = true;
      }
      // The fired timer started a pass; this waits for that pass, it starts none.
      if (fired) await follows.kick();
    },
  };
}

test("following a pull request reads it at once and posts its failures with their logs", async () => {
  const { follows, posted, logReads } = harness();
  const view = follows.follow(input());
  assert.equal(view.state, "following");
  await follows.kick();
  assert.deepEqual(logReads, ["unit"]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.chatId, "chat-1");
  assert.equal(posted[0]!.notice.wake, true);
  assert.match(posted[0]!.notice.text, /Error: expected 2, got 3/u);
  const [listed] = follows.list("chat-1");
  assert.equal(listed!.status, "1 check failing");
  assert.equal(listed!.noticesSent, 1);

  // Not due again yet: nothing is read.
  await follows.kick();
  assert.deepEqual(logReads, ["unit"]);
});

test("following the same pull request twice keeps one follow; each chat may follow three", () => {
  const { follows } = harness();
  follows.follow(input(1));
  follows.follow(input(1));
  assert.equal(follows.list("chat-1").length, 1);
  for (let number = 2; number <= MAX_PULL_REQUEST_FOLLOWS_PER_CHAT; number += 1) follows.follow(input(number));
  assert.throws(() => follows.follow(input(99)), /already follows 3 pull requests/u);
  assert.doesNotThrow(() => follows.follow(input(99, "chat-2")), "the limit is per chat");
});

test("a comment the agent wrote with the person's account during its own answer is not news", async () => {
  const answering = (chatId: string, at: number) => chatId === "chat-1" && at >= T0 + 60_000 && at <= T0 + 120_000;
  const { follows, posted, setAnswer } = harness({ answering });
  setAnswer(() => ({
    kind: "ok",
    observation: open({
      checksState: "pending",
      checks: [{ name: "unit", status: "pending" }],
      comments: [
        { id: "mine", kind: "comment", author: "sambit", trusted: true, byViewer: true, body: "Fixed the test.", createdAt: T0 + 90_000 },
        { id: "person", kind: "comment", author: "sambit", trusted: true, byViewer: true, body: "Also bump the version.", createdAt: T0 + 300_000 },
      ],
    }),
  }));
  follows.follow(input());
  await follows.kick();
  assert.equal(posted.length, 1);
  assert.doesNotMatch(posted[0]!.notice.text, /Fixed the test/u);
  assert.match(posted[0]!.notice.text, /Also bump the version/u, "the person writing on GitHub later still counts");
});

test("a follow stopped while its read was in flight posts nothing", async () => {
  const { follows, posted, setAnswer } = harness();
  let release!: (result: FollowReadResult) => void;
  setAnswer(() => new Promise<FollowReadResult>((resolve) => (release = resolve)));
  follows.follow(input());
  const reading = follows.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(follows.stop("chat-1", input(), "person"), true);
  release({ kind: "ok", observation: open() });
  await reading;
  assert.deepEqual(posted, []);
  assert.equal(follows.list("chat-1")[0]!.endedReason, "person");
});

test("a pull request GitHub cannot find ends its follow; a failed read keeps it and says why", async () => {
  const gone = harness();
  gone.setAnswer(() => ({ kind: "gone", message: "GitHub could not find this pull request." }));
  gone.follows.follow(input());
  await gone.follows.kick();
  const [ended] = gone.follows.list("chat-1");
  assert.equal(ended!.state, "ended");
  assert.equal(ended!.endedReason, "unavailable");

  const flaky = harness();
  flaky.setAnswer(() => ({ kind: "retry", message: "GitHub's rate limit was reached; Aiden will try again later." }));
  flaky.follows.follow(input());
  await flaky.follows.kick();
  const [kept] = flaky.follows.list("chat-1");
  assert.equal(kept!.state, "following");
  assert.match(kept!.problem ?? "", /rate limit/u);
  assert.deepEqual(flaky.posted, []);

  // The next good read clears the problem.
  flaky.setAnswer(() => ({ kind: "ok", observation: open({ checksState: "pending", checks: [] }) }));
  flaky.advance(60 * 60_000);
  await flaky.follows.kick();
  assert.equal(flaky.follows.list("chat-1")[0]!.problem, undefined);
});

test("a reader that throws does not stop the loop", async () => {
  const { follows, setAnswer } = harness();
  setAnswer(() => {
    throw new Error("socket hang up");
  });
  follows.follow(input());
  await follows.kick();
  const [record] = follows.list("chat-1");
  assert.equal(record!.state, "following");
  assert.equal(record!.problem, "Aiden could not read this pull request.");
});

test("follows survive a restart, and deleting a chat forgets its follows", async () => {
  const first = harness();
  first.follows.follow(input(1));
  first.follows.follow(input(2, "chat-2"));
  await first.follows.kick();
  const saved = first.follows.all();

  const second = harness();
  second.follows.restore(saved);
  assert.equal(second.follows.list("chat-1").length, 1);
  second.follows.deleteChat("chat-1");
  assert.deepEqual(second.follows.list("chat-1"), []);
  assert.equal(second.follows.list("chat-2").length, 1);
  assert.equal(second.persisted[second.persisted.length - 1], 1, "the deletion is saved");
});

for (const ending of ["stop", "access-changed", "shutdown"] as const) {
  test(`a poll cancelled by ${ending} discards a late log and never reads the next one`, async () => {
    let finishLog!: (text: string) => void;
    let logSignal: AbortSignal | undefined;
    const logs: string[] = [];
    const posted: FollowNotice[] = [];
    const follows = new PullRequestFollows({
      now: () => T0,
      chatWasAnswering: () => false,
      persist: () => {},
      post: (_chat, notice) => posted.push(notice),
      reader: {
        read: async () => ({ kind: "ok", observation: open({
          checks: ["unit", "integration"].map((name) => ({ name, status: "failure", url: open().checks[0]!.url })),
        }) }),
        jobLogTail: async (_record, check, signal) => {
          logs.push(check.name);
          logSignal = signal;
          return new Promise<string>((resolve) => { finishLog = resolve; });
        },
      },
    });
    follows.follow(input());
    const polling = follows.kick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(logs, ["unit"]);
    if (ending === "shutdown") follows.shutdown();
    else follows.stop("chat-1", input(), ending === "stop" ? "person" : ending);
    assert.equal(logSignal?.aborted, true);
    finishLog("late failure");
    await polling;
    assert.deepEqual(logs, ["unit"]);
    assert.deepEqual(posted, []);
    assert.equal(follows.all()[0]?.noticesSent, 0);
  });
}

test("a workspace change suspends a due poll until commit or rollback", async () => {
  const { follows, setAnswer, posted } = harness();
  let finish!: (value: FollowReadResult) => void;
  setAnswer(() => new Promise((resolve) => { finish = resolve; }));
  follows.follow(input());
  const resume = follows.pauseChats(["chat-1"]);
  finish({ kind: "ok", observation: open() });
  await follows.kick();
  assert.equal(posted.length, 0);
  assert.equal(follows.list("chat-1")[0]?.state, "following");
  setAnswer(() => ({ kind: "ok", observation: open() }));
  resume();
  await follows.kick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.chatId, "chat-1");
});

const MINUTE = 60_000;
const PR_PATH = "/repos/acme/app/pulls/42";

/** A settled pull request: checks passed, nothing to say. */
function quiet(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return open({ checksState: "passing", checks: [{ name: "unit", status: "success" }], ...overrides });
}

function nextCheckIn(h: ReturnType<typeof harness>): number {
  return h.follows.all()[0]!.nextCheckAt - h.now();
}

test("a burst of nudges reads the follow once, after the burst settles, from the nudge timer", async () => {
  const h = harness();
  h.setAnswer(() => ({ kind: "ok", observation: quiet() }));
  h.follows.follow(input());
  await h.follows.kick();
  assert.equal(h.reads.length, 1);

  h.advance(MINUTE);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(h.follows.nudge("chat-1", "action"), 1);
    await h.elapse(1_000);
  }
  assert.equal(h.reads.length, 1, "nudges still arriving: nothing is read yet");
  assert.equal(h.timers.size, 1, "one timer stands for the whole burst");

  await h.elapse(5_000);
  assert.equal(h.reads.length, 2, "the burst cost exactly one read");
  assert.equal(h.timers.size, 0);
  await h.elapse(30_000);
  await h.follows.kick();
  assert.equal(h.reads.length, 2, "and no second one");
});

test("a nudge that arrives while its follow is being read gets one more read, not more", async () => {
  const h = harness();
  h.setAnswer(() => ({ kind: "ok", observation: quiet() }));
  h.follows.follow(input());
  await h.follows.kick();
  h.advance(MINUTE);

  let release!: (result: FollowReadResult) => void;
  h.setAnswer(() => new Promise<FollowReadResult>((resolve) => (release = resolve)));
  h.follows.nudge("chat-1", "action");
  h.advance(5_000);
  const reading = h.follows.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.length, 2);
  h.follows.nudge("chat-1", "action");
  h.follows.nudge("chat-1", "action");
  h.setAnswer(() => ({ kind: "ok", observation: quiet() }));
  release({ kind: "ok", observation: quiet() });
  await reading;
  assert.equal(h.reads.length, 2, "the nudges during the read wait their own turn");

  await h.elapse(30_000);
  assert.equal(h.reads.length, 3);
  await h.elapse(MINUTE);
  assert.equal(h.reads.length, 3);
});

test("a timed read that comes due inside a nudge's debounce does not use the nudge up", async () => {
  const h = harness();
  h.setAnswer(() => ({ kind: "ok", observation: quiet() }));
  h.follows.follow(input());
  await h.follows.kick();
  const timedReadIn = nextCheckIn(h);

  // A push two seconds before the timed read: that read may be too early to show it.
  h.advance(timedReadIn - 2_000);
  h.follows.nudge("chat-1", "action");
  h.advance(2_000);
  await h.follows.kick();
  assert.equal(h.reads.length, 2, "the timed read ran");

  await h.elapse(30_000);
  assert.equal(h.reads.length, 3, "the nudge still reads once, after its interval");
  await h.elapse(MINUTE);
  assert.equal(h.reads.length, 3, "and only once");
});

test("a nudge never reads sooner than the follow's minimum interval or before a rate limit lifts", async () => {
  const h = harness();
  h.setAnswer(() => ({ kind: "ok", observation: quiet() }));
  h.follows.follow(input());
  await h.follows.kick();

  // Focus right after a read: wait for the settled cadence, not the debounce.
  h.follows.nudgeAll("ambient");
  await h.elapse(10_000);
  assert.equal(h.reads.length, 1);

  h.setAnswer(() => ({ kind: "retry", message: "GitHub's rate limit was reached.", retryAt: h.now() + 20 * MINUTE }));
  await h.elapse(5 * MINUTE);
  assert.equal(h.reads.length, 2, "the ambient nudge read at the settled cadence");

  h.setAnswer(() => ({ kind: "ok", observation: quiet() }));
  h.follows.nudge("chat-1", "action");
  await h.elapse(MINUTE);
  await h.elapse(10 * MINUTE);
  assert.equal(h.reads.length, 2, "nothing goes out while GitHub asked Aiden to wait");
  await h.elapse(9 * MINUTE);
  assert.equal(h.reads.length, 3);
});

test("a stopped follow sends no request, however it is nudged", async () => {
  const h = harness();
  h.follows.follow(input());
  await h.follows.kick();
  h.advance(MINUTE);
  h.follows.nudge("chat-1", "action");
  assert.equal(h.timers.size, 1);
  h.follows.stop("chat-1", input(), "person");
  assert.equal(h.timers.size, 0, "stopping drops the pending nudge");
  assert.equal(h.follows.nudge("chat-1", "action"), 0);
  assert.equal(h.follows.nudgeAll("ambient"), 0);
  await h.elapse(60 * MINUTE);
  await h.follows.kick();
  assert.equal(h.reads.length, 1);

  // A deleted chat and a shut-down loop are just as quiet.
  const deleted = harness();
  deleted.follows.follow(input());
  await deleted.follows.kick();
  deleted.advance(MINUTE);
  deleted.follows.nudge("chat-1", "action");
  deleted.follows.deleteChat("chat-1");
  deleted.follows.follow(input(7, "chat-2"));
  await deleted.follows.kick();
  deleted.follows.shutdown();
  assert.equal(deleted.follows.nudgeAll("action"), 0);
  assert.equal(deleted.timers.size, 0);
  await deleted.elapse(60 * MINUTE);
  assert.deepEqual(deleted.reads.map((read) => read.number), [42, 7]);
});

test("a nudge waits while its chat's workspace is changing", async () => {
  const h = harness();
  h.setAnswer(() => ({ kind: "ok", observation: quiet() }));
  h.follows.follow(input());
  await h.follows.kick();
  h.advance(MINUTE);
  const resume = h.follows.pauseChats(["chat-1"]);
  h.follows.nudge("chat-1", "action");
  await h.elapse(MINUTE);
  await h.follows.kick();
  assert.equal(h.reads.length, 1);
  resume();
  await h.follows.kick();
  assert.equal(h.reads.length, 2);
});

test("an unchanged probe posts nothing, reads no logs and keeps the status", async () => {
  const h = harness();
  const etags = { [PR_PATH]: 'W/"pr-1"' };
  h.setAnswer(() => ({ kind: "ok", observation: quiet(), etags }));
  h.follows.follow(input());
  await h.follows.kick();
  const before = h.follows.list("chat-1")[0]!;
  const postedBefore = h.posted.length;

  h.setAnswer(() => ({ kind: "unchanged" }));
  h.advance(nextCheckIn(h));
  await h.follows.kick();
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.reads[1]!.probe, { etags, skipIfUnchanged: true }, "the stored tags go out as If-None-Match");
  assert.equal(h.posted.length, postedBefore);
  assert.deepEqual(h.logReads, []);
  const after = h.follows.list("chat-1")[0]!;
  assert.equal(after.status, before.status);
  assert.equal(after.noticesSent, before.noticesSent);
  assert.equal(h.follows.all()[0]!.lastCheckedAt, h.now(), "an unchanged answer still counts as a look");
});

test("a quiet pull request is read less and less often, and back at the normal cadence once it changes", async () => {
  const h = harness();
  const etags = { [PR_PATH]: 'W/"pr-1"' };
  h.setAnswer(() => ({ kind: "ok", observation: quiet(), etags }));
  h.follows.follow(input());
  await h.follows.kick();
  assert.equal(nextCheckIn(h), 5 * MINUTE, "a settled read keeps today's five-minute cadence");

  h.setAnswer(() => ({ kind: "unchanged" }));
  const delays: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    h.advance(nextCheckIn(h));
    await h.follows.kick();
    delays.push(nextCheckIn(h));
  }
  // The third look would wait 20 minutes, but the full read is due 30 minutes
  // after the last one (T+20 then T+30); after that the backoff is at its cap.
  assert.deepEqual(delays, [5, 10, 10, 30].map((minutes) => minutes * MINUTE));

  // A new comment changes the pull request: the backoff starts over.
  h.setAnswer(() => ({
    kind: "ok",
    etags: { [PR_PATH]: 'W/"pr-2"' },
    observation: quiet({
      comments: [{ id: "c1", kind: "comment", author: "reviewer", trusted: true, body: "Please rename this.", createdAt: h.now() }],
    }),
  }));
  h.advance(nextCheckIn(h));
  await h.follows.kick();
  assert.ok(h.posted.some((post) => /Please rename this/u.test(post.notice.text)));
  assert.equal(nextCheckIn(h), 5 * MINUTE);

  h.setAnswer(() => ({ kind: "unchanged" }));
  h.advance(nextCheckIn(h));
  await h.follows.kick();
  assert.deepEqual(h.reads[h.reads.length - 1]!.probe?.etags, { [PR_PATH]: 'W/"pr-2"' }, "the new tags are the ones probed");
});

test("checks still running keep the two-minute cadence even when nothing changes", async () => {
  const h = harness();
  h.setAnswer(() => ({
    kind: "ok",
    etags: { [PR_PATH]: 'W/"pr-1"' },
    observation: open({ checksState: "pending", checks: [{ name: "unit", status: "pending" }] }),
  }));
  h.follows.follow(input());
  await h.follows.kick();
  h.setAnswer(() => ({ kind: "unchanged" }));
  for (let index = 0; index < 3; index += 1) {
    h.advance(nextCheckIn(h));
    await h.follows.kick();
    assert.equal(nextCheckIn(h), 2 * MINUTE);
  }
});

test("a failing check is never probed, and a full read half an hour old is never skipped", async () => {
  const failing = harness();
  failing.setAnswer(() => ({ kind: "ok", observation: open(), etags: { [PR_PATH]: 'W/"pr-1"' } }));
  failing.follows.follow(input());
  await failing.follows.kick();
  failing.advance(nextCheckIn(failing));
  await failing.follows.kick();
  assert.equal(failing.reads[1]!.probe, undefined, "the failing-for-an-hour clock needs a full read, so no probe goes out");

  const stale = harness();
  stale.setAnswer(() => ({ kind: "ok", observation: quiet(), etags: { [PR_PATH]: 'W/"pr-1"' } }));
  stale.follows.follow(input());
  await stale.follows.kick();
  stale.setAnswer(() => ({ kind: "unchanged" }));
  for (let index = 0; index < 3; index += 1) {
    stale.advance(nextCheckIn(stale));
    await stale.follows.kick();
  }
  // 5 + 5 + 10 minutes since the full read. The backoff would wait 20 more,
  // but the full read is due 30 minutes after the last one, so 10 more.
  assert.equal(nextCheckIn(stale), 10 * MINUTE);
  stale.advance(nextCheckIn(stale));
  await stale.follows.kick();
  assert.equal(stale.reads[stale.reads.length - 1]!.probe?.skipIfUnchanged, false);
});

test("a forced full read that found what the probe said, nothing new, keeps backing off", async () => {
  const h = harness();
  h.setAnswer(() => ({ kind: "ok", observation: quiet(), etags: { [PR_PATH]: 'W/"pr-1"' } }));
  h.follows.follow(input());
  await h.follows.kick();
  h.setAnswer(() => ({ kind: "ok", observation: quiet(), etags: { [PR_PATH]: 'W/"pr-1"' }, probedUnchanged: true }));
  h.advance(nextCheckIn(h));
  await h.follows.kick();
  h.advance(nextCheckIn(h));
  await h.follows.kick();
  assert.equal(nextCheckIn(h), 10 * MINUTE);
});
