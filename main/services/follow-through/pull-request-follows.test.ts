import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PULL_REQUEST_FOLLOWS_PER_CHAT } from "../../../renderer/shared/follow-through.js";
import { GitHubApi } from "../github/github-api.js";
import { GitHubRateLimitGate } from "../github/github-request-gate.js";
import { PullRequestFollowReader, type FollowProbe, type FollowReadResult } from "./pull-request-follow-github.js";
import { newFollowRecord, type FollowedCheck, type FollowNotice, type PullRequestObservation } from "./pull-request-follow.js";
import { MAX_CONCURRENT_FOLLOW_POLLS, PullRequestFollows, type FollowTimers, type StartFollowInput } from "./pull-request-follows.js";

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

for (const ending of ["stop", "access-changed", "pauseChats", "deleteChat", "shutdown"] as const) {
  test(`a poll cancelled by ${ending} aborts all in-flight log fetches, posts nothing, and isolates unrelated chats`, async () => {
    const logDeferreds = new Map<string, { signal?: AbortSignal; resolve: (text: string) => void }>();
    const logs: string[] = [];
    const posted: Array<{ chatId: string; notice: FollowNotice }> = [];
    const follows = new PullRequestFollows({
      now: () => T0,
      chatWasAnswering: () => false,
      persist: () => {},
      post: (chatId, notice) => posted.push({ chatId, notice }),
      reader: {
        read: async (record) => ({
          kind: "ok",
          observation: open({
            url: `https://github.com/acme/app/pull/${record.number}`,
            checks: ["unit", "integration"].map((name, index) => ({
              name,
              status: "failure",
              url: `https://github.com/acme/app/actions/runs/${record.number}/job/${index + 1}`,
            })),
          }),
        }),
        jobLogTail: async (_record, check, signal) => {
          const runNumber = /\/runs\/(\d+)\//u.exec(check.url ?? "")?.[1] ?? "0";
          const key = `${runNumber}:${check.name}`;
          logs.push(key);
          return new Promise<string>((resolve) => {
            logDeferreds.set(key, { signal, resolve });
          });
        },
      },
    });
    follows.follow(input(42, "chat-1"));
    follows.follow(input(43, "chat-2"));
    const polling = follows.kick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      [...logs].sort(),
      ["42:integration", "42:unit", "43:integration", "43:unit"],
      "failing job logs for both due follows start concurrently",
    );

    let resumePaused: (() => void) | undefined;
    if (ending === "shutdown") follows.shutdown();
    else if (ending === "pauseChats") resumePaused = follows.pauseChats(["chat-1"]);
    else if (ending === "deleteChat") follows.deleteChat("chat-1");
    else follows.stop("chat-1", input(42, "chat-1"), ending === "stop" ? "person" : ending);

    assert.equal(logDeferreds.get("42:unit")?.signal?.aborted, true);
    assert.equal(logDeferreds.get("42:integration")?.signal?.aborted, true);
    assert.equal(
      logDeferreds.get("43:unit")?.signal?.aborted,
      ending === "shutdown",
      "only shutdown cancels another chat's active poll",
    );

    for (const entry of logDeferreds.values()) entry.resolve("late failure");
    await polling;
    resumePaused?.();

    assert.deepEqual(
      posted.map((item) => item.chatId),
      ending === "shutdown" ? [] : ["chat-2"],
      "cancelled chat posts no notice while an unaffected chat still delivers its notice",
    );
    const chat1Record = follows.all().find((item) => item.chatId === "chat-1");
    if (ending === "deleteChat") assert.equal(chat1Record, undefined);
    else assert.equal(chat1Record?.noticesSent, 0);
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

test("a probe that comes back after the full read fell due is followed by the full read at once", async () => {
  const h = harness();
  const etags = { [PR_PATH]: 'W/"pr-1"' };
  h.setAnswer(() => ({ kind: "ok", observation: quiet(), etags }));
  h.follows.follow(input());
  await h.follows.kick();
  h.setAnswer(() => ({ kind: "unchanged" }));
  for (let index = 0; index < 2; index += 1) {
    h.advance(nextCheckIn(h));
    await h.follows.kick();
  }
  // The probe leaves at T+20, inside the half hour, and GitHub answers it 11
  // minutes later; only a probe may come back unchanged, as with the real reader.
  h.advance(nextCheckIn(h));
  const fullReadAt = h.now() - 20 * MINUTE;
  const before = h.reads.length;
  h.setAnswer(() => {
    if (!h.reads[h.reads.length - 1]!.probe?.skipIfUnchanged) return { kind: "ok", observation: quiet(), etags };
    h.advance(11 * MINUTE);
    return { kind: "unchanged" };
  });
  await h.follows.kick();
  const looks = h.reads.slice(before);
  assert.deepEqual(looks.map(({ at, probe }) => ({ after: at - fullReadAt, skip: probe?.skipIfUnchanged })), [
    { after: 20 * MINUTE, skip: true },
    // Not another 20-minute backoff: the full read the probe stood in for went
    // due while it was out, so it runs as soon as the probe returns.
    { after: 31 * MINUTE, skip: false },
  ]);
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

test("a pull request still failing after its hour card goes back to cheap probes", async () => {
  const h = harness();
  const etags = { [PR_PATH]: 'W/"pr-1"' };
  h.setAnswer(() => ({ kind: "ok", observation: open(), etags }));
  h.follows.follow(input());
  await h.follows.kick();
  // Full reads, with no probe, until the hour is up and its card goes out.
  while (!h.posted.some((post) => post.notice.notice.title === "Still failing after an hour")) {
    h.advance(nextCheckIn(h));
    await h.follows.kick();
    assert.equal(h.reads[h.reads.length - 1]!.probe, undefined, "the failure clock still needs full reads");
    assert.ok(h.now() - T0 <= 2 * 60 * MINUTE, "the hour card came");
  }
  // The next look sends probes again and keeps the tags GitHub hands back.
  h.advance(nextCheckIn(h));
  await h.follows.kick();
  assert.ok(h.reads[h.reads.length - 1]!.probe, "probes go out again");
  // From then on an unchanged pull request costs only the probe.
  h.setAnswer(() => ({ kind: "unchanged" }));
  const posted = h.posted.length;
  h.advance(nextCheckIn(h));
  await h.follows.kick();
  assert.deepEqual(h.reads[h.reads.length - 1]!.probe, { etags, skipIfUnchanged: true });
  assert.equal(h.posted.length, posted);
  assert.equal(h.follows.list("chat-1")[0]!.state, "following");
});

test("tick polls up to four due pull requests concurrently in dueAt order without re-claiming in-flight follows", async () => {
  const startedOrder: number[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const gates = new Map<number, (result: FollowReadResult) => void>();
  const follows = new PullRequestFollows({
    now: () => T0,
    chatWasAnswering: () => false,
    persist: () => {},
    post: () => {},
    reader: {
      read: async (record) => {
        startedOrder.push(record.number);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          return await new Promise<FollowReadResult>((resolve) => {
            gates.set(record.number, resolve);
          });
        } finally {
          inFlight -= 1;
        }
      },
      jobLogTail: async () => undefined,
    },
  });

  // Restore six due records in shuffled order with distinct dueAt timestamps (10..60).
  const numbers = [50, 20, 60, 10, 40, 30];
  follows.restore(
    numbers.map((number) => ({
      ...newFollowRecord({ ...input(number, `chat-${number}`), now: T0 - 1_000 }),
      nextCheckAt: T0 - (100 - number),
    })),
  );

  const sweep = follows.kick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(MAX_CONCURRENT_FOLLOW_POLLS, 4);
  assert.deepEqual(startedOrder, [10, 20, 30, 40], "earliest four due follows start together");
  assert.equal(inFlight, 4);

  // Kicking again while all four slots are busy neither duplicates in-flight follows nor exceeds four.
  void follows.kick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(startedOrder, [10, 20, 30, 40]);

  // Finishing #20 opens one slot, which immediately claims #50 before #60.
  gates.get(20)!({ kind: "ok", observation: quiet() });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(startedOrder, [10, 20, 30, 40, 50]);
  assert.equal(inFlight, 4);

  // Finishing #40 opens the next slot for #60.
  gates.get(40)!({ kind: "ok", observation: quiet() });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(startedOrder, [10, 20, 30, 40, 50, 60]);
  assert.equal(peakInFlight, 4);

  for (const number of [10, 30, 50, 60]) {
    gates.get(number)!({ kind: "ok", observation: quiet() });
  }
  await sweep;
  assert.equal(inFlight, 0);
  assert.equal(startedOrder.length, 6, "each due follow ran once");
});

test("multi-PR polling through GitHubApi cuts 304 sweeps to 1 wave and 3-PR active sweeps to 6 or fewer waves", async () => {
  interface QueuedFetch {
    url: string;
    init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal };
    resolve: (response: Response) => void;
  }

  let now = T0;
  let queued: QueuedFetch[] = [];
  let waves = 0;
  let respond!: (request: QueuedFetch) => Response;

  const flushWavesUntilSettled = async (done: Promise<void>) => {
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    while (!finished) {
      for (let tick = 0; tick < 6; tick += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (finished) break;
      assert.ok(queued.length > 0, "expected queued HTTP requests in wave");
      const batch = queued;
      queued = [];
      waves += 1;
      for (const item of batch) {
        item.resolve(respond(item));
      }
    }
    await done;
  };

  const gate = new GitHubRateLimitGate({ now: () => now });
  const api = new GitHubApi({
    now: () => now,
    gate,
    credentials: {
      resolve: async (host) => ({ ok: true, credential: { host, token: "tok", source: "gh", fingerprint: "fp-1" } }),
      invalidate: () => {},
    },
    fetch: (url, init) =>
      new Promise<Response>((resolve, reject) => {
        if (init.signal.aborted) {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
        queued.push({ url, init, resolve });
      }),
  });

  const posted: Array<{ chatId: string; notice: FollowNotice }> = [];
  const follows = new PullRequestFollows({
    now: () => now,
    chatWasAnswering: () => false,
    persist: () => {},
    post: (chatId, notice) => posted.push({ chatId, notice }),
    reader: new PullRequestFollowReader(api, () => now),
  });

  const sha = (digit: string) => digit.repeat(40);
  const etagsFor = (number: number, head: string) => ({
    [`/repos/acme/app/pulls/${number}`]: `W/"pr-${number}"`,
    [`/repos/acme/app/commits/${head}/check-runs?per_page=100&filter=latest`]: `W/"cr-${number}"`,
    [`/repos/acme/app/commits/${head}/status`]: `W/"st-${number}"`,
  });

  // 1. Unchanged 304 Not Modified sweep for 1 PR completes in 1 HTTP RTT wave instead of 3.
  const head1 = sha("a");
  follows.restore([
    {
      ...newFollowRecord({ ...input(1, "chat-1"), now: T0 - 10 * MINUTE }),
      headSha: head1,
      reportedPassSha: head1,
      status: "Checks passed",
      etags: etagsFor(1, head1),
      etagsAt: T0 - 5 * MINUTE,
      lastCheckedAt: T0 - 5 * MINUTE,
      nextCheckAt: T0,
    },
  ]);
  respond = (req) => new Response(null, { status: 304, headers: { etag: req.init.headers["If-None-Match"] ?? 'W/"same"' } });
  waves = 0;
  await flushWavesUntilSettled(follows.kick());
  assert.equal(waves, 1, "unchanged 304 sweep for 1 PR completes in 1 RTT wave");
  assert.equal(posted.length, 0);

  // 2. Active sweep of 3 PRs with 4 reviewers (shared across PRs) and 3 failed jobs completes in <= 6 RTT waves.
  follows.deleteChat("chat-1");
  const heads: Record<number, string> = { 101: sha("b"), 102: sha("c"), 103: sha("d") };
  follows.restore(
    [101, 102, 103].map((number, index) => ({
      ...newFollowRecord({ ...input(number, `chat-${index + 1}`), now: T0 - 10 * MINUTE }),
      headSha: sha(String(index + 1)),
      etags: etagsFor(number, sha(String(index + 1))),
      etagsAt: T0 - 5 * MINUTE,
      lastCheckedAt: T0 - 5 * MINUTE,
      nextCheckAt: T0,
    })),
  );

  const permissionCalls: string[] = [];
  respond = (req) => {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/graphql") {
      const body = JSON.parse(req.init.body ?? "{}") as { variables?: { number?: number } };
      const number = Number(body.variables?.number ?? 101);
      const head = heads[number]!;
      return new Response(
        JSON.stringify({
          data: {
            rateLimit: { limit: 5000, remaining: 4990, cost: 1, resetAt: "2026-10-26T13:00:00Z" },
            viewer: { login: "sambit" },
            repository: {
              nameWithOwner: "acme/app",
              owner: { login: "acme" },
              pullRequest: {
                number,
                title: `PR ${number}`,
                url: `https://github.com/acme/app/pull/${number}`,
                state: "OPEN",
                isDraft: false,
                headRefName: `feat-${number}`,
                baseRefName: "main",
                headRefOid: head,
                author: { login: "sambit" },
                mergeable: "MERGEABLE",
                updatedAt: "2026-10-26T12:00:00Z",
                headRepositoryOwner: { login: "acme" },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: "FAILURE",
                          contexts: {
                            pageInfo: { hasNextPage: false },
                            nodes: [
                              {
                                __typename: "CheckRun",
                                name: `ci-${number}`,
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                                detailsUrl: `https://github.com/acme/app/actions/runs/${number}/job/${number * 10}`,
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
                comments: {
                  nodes: ["rev1", "rev2", "rev3", "rev4"].map((login, idx) => ({
                    id: `c-${number}-${login}`,
                    body: `Finding from ${login} on ${number}`,
                    author: { __typename: "User", login },
                    authorAssociation: idx % 2 === 0 ? "MEMBER" : "COLLABORATOR",
                    createdAt: "2026-10-26T12:00:00Z",
                  })),
                },
                reviews: { nodes: [] },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const permMatch = /\/collaborators\/([^/]+)\/permission$/u.exec(pathname);
    if (permMatch) {
      permissionCalls.push(permMatch[1]!);
      return new Response(JSON.stringify({ permission: "write" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname.endsWith("/logs")) {
      return new Response(`2026-10-26T12:00:00Z failure in ${pathname}\n`, { status: 200 });
    }
    return new Response("{}", { status: 200, headers: { etag: 'W/"changed"' } });
  };

  waves = 0;
  await flushWavesUntilSettled(follows.kick());
  assert.ok(waves <= 6, `expected <= 6 RTT waves, observed ${waves}`);
  assert.deepEqual([...permissionCalls].sort(), ["rev1", "rev2", "rev3", "rev4"], "1 permission lookup per shared reviewer");
  assert.equal(posted.filter((item) => item.notice.notice.title === "A check failed").length, 3);
  assert.equal(posted.filter((item) => /new comments/iu.test(item.notice.notice.title)).length, 3);
});
