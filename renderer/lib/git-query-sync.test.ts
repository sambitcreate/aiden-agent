import assert from "node:assert/strict";
import test from "node:test";
import type { QueryObserverOptions } from "@tanstack/react-query";

// TanStack treats a process without `window` as a server and never schedules
// refetch intervals, so the stub must exist before query-core is evaluated.
(globalThis as { window?: unknown }).window ??= {};
const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { gitPullRequestStatusQueryOptions, gitSafetyPoll, GIT_SAFETY_POLL_MS, queryKeys } = await import("./queries.js");
const { subscribeGitQuerySync, TOOL_RESULT_REFRESH_MS } = await import("./git-query-sync.js");

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function harness(t: test.TestContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.mount();
  const handlers = new Map<string, (payload: unknown) => void>();
  let activate = () => {};
  const stop = subscribeGitQuerySync(
    client,
    (channel, handler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    { onWindowActivated: (listener) => { activate = listener; return () => {}; } },
  );
  const unsubscribers: (() => void)[] = [];
  t.after(() => {
    stop();
    for (const unsubscribe of unsubscribers) unsubscribe();
    client.clear();
  });
  const reads = new Map<string, number>();
  const mount = (key: readonly unknown[], options: Partial<QueryObserverOptions<unknown, Error>> = {}) => {
    const name = JSON.stringify(key);
    reads.set(name, 0);
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => { reads.set(name, (reads.get(name) ?? 0) + 1); return reads.get(name); },
      staleTime: 5_000,
      ...options,
    } as QueryObserverOptions<unknown, Error>);
    unsubscribers.push(observer.subscribe(() => {}));
    return () => reads.get(name) ?? 0;
  };
  const emit = (channel: string, payload: unknown) => handlers.get(channel)?.(payload);
  return { client, mount, emit, activate: () => activate() };
}

test("a repository change refreshes that workspace's mounted Git reads only", async (t) => {
  const h = harness(t);
  const info = h.mount(queryKeys.git("ws-1"));
  const review = h.mount(queryKeys.gitReview("ws-1"));
  const push = h.mount(queryKeys.gitPushCapability("ws-1"));
  const branches = h.mount(queryKeys.gitBranches("ws-1"));
  const comparison = h.mount(queryKeys.gitComparison("ws-1", "origin/main"));
  const pullRequest = h.mount(queryKeys.gitPullRequestStatus("ws-1"), { staleTime: 60_000 });
  const otherInfo = h.mount(queryKeys.git("ws-2"));
  const unrelated = h.mount(queryKeys.chats);
  await flush();

  h.emit("git:changed", { workspaceId: "ws-1", generation: 1 });
  await flush();
  assert.deepEqual(
    [info(), review(), push(), branches(), comparison()],
    [2, 2, 2, 2, 2],
  );
  assert.equal(otherInfo(), 1);
  assert.equal(unrelated(), 1);
  // A fresh pull-request answer is not re-requested from GitHub on every index write.
  assert.equal(pullRequest(), 1);

  h.emit("git:changed", { generation: 2 });
  await flush();
  assert.equal(info(), 2, "a payload without a workspace is ignored");
});

test("a settled chat refreshes working-tree reads but not remote or branch reads", async (t) => {
  const h = harness(t);
  const info = h.mount(queryKeys.git("ws-1"));
  const review = h.mount(queryKeys.gitReview("ws-1"));
  const push = h.mount(queryKeys.gitPushCapability("ws-1"));
  const branches = h.mount(queryKeys.gitBranches("ws-1"));
  await flush();
  h.emit("chats:settled", { chatId: "c", workspaceId: "ws-1" });
  await flush();
  assert.deepEqual([info(), review(), push(), branches()], [2, 2, 1, 1]);
});

test("a burst of agent tool results refreshes working-tree reads at most once per window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t);
  const review = h.mount(queryKeys.gitReview("ws-1"));
  await flush();

  h.emit("chat:tool", { streamId: "s", phase: "start", toolName: "edit" });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(review(), 1, "tool starts do not change files yet");

  for (let i = 0; i < 3; i++) h.emit("chat:tool", { streamId: "s", phase: "result", toolName: "edit" });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(review(), 2);

  h.emit("chat:tool", { streamId: "s", phase: "result", toolName: "write" });
  h.emit("chat:tool", { streamId: "s", phase: "error", toolName: "bash" });
  t.mock.timers.tick(TOOL_RESULT_REFRESH_MS - 1);
  await flush();
  assert.equal(review(), 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(review(), 3, "results inside the window are coalesced into one trailing refresh");
});

test("safety-net polling stops while the window is inactive and resumes when it is activated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let focused = true;
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = { visibilityState: "visible", hasFocus: () => focused };
  t.after(() => { globals.document = previous; });

  const h = harness(t);
  const info = h.mount(queryKeys.git("ws-1"), { refetchInterval: gitSafetyPoll(true) });
  await flush();
  t.mock.timers.tick(GIT_SAFETY_POLL_MS);
  await flush();
  assert.equal(info(), 2, "polls while the window is active");

  focused = false;
  // The tick already scheduled still lands once; afterwards the interval is off.
  for (let minute = 0; minute < 5; minute++) {
    t.mock.timers.tick(GIT_SAFETY_POLL_MS);
    await flush();
  }
  assert.equal(info(), 3);

  focused = true;
  h.activate();
  await flush();
  assert.equal(info(), 4, "activation refreshes the stale read");
  t.mock.timers.tick(GIT_SAFETY_POLL_MS);
  await flush();
  assert.equal(info(), 5, "and restarts the safety-net interval");

  // An event-driven read while inactive leaves fresh data and no interval.
  focused = false;
  h.emit("chats:settled", { chatId: "c", workspaceId: "ws-1" });
  await flush();
  assert.equal(info(), 6);
  focused = true;
  h.activate();
  await flush();
  assert.equal(info(), 6, "fresh data is not re-read on activation");
  t.mock.timers.tick(GIT_SAFETY_POLL_MS);
  await flush();
  assert.equal(info(), 7, "but polling still resumes");
});

test("pull-request status polls GitHub every five minutes and repository changes refresh it at most once a minute", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = { visibilityState: "visible", hasFocus: () => true };
  t.after(() => { globals.document = previous; });

  const h = harness(t);
  const { queryKey, refetchInterval, staleTime, enabled } = gitPullRequestStatusQueryOptions("ws-1");
  const status = h.mount(queryKey, { refetchInterval, staleTime, enabled } as Partial<QueryObserverOptions<unknown, Error>>);
  await flush();
  const minute = async (n = 1) => {
    for (let i = 0; i < n; i++) { t.mock.timers.tick(60_000); await flush(); }
  };

  await minute(4);
  assert.equal(status(), 1, "no GitHub call in the first four idle minutes");
  await minute();
  assert.equal(status(), 2, "the five-minute safety poll");

  h.emit("git:changed", { workspaceId: "ws-1", generation: 1 });
  await flush();
  assert.equal(status(), 2, "a change right after a fresh answer does not call GitHub again");
  await minute();
  t.mock.timers.tick(1_000);
  await flush();
  h.emit("git:changed", { workspaceId: "ws-1", generation: 2 });
  await flush();
  assert.equal(status(), 3, "a change once the answer is a minute old refreshes it");
});

test("a GitHub rate-limit pause holds pull-request polls and change refreshes until it ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = { visibilityState: "visible", hasFocus: () => true };
  t.after(() => { globals.document = previous; });

  const h = harness(t);
  const start = Date.now();
  const pullRequest = { number: 7, title: "Change", url: "https://github.com/acme/app/pull/7", state: "open", headBranch: "a", baseBranch: "main", checks: [] };
  const retryAt = start + 20 * 60_000;
  let calls = 0;
  const { queryKey, refetchInterval, staleTime, structuralSharing } = gitPullRequestStatusQueryOptions("ws-1");
  const observer = new QueryObserver(h.client, {
    queryKey,
    queryFn: async () => {
      calls += 1;
      return calls === 2 ? { availability: "rate-limited", retryAt, message: "paused" } : { availability: "ready", pullRequest };
    },
    refetchInterval,
    staleTime,
    structuralSharing,
  } as QueryObserverOptions<unknown, Error>);
  const unsubscribe = observer.subscribe(() => {});
  t.after(unsubscribe);
  await flush();
  const minute = async (n = 1) => {
    for (let i = 0; i < n; i++) { t.mock.timers.tick(60_000); await flush(); }
  };

  await minute(5);
  assert.equal(calls, 2, "the five-minute poll hit the rate limit");
  const paused = observer.getCurrentResult().data as { availability: string; pullRequest?: { number: number } };
  assert.equal(paused.availability, "rate-limited");
  assert.equal(paused.pullRequest?.number, 7, "the last pull request stays visible");

  await minute(2);
  h.emit("git:changed", { workspaceId: "ws-1", generation: 1 });
  h.activate();
  await flush();
  await minute(12);
  assert.equal(calls, 2, "no change event, activation or poll asks GitHub during the pause");

  await minute(2);
  assert.equal(calls, 3, "polling resumes once the pause is over");
});
