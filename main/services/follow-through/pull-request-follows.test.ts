import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PULL_REQUEST_FOLLOWS_PER_CHAT } from "../../../renderer/shared/follow-through.js";
import type { FollowReadResult } from "./pull-request-follow-github.js";
import type { FollowedCheck, FollowNotice, PullRequestObservation } from "./pull-request-follow.js";
import { PullRequestFollows, type StartFollowInput } from "./pull-request-follows.js";

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
  const follows = new PullRequestFollows({
    reader: {
      read: async (follow) => answer(follow),
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
    setAnswer: (next: typeof answer) => {
      answer = next;
    },
    advance: (ms: number) => {
      now += ms;
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
