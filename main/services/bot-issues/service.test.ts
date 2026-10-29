import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  BOT_ISSUE_ENTRY_KIND,
  BOT_ISSUE_STATUS_ENTRY_KIND,
  type BotIssue,
  type BotIssueAction,
} from "../../../renderer/shared/bot-issues.js";
import type { BotDeliveryInput } from "../bot-delivery/funnel.js";
import {
  createBotIssueService,
  resolveDeletedRoutineIssues,
  type BotIssueResumeResult,
  type BotIssueService,
} from "./service.js";
import { createBotIssueStore } from "./store.js";

const BOT_ID = "bot:ada";
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-issues-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ISSUE = {
  botId: BOT_ID,
  kind: "routine_failed" as const,
  dedupeKey: "routine:r1:failed",
  title: "Ada couldn’t finish your morning briefing",
  body: "The model was unavailable, so nothing ran.",
  routineId: "r1",
  actions: [
    { kind: "resume_routine", routineId: "r1" },
    { kind: "stop_run" },
  ] satisfies BotIssueAction[],
};

interface Appended {
  botId: string;
  kind: string;
  data: unknown;
}

function setup(
  options: {
    /** Fail this many `appendEntry` calls before the next one lands. */
    appendFailures?: number;
    /** Fail this many funnel deliveries before the next one lands. */
    deliveryFailures?: number;
    /** What the routine service says when Resume is pressed. */
    resume?: () => Promise<BotIssueResumeResult>;
    /** Hold chat writes until the test releases them, so a raise can start mid-attempt. */
    holdAppends?: boolean;
  } = {},
) {
  const profile = tempProfile();
  const store = createBotIssueStore({ profileDir: () => profile });
  const appends: Appended[] = [];
  const deliveries: BotDeliveryInput[] = [];
  const calls: string[] = [];
  let clock = 1_000;
  let appendFailures = options.appendFailures ?? 0;
  let deliveryFailures = options.deliveryFailures ?? 0;
  let markAppending!: () => void;
  const appending = new Promise<void>((resolve) => {
    markAppending = resolve;
  });
  let releaseAppends = () => {};
  const heldAppends =
    options.holdAppends === true
      ? new Promise<void>((resolve) => {
          releaseAppends = resolve;
        })
      : undefined;
  const issues: BotIssueService = createBotIssueService({
    store,
    appendEntry: async (botId, kind, data) => {
      if (appendFailures > 0) {
        appendFailures -= 1;
        throw new Error("the conversation could not be written");
      }
      if (heldAppends) {
        markAppending();
        await heldAppends;
      }
      appends.push({ botId, kind, data });
    },
    funnel: {
      deliver: async (input) => {
        if (deliveryFailures > 0) {
          deliveryFailures -= 1;
          throw new Error("the funnel could not reach the person");
        }
        deliveries.push(input);
        return "sent";
      },
    },
    actions: {
      resumeRoutine: async (botId, id) => {
        calls.push(`resume:${botId}:${id}`);
        return options.resume ? await options.resume() : "resumed";
      },
      stopRun: async (botId) => {
        calls.push(`stop:${botId}`);
      },
      snoozeStall: (botId) => {
        calls.push(`snooze:${botId}`);
      },
      openSettings: (botId, section) => {
        calls.push(`settings:${botId}:${section}`);
      },
    },
    now: () => clock,
  });
  return {
    issues,
    store,
    profile,
    appends,
    deliveries,
    calls,
    /** Resolves when a held chat write has started. */
    appending,
    /** Lets every held chat write finish. */
    releaseAppends() {
      releaseAppends();
    },
    tick(by = 1) {
      clock += by;
      return clock;
    },
  };
}

function statusEntries(appends: readonly Appended[]) {
  return appends.filter((entry) => entry.kind === BOT_ISSUE_STATUS_ENTRY_KIND);
}

test("raise dedupes by key and appends one chat entry", async () => {
  const harness = setup();
  const first = await harness.issues.raise(ISSUE);
  const again = await harness.issues.raise(ISSUE);

  assert.deepEqual(again, first, "the same open issue comes back unchanged");
  assert.equal(harness.appends.length, 1, "one chat entry, not two");
  assert.equal(harness.appends[0]!.botId, BOT_ID);
  assert.equal(harness.appends[0]!.kind, BOT_ISSUE_ENTRY_KIND);
  assert.deepEqual(harness.appends[0]!.data, first);
  assert.equal(first.resolvedAt, undefined);
  assert.equal(first.resolution, undefined);
  assert.deepEqual(await harness.issues.list(BOT_ID, { open: true }), [first]);
});

test("resolve appends a status entry and frees the key for a new issue", async () => {
  const harness = setup();
  const first = await harness.issues.raise(ISSUE);
  const resolvedAt = harness.tick(5);

  assert.equal(await harness.issues.resolve(BOT_ID, ISSUE.dedupeKey, "fixed"), true);
  assert.deepEqual(statusEntries(harness.appends), [
    { botId: BOT_ID, kind: BOT_ISSUE_STATUS_ENTRY_KIND, data: { issueId: first.id, resolution: "fixed", resolvedAt } },
  ]);
  assert.deepEqual(await harness.issues.list(BOT_ID, { open: true }), []);

  harness.tick(5);
  const next = await harness.issues.raise(ISSUE);
  assert.notEqual(next.id, first.id, "the same key opens a new issue once the old one settled");
  assert.equal(next.resolution, undefined);
  assert.equal((await harness.issues.list(BOT_ID)).length, 2, "the settled issue stays for the record");
  assert.equal((await harness.issues.list(BOT_ID, { open: true })).length, 1);
  assert.equal(await harness.issues.resolve(BOT_ID, "routine:other:failed", "dismissed"), false);
});

test("act resume_routine resumes then resolves as fixed", async () => {
  const harness = setup();
  const issue = await harness.issues.raise(ISSUE);
  const resolvedAt = harness.tick(3);

  assert.equal(
    await harness.issues.act(BOT_ID, issue.id, { kind: "resume_routine", routineId: "r1" }),
    "done",
  );
  assert.deepEqual(harness.calls, [`resume:${BOT_ID}:r1`], "the routine service is asked once");
  assert.deepEqual(statusEntries(harness.appends), [
    { botId: BOT_ID, kind: BOT_ISSUE_STATUS_ENTRY_KIND, data: { issueId: issue.id, resolution: "fixed", resolvedAt } },
  ]);
  assert.deepEqual(await harness.issues.list(BOT_ID, { open: true }), []);
});

test("act on a resolved issue returns not_open and does nothing", async () => {
  const harness = setup();
  const issue = await harness.issues.raise(ISSUE);
  await harness.issues.resolve(BOT_ID, ISSUE.dedupeKey, "dismissed");
  const appendsBefore = harness.appends.length;
  harness.calls.length = 0;

  assert.equal(await harness.issues.act(BOT_ID, issue.id, { kind: "stop_run" }), "not_open");
  assert.deepEqual(harness.calls, [], "no host action runs for a settled issue");
  assert.equal(harness.appends.length, appendsBefore, "nothing more is written");
});

test("act refuses an action the issue does not offer", async () => {
  const harness = setup();
  const issue = await harness.issues.raise(ISSUE);
  const appendsBefore = harness.appends.length;

  assert.equal(
    await harness.issues.act(BOT_ID, issue.id, { kind: "resume_routine", routineId: "r2" }),
    "invalid",
  );
  assert.equal(await harness.issues.act(BOT_ID, issue.id, { kind: "open_chat" }), "invalid");
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.appends.length, appendsBefore);
  assert.equal((await harness.issues.list(BOT_ID, { open: true })).length, 1);
});

test("keep waiting snoozes the stall and settles the issue as dismissed", async () => {
  const harness = setup();
  const issue = await harness.issues.raise({ ...ISSUE, kind: "run_stalled", actions: [{ kind: "keep_waiting" }] });
  const resolvedAt = harness.tick(2);

  assert.equal(await harness.issues.act(BOT_ID, issue.id, { kind: "keep_waiting" }), "done");
  assert.deepEqual(harness.calls, [`snooze:${BOT_ID}`]);
  assert.deepEqual(statusEntries(harness.appends), [
    { botId: BOT_ID, kind: BOT_ISSUE_STATUS_ENTRY_KIND, data: { issueId: issue.id, resolution: "dismissed", resolvedAt } },
  ]);
});

test("raising past 8 open supersedes the oldest", async () => {
  const harness = setup();
  const raised: BotIssue[] = [];
  for (let index = 0; index < 9; index += 1) {
    harness.tick();
    raised.push(await harness.issues.raise({ ...ISSUE, dedupeKey: `routine:r${index}:failed` }));
  }

  const open = await harness.issues.list(BOT_ID, { open: true });
  assert.equal(open.length, 8, "at most eight wait for the person");
  assert.equal(open.some((issue) => issue.id === raised[0]!.id), false, "the oldest left");
  assert.deepEqual(
    open.map((issue) => issue.dedupeKey),
    raised
      .slice(1)
      .map((issue) => issue.dedupeKey)
      .reverse(),
    "the newest eight stay open, newest first",
  );

  const settled = (await harness.issues.list(BOT_ID)).find((issue) => issue.id === raised[0]!.id);
  assert.equal(settled?.resolution, "superseded");
  assert.equal(settled?.resolvedAt, raised[8]!.createdAt);
  assert.deepEqual(
    statusEntries(harness.appends).map((entry) => entry.data),
    [{
      issueId: raised[0]!.id,
      resolution: "superseded",
      resolvedAt: raised[8]!.createdAt,
    }],
    "the card settles quietly instead of staying actionable",
  );
});

test("raise delivers once through the funnel with class issue", async () => {
  const harness = setup();
  const issue = await harness.issues.raise(ISSUE);
  await harness.issues.raise(ISSUE);

  assert.deepEqual(harness.deliveries, [
    {
      botId: BOT_ID,
      class: "issue",
      dedupeKey: `issue:${issue.id}`,
      title: ISSUE.title,
      body: ISSUE.body,
      status: "info",
    },
  ]);
});

test("a removed Bot leaves no issues behind", async () => {
  const harness = setup();
  await harness.issues.raise(ISSUE);
  await harness.issues.forgetBot(BOT_ID);
  assert.deepEqual(await harness.issues.list(BOT_ID), []);
});

test("raise keeps the title and body within the card's limits", async () => {
  const harness = setup();
  const issue = await harness.issues.raise({
    ...ISSUE,
    title: `  ${"t".repeat(100)}  `,
    body: "b".repeat(400),
  });
  assert.equal([...issue.title].length, 80, "the title is capped, not cut mid-character");
  assert.equal(issue.title.endsWith("…"), true);
  assert.equal([...issue.body].length, 280);
  assert.equal(harness.deliveries[0]!.title, issue.title, "the banner shows the same words");
  assert.equal(harness.deliveries[0]!.body, issue.body);
});

test("raise refuses an issue it could not read back, and stores nothing", async () => {
  const harness = setup();
  const unusable = [
    { ...ISSUE, dedupeKey: "k".repeat(401) },
    { ...ISSUE, routineId: "r/1" },
    { ...ISSUE, kind: "made_up" as never },
    { ...ISSUE, actions: [{ kind: "resume_routine", routineId: "r/1" }] as never },
  ];
  for (const input of unusable) {
    await assert.rejects(harness.issues.raise(input), /can’t be stored/u, JSON.stringify(input));
  }

  assert.deepEqual(await harness.issues.list(BOT_ID), [], "a row the reader would drop is never written");
  assert.deepEqual(harness.appends, []);
  assert.deepEqual(harness.deliveries, []);

  const issue = await harness.issues.raise(ISSUE);
  assert.equal(issue.dedupeKey, ISSUE.dedupeKey, "the key is still free for a usable raise");
});

test("a raise repairs the chat entry and banner a failed attempt left unwritten", async () => {
  const harness = setup({ appendFailures: 1 });
  await assert.rejects(harness.issues.raise(ISSUE));
  assert.equal(harness.appends.length, 0, "the failed write left no card");
  assert.equal(harness.deliveries.length, 0, "and no banner");

  const issue = await harness.issues.raise(ISSUE);
  assert.deepEqual(harness.appends.map((entry) => entry.data), [issue], "the retry writes the one card");
  assert.deepEqual(harness.deliveries.map((delivery) => delivery.dedupeKey), [`issue:${issue.id}`]);

  await harness.issues.raise(ISSUE);
  assert.equal(harness.appends.length, 1, "a repaired raise never doubles the card");
  assert.equal(harness.deliveries.length, 1, "or the banner");
});

test("a raise retries delivery the funnel never took", async () => {
  const harness = setup({ deliveryFailures: 1 });
  await assert.rejects(harness.issues.raise(ISSUE));
  assert.equal(harness.appends.length, 1, "the card is already durable");
  assert.equal(harness.deliveries.length, 0);

  const issue = await harness.issues.raise(ISSUE);
  assert.equal(harness.appends.length, 1, "the card is not appended twice");
  assert.deepEqual(harness.deliveries.map((delivery) => delivery.dedupeKey), [`issue:${issue.id}`]);

  await harness.issues.raise(ISSUE);
  assert.equal(harness.deliveries.length, 1, "and the retry is not retried again");
});

test("two raises of the same key in flight write one card and one banner", async () => {
  const harness = setup({ holdAppends: true });

  // The first raise is durable but still waiting to write its chat card. A
  // second raise inside that window used to read the row with its side-effect
  // flags still unset and repeat both the card and the banner.
  const first = harness.issues.raise(ISSUE);
  await harness.appending;
  const second = harness.issues.raise(ISSUE);

  harness.releaseAppends();
  const [opened, again] = await Promise.all([first, second]);

  assert.deepEqual(again, opened, "both callers see the one issue");
  assert.equal(harness.appends.length, 1, "one chat entry, not two");
  assert.deepEqual(
    harness.deliveries.map((delivery) => delivery.dedupeKey),
    [`issue:${opened.id}`],
    "one banner, not two",
  );
  assert.deepEqual(await harness.issues.list(BOT_ID, { open: true }), [opened]);

  // The in-flight entry is gone once the attempt settled, so a later raise
  // still repairs a failure instead of returning the finished promise.
  await harness.issues.raise(ISSUE);
  assert.equal(harness.appends.length, 1, "a settled raise never doubles the card");
  assert.equal(harness.deliveries.length, 1, "or the banner");
});

test("two concurrent answers run the host action once", async () => {
  const harness = setup();
  const issue = await harness.issues.raise(ISSUE);

  const answers = await Promise.all([
    harness.issues.act(BOT_ID, issue.id, { kind: "resume_routine", routineId: "r1" }),
    harness.issues.act(BOT_ID, issue.id, { kind: "stop_run" }),
  ]);

  assert.deepEqual(answers.sort(), ["done", "not_open"], "the second answer finds the issue already taken");
  assert.deepEqual(harness.calls, [`resume:${BOT_ID}:r1`], "only the winning answer ran");
  assert.equal(statusEntries(harness.appends).length, 1, "and it settled the issue once");
  assert.deepEqual(await harness.issues.list(BOT_ID, { open: true }), []);
});

test("resume settles as dismissed when the routine no longer exists", async () => {
  const harness = setup({ resume: async () => "missing" });
  const issue = await harness.issues.raise(ISSUE);
  const resolvedAt = harness.tick(4);

  assert.equal(await harness.issues.act(BOT_ID, issue.id, { kind: "resume_routine", routineId: "r1" }), "done");
  assert.deepEqual(statusEntries(harness.appends), [
    { botId: BOT_ID, kind: BOT_ISSUE_STATUS_ENTRY_KIND, data: { issueId: issue.id, resolution: "dismissed", resolvedAt } },
  ]);
  assert.deepEqual(await harness.issues.list(BOT_ID, { open: true }), [], "the card can no longer fail forever");
});

test("deleting a routine settles the issues that asked about it", async () => {
  const harness = setup();
  const paused = await harness.issues.raise({
    ...ISSUE,
    kind: "routine_paused",
    dedupeKey: "routine:r1:paused",
    actions: [],
  });
  await harness.issues.raise({ ...ISSUE, dedupeKey: "routine:r2:failed", routineId: "r2" });

  assert.equal(await resolveDeletedRoutineIssues(harness.issues, BOT_ID, "r1"), 1);
  const open = await harness.issues.list(BOT_ID, { open: true });
  assert.deepEqual(open.map((issue) => issue.dedupeKey), ["routine:r2:failed"], "only deleted r1 settled");
  const settled = (await harness.issues.list(BOT_ID)).find((issue) => issue.id === paused.id);
  assert.equal(settled?.resolution, "dismissed");
  assert.deepEqual(statusEntries(harness.appends).map((entry) => entry.data), [
    { issueId: paused.id, resolution: "dismissed", resolvedAt: settled?.resolvedAt },
  ]);
});
