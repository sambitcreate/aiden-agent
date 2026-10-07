import assert from "node:assert/strict";
import test from "node:test";
import {
  formatGitHubPausedUntil,
  githubPausedUntil,
  keepPullRequestWhilePaused,
  pausedPollInterval,
} from "./github-pause.js";

const NOW = new Date(2026, 9, 7, 15, 0).getTime();
const MINUTE = 60_000;

test("a pause lasts until GitHub's retry time and no longer", () => {
  assert.equal(githubPausedUntil({ availability: "rate-limited", retryAt: NOW + MINUTE }, NOW), NOW + MINUTE);
  assert.equal(githubPausedUntil({ availability: "rate-limited", retryAt: NOW - 1 }, NOW), undefined);
  assert.equal(githubPausedUntil({ availability: "rate-limited" }, NOW), undefined);
  assert.equal(githubPausedUntil({ availability: "error", retryAt: NOW + MINUTE }, NOW), undefined);
  assert.equal(githubPausedUntil(undefined, NOW), undefined);
});

test("polling waits out a pause longer than its interval", () => {
  const fiveMinutes = 5 * MINUTE;
  const paused = { availability: "rate-limited", retryAt: NOW + 15 * MINUTE };
  const next = NOW + pausedPollInterval(paused, NOW, fiveMinutes);
  assert.ok(next > paused.retryAt, "the next poll lands after the pause");
  assert.ok(next <= paused.retryAt + 5_000);
  assert.equal(pausedPollInterval({ availability: "rate-limited", retryAt: NOW + MINUTE }, NOW, fiveMinutes), fiveMinutes);
  assert.equal(pausedPollInterval({ availability: "ready" }, NOW, fiveMinutes), fiveMinutes);
});

test("a paused answer keeps the last pull request; other answers replace it", () => {
  const pullRequest = { number: 7 };
  const previous = { availability: "ready", pullRequest };
  assert.deepEqual(keepPullRequestWhilePaused(previous, { availability: "rate-limited", retryAt: NOW }), {
    availability: "rate-limited",
    retryAt: NOW,
    pullRequest,
  });
  assert.deepEqual(keepPullRequestWhilePaused(previous, { availability: "no-pull-request" }), {
    availability: "no-pull-request",
  });
  assert.deepEqual(keepPullRequestWhilePaused(undefined, { availability: "rate-limited" }), { availability: "rate-limited" });
});

test("the pause is worded with the local time, and the day when it is not today", () => {
  const today = formatGitHubPausedUntil(NOW + 45 * MINUTE, NOW, "en-US");
  assert.match(today, /^GitHub paused until 3:45\s?PM$/u);
  const tomorrow = formatGitHubPausedUntil(NOW + 10 * 60 * MINUTE, NOW, "en-US");
  assert.match(tomorrow, /^GitHub paused until Thu 1:00\s?AM$/u);
});
