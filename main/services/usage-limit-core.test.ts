import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyUsageLimit,
  decideUsageLimitWait,
  formatUsageLimitTime,
  parseUsageLimitEntries,
  usageLimitGiveUpNote,
  usageLimitKeys,
  usageLimitMaxWaitMs,
  UsageLimitGate,
  USAGE_LIMIT_REFUSE_MS,
  type UsageLimitEntry,
  type UsageLimitGateClock,
  type UsageLimitTicket,
  type UsageLimitVerdict,
  usageLimitSafeErrorText,
} from "./usage-limit-core.js";

const NOW = Date.UTC(2026, 9, 26, 15, 0, 0);

/** Whether a ticket lets its request send as the test of a held limit. */
function isTest(ticket: UsageLimitTicket | undefined): boolean {
  return ticket?.kind === "send" && ticket.testing;
}

test("rejections that wait read their reset time from headers before text", () => {
  const anthropic429 = classifyUsageLimit({
    errorMessage:
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    observation: { status: 429, headers: { "retry-after": "20" } },
    now: NOW,
  });
  assert.deepEqual(anthropic429, { kind: "wait", scope: "model", resetAt: NOW + 20_000 });

  const openAiTokens = classifyUsageLimit({
    errorMessage:
      "429 Rate limit reached for gpt-4.1 in organization org-x on tokens per min (TPM): Limit 30000, Used 29500, Requested 1200. Please try again in 2.5s.",
    now: NOW,
  });
  assert.deepEqual(openAiTokens, { kind: "wait", scope: "model", resetAt: NOW + 2_500 });

  const overloaded = classifyUsageLimit({
    errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    now: NOW,
  });
  assert.deepEqual(overloaded, { kind: "wait", scope: "model" });

  // pi-ai's message when a provider asks for a longer delay than it retries itself.
  const longDelay = classifyUsageLimit({ errorMessage: "Server requested 140s retry delay (max: 60s)", now: NOW });
  assert.deepEqual(longDelay, { kind: "wait", scope: "model", resetAt: NOW + 140_000 });

  const google = classifyUsageLimit({
    errorMessage:
      '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}',
    now: NOW,
  });
  assert.deepEqual(google, { kind: "wait", scope: "model", resetAt: NOW + 37_000 });
});

test("subscription windows wait for the whole account, and windows of days do not wait", () => {
  const codexText = classifyUsageLimit({
    errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.",
    now: NOW,
  });
  assert.deepEqual(codexText, { kind: "wait", scope: "account", resetAt: NOW + 42 * 60_000 });

  const claudeSession = classifyUsageLimit({
    errorMessage: "429 rate_limit_error",
    observation: {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": String((NOW + 3 * 3_600_000) / 1_000),
      },
    },
    now: NOW,
  });
  assert.deepEqual(claudeSession, { kind: "wait", scope: "account", resetAt: NOW + 3 * 3_600_000 });

  const claudeWeek = classifyUsageLimit({
    errorMessage: "429 rate_limit_error",
    observation: {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-7d-status": "rejected",
        "anthropic-ratelimit-unified-7d-reset": String((NOW + 4 * 86_400_000) / 1_000),
      },
    },
    now: NOW,
  });
  assert.deepEqual(claudeWeek, { kind: "stop", reason: "long-window", resetAt: NOW + 4 * 86_400_000 });

  const codexWeekly = classifyUsageLimit({
    errorMessage: "429 usage_limit_reached",
    observation: {
      status: 429,
      headers: {
        "x-codex-secondary-used-percent": "100",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "86400",
      },
    },
    now: NOW,
  });
  assert.deepEqual(codexWeekly, { kind: "stop", reason: "long-window", resetAt: NOW + 86_400_000 });

  const plan = classifyUsageLimit({ errorMessage: "usage_limit_reached: The usage limit has been reached", now: NOW });
  assert.deepEqual(plan, { kind: "wait", scope: "account", plan: true });

  const daily = classifyUsageLimit({
    errorMessage: "429 Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel-FreeTier",
    now: NOW,
  });
  assert.equal(daily.kind, "stop");
});

test("billing, bad requests and other failures never wait", () => {
  assert.deepEqual(
    classifyUsageLimit({
      errorMessage: "429 You exceeded your current quota, please check your plan and billing details.",
      observation: { status: 429, headers: { "x-ratelimit-reset-requests": "120ms" } },
      now: NOW,
    }),
    { kind: "stop", reason: "billing" },
  );
  assert.deepEqual(classifyUsageLimit({ errorMessage: "402 Payment Required", now: NOW }), { kind: "stop", reason: "billing" });
  assert.deepEqual(
    classifyUsageLimit({ errorMessage: '400 {"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}', now: NOW }),
    { kind: "none" },
  );
  assert.deepEqual(classifyUsageLimit({ errorMessage: "401 invalid x-api-key", now: NOW }), { kind: "none" });
  assert.deepEqual(classifyUsageLimit({ errorMessage: "500 Internal server error", now: NOW }), { kind: "none" });
  assert.deepEqual(classifyUsageLimit({ errorMessage: "fetch failed", now: NOW }), { kind: "none" });
  // A reset time with nothing that reads as a limit is not a limit.
  assert.deepEqual(classifyUsageLimit({ errorMessage: "Please try again in 5s", now: NOW }), { kind: "none" });
});

test("the provider-free text an isolated helper sends reads back as the same verdict", () => {
  const verdicts: UsageLimitVerdict[] = [
    { kind: "wait", scope: "model", resetAt: NOW + 42_000 },
    { kind: "wait", scope: "model" },
    { kind: "wait", scope: "account", resetAt: NOW + 3 * 3_600_000 },
    { kind: "wait", scope: "account", plan: true },
    { kind: "stop", reason: "long-window", resetAt: NOW + 2 * 86_400_000 },
    { kind: "stop", reason: "billing" },
  ];
  for (const verdict of verdicts) {
    const text = usageLimitSafeErrorText(verdict, NOW);
    assert.ok(text);
    assert.deepEqual(classifyUsageLimit({ errorMessage: text, now: NOW }), verdict, text);
  }
  assert.equal(usageLimitSafeErrorText({ kind: "none" }, NOW), undefined);
});

test("waits follow the reset, back off without one, and give up past the longest wait", () => {
  const key = "anthropic";
  const maxWaitMs = usageLimitMaxWaitMs(6);
  const random = () => 0;
  const reset = decideUsageLimitWait({
    verdict: { kind: "wait", scope: "account", resetAt: NOW + 30 * 60_000 },
    key,
    providerId: "anthropic",
    maxWaitMs,
    now: NOW,
    random,
  });
  assert.equal(reset.kind, "wait");
  assert.equal(reset.kind === "wait" && reset.entry.nextTryAt, NOW + 30 * 60_000 + 5_000);

  const beyond = decideUsageLimitWait({
    verdict: { kind: "wait", scope: "account", resetAt: NOW + 7 * 3_600_000 },
    key,
    providerId: "anthropic",
    maxWaitMs,
    now: NOW,
  });
  assert.deepEqual(beyond, { kind: "give-up", reason: "beyond-max-wait", resetAt: NOW + 7 * 3_600_000 });

  // Without a time: 15 s, 30 s, 1 min, 2 min, 5 min, then 10 min, for at most 30 minutes.
  let existing: UsageLimitEntry | undefined;
  let at = NOW;
  const delays: number[] = [];
  for (;;) {
    const decision = decideUsageLimitWait({
      verdict: { kind: "wait", scope: "model" },
      ...(existing ? { existing } : {}),
      key,
      providerId: "openai",
      modelId: "gpt",
      maxWaitMs,
      now: at,
    });
    if (decision.kind === "give-up") {
      assert.equal(decision.reason, "backoff-exhausted");
      break;
    }
    delays.push(decision.entry.nextTryAt - at);
    at = decision.entry.nextTryAt;
    existing = decision.entry;
  }
  assert.deepEqual(delays, [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000]);
  assert.ok(at - NOW <= 30 * 60_000);

  assert.deepEqual(
    decideUsageLimitWait({ verdict: { kind: "wait", scope: "model" }, key, providerId: "x", maxWaitMs: usageLimitMaxWaitMs(0), now: NOW }),
    { kind: "give-up", reason: "off" },
  );

  // A limit nobody tried for a while starts over instead of counting the old wait.
  const stale = decideUsageLimitWait({
    verdict: { kind: "wait", scope: "model" },
    existing: { key, providerId: "openai", since: NOW - 5 * 3_600_000, nextTryAt: NOW - 3_600_000, attempts: 6 },
    key,
    providerId: "openai",
    maxWaitMs,
    now: NOW,
  });
  assert.equal(stale.kind === "wait" && stale.entry.since, NOW);
});

test("give-up notes say when the limit resets", () => {
  const note = usageLimitGiveUpNote(
    { kind: "give-up", reason: "beyond-max-wait", resetAt: NOW + 7 * 3_600_000 },
    { maxWaitMs: usageLimitMaxWaitMs(6), now: NOW, locale: "en-US", timeZone: "UTC" },
  );
  assert.equal(note, "Aiden stopped waiting: the limit resets at 10:00 PM, after the longest wait you set (6 hours).");
  assert.equal(
    formatUsageLimitTime(NOW + 2 * 86_400_000, NOW, { locale: "en-US", timeZone: "UTC" }),
    "Wednesday at 3:00 PM",
  );
  assert.equal(formatUsageLimitTime(NOW + 9 * 86_400_000, NOW, { locale: "en-US", timeZone: "UTC" }), "Nov 4 at 3:00 PM");
  assert.equal(usageLimitGiveUpNote({ kind: "give-up", reason: "billing" }, { maxWaitMs: 1, now: NOW }), "");
});

test("the saved limits keep only well-formed, recent entries", () => {
  const good = { key: "anthropic", providerId: "anthropic", since: NOW - 60_000, nextTryAt: NOW + 60_000, attempts: 1, resetAt: NOW + 50_000 };
  const parsed = parseUsageLimitEntries(
    {
      version: 1,
      entries: [
        good,
        { ...good, key: "old", since: NOW - 26 * 3_600_000 },
        { ...good, key: "bad", attempts: -1 },
        { ...good, key: 7 },
        "nonsense",
      ],
    },
    NOW,
  );
  assert.deepEqual(parsed, [good]);
  assert.deepEqual(parseUsageLimitEntries({ version: 2, entries: [good] }, NOW), []);
  assert.deepEqual(parseUsageLimitEntries(null, NOW), []);
});

class FakeClock implements UsageLimitGateClock {
  time = NOW;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private nextTimer = 1;
  now = () => this.time;
  random = () => 0;
  setTimer = (callback: () => void, ms: number) => {
    const id = this.nextTimer++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function entry(key: string, nextTryAt: number, extra: Partial<UsageLimitEntry> = {}): UsageLimitEntry {
  return { key, providerId: "anthropic", since: NOW, nextTryAt, attempts: 1, ...extra };
}

test("one waiting request tests the limit; the rest leave one at a time after it clears", async () => {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  const keys = usageLimitKeys("anthropic", "opus");
  gate.hold(entry(keys.account, NOW + 60_000));

  const tickets: Record<string, UsageLimitTicket> = {};
  const order: string[] = [];
  for (const id of ["a", "b", "c"]) {
    void gate
      .acquire([keys.account, keys.model], { owner: { kind: "chat", id }, providerLabel: "Claude", modelId: "opus" })
      .then((ticket) => {
        tickets[id] = ticket;
        order.push(id);
      });
  }
  await settle();
  assert.deepEqual(
    gate.waits().map((wait) => [wait.owner.id, wait.testing, wait.nextTryAt]),
    [
      ["a", true, NOW + 60_000],
      ["b", false, NOW + 60_000],
      ["c", false, NOW + 60_000],
    ],
  );

  await clock.advance(60_000);
  assert.deepEqual(order, ["a"]);
  assert.deepEqual(tickets.a, { kind: "send", id: (tickets.a as { id: number }).id, key: keys.account, testing: true });
  assert.equal(gate.waits().find((wait) => wait.owner.id === "a")?.trying, true);

  // Nobody else sends while the test is out.
  await clock.advance(10 * 60_000);
  assert.deepEqual(order, ["a"]);

  gate.answered(tickets.a);
  assert.equal(gate.entry(keys.account), undefined);
  await clock.advance(999);
  assert.deepEqual(order, ["a"]);
  await clock.advance(1);
  assert.deepEqual(order, ["a", "b"]);
  await clock.advance(1_000);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(gate.waits(), []);
});

test("a test that meets the limit again keeps its place, and a stopped test hands over", async () => {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  const { account, model } = usageLimitKeys("openai", "gpt");
  const keys = [account, model];
  gate.hold(entry(model, NOW + 15_000));
  const options = (id: string, signal: AbortSignal) => ({
    owner: { kind: "chat" as const, id },
    providerLabel: "OpenAI",
    modelId: "gpt",
    signal,
  });
  const stopA = new AbortController();
  let first: UsageLimitTicket | undefined;
  void gate.acquire(keys, options("a", stopA.signal)).then((ticket) => (first = ticket));
  let second: UsageLimitTicket | undefined;
  void gate.acquire(keys, options("b", new AbortController().signal)).then((ticket) => (second = ticket));
  await clock.advance(15_000);
  assert.equal(isTest(first), true);
  assert.equal(second, undefined);

  // The test met the limit again: it waits as the test once more, b stays in line.
  gate.hold(entry(model, clock.now() + 30_000, { attempts: 2 }));
  let again: UsageLimitTicket | undefined;
  void gate.acquire(keys, { ...options("a", stopA.signal), previous: first }).then((ticket) => (again = ticket));
  await settle();
  assert.deepEqual(
    gate
      .waits()
      .map((wait) => [wait.owner.id, wait.testing])
      .sort(),
    [
      ["a", true],
      ["b", false],
    ],
  );

  // The person stops chat a: b becomes the test and sends at the same try time.
  stopA.abort();
  await settle();
  assert.deepEqual(again, { kind: "aborted" });
  assert.equal(gate.waits().find((wait) => wait.owner.id === "b")?.testing, true);
  await clock.advance(29_999);
  assert.equal(second, undefined);
  await clock.advance(1);
  assert.equal(isTest(second), true);
});

test("Retry now tests at once, at most every 30 seconds", async () => {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  gate.hold(entry("anthropic", NOW + 3_600_000));
  let ticket: UsageLimitTicket | undefined;
  void gate
    .acquire(["anthropic"], { owner: { kind: "bot", id: "bot-1" }, providerLabel: "Claude", modelId: "opus" })
    .then((value) => (ticket = value));
  await settle();
  assert.equal(gate.retryNow({ kind: "chat", id: "bot-1" }), false);
  assert.equal(gate.retryNow({ kind: "bot", id: "bot-1" }), true);
  await settle();
  assert.equal(isTest(ticket), true);

  gate.hold(entry("anthropic", clock.now() + 3_600_000, { attempts: 2 }));
  let next: UsageLimitTicket | undefined;
  void gate
    .acquire(["anthropic"], { owner: { kind: "bot", id: "bot-1" }, providerLabel: "Claude", modelId: "opus", previous: ticket })
    .then((value) => (next = value));
  await settle();
  assert.equal(gate.retryNow({ kind: "bot", id: "bot-1" }), false);
  await clock.advance(30_000);
  assert.equal(gate.retryNow({ kind: "bot", id: "bot-1" }), true);
  await settle();
  assert.equal(isTest(next), true);
});

test("a given-up limit turns its line and new requests away for a while", async () => {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  gate.hold(entry("anthropic", NOW + 60_000));
  const options = (id: string) => ({ owner: { kind: "chat" as const, id }, providerLabel: "Claude", modelId: "opus" });
  let tester: UsageLimitTicket | undefined;
  let waiting: UsageLimitTicket | undefined;
  void gate.acquire(["anthropic"], options("a")).then((value) => (tester = value));
  void gate.acquire(["anthropic"], options("b")).then((value) => (waiting = value));
  await clock.advance(60_000);
  gate.refuse({ key: "anthropic", providerId: "anthropic" }, NOW + 9 * 3_600_000, tester);
  await settle();
  assert.deepEqual(waiting, { kind: "refused", resetAt: NOW + 9 * 3_600_000 });
  assert.deepEqual(await gate.acquire(["anthropic"], options("c")), { kind: "refused", resetAt: NOW + 9 * 3_600_000 });

  // After the refusal runs out, the next request tests the limit again.
  await clock.advance(USAGE_LIMIT_REFUSE_MS);
  const later = await gate.acquire(["anthropic"], options("d"));
  assert.equal(isTest(later), true);
});

test("held limits survive a restart through their saved entries", async () => {
  const clock = new FakeClock();
  const before = new UsageLimitGate(clock);
  before.hold(entry("anthropic", NOW + 20 * 60_000, { resetAt: NOW + 20 * 60_000 }));
  const saved = JSON.parse(JSON.stringify({ version: 1, entries: before.snapshot() })) as unknown;

  clock.time = NOW + 5 * 60_000;
  const after = new UsageLimitGate(clock);
  after.load(parseUsageLimitEntries(saved, clock.now()));
  let ticket: UsageLimitTicket | undefined;
  void after
    .acquire(["anthropic"], { owner: { kind: "bot", id: "b" }, providerLabel: "Claude", modelId: "opus" })
    .then((value) => (ticket = value));
  await clock.advance(14 * 60_000);
  assert.equal(ticket, undefined);
  await clock.advance(60_000);
  assert.equal(isTest(ticket), true);
});
