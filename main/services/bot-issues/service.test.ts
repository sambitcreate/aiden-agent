import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  BOT_ISSUE_ENTRY_KIND,
  BOT_ISSUE_STATUS_ENTRY_KIND,
  botIssueStatusOf,
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
import { BotAccessRequestStaleError } from "../bot-runtime/bot-access-requests.js";
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
    allowFolder?: import("./service.js").BotIssueServiceActions["allowFolder"];
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
      ...(options.allowFolder ? { allowFolder: options.allowFolder } : {}),
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

const ACCESS_ISSUE = {
  botId: BOT_ID, kind: "access_needed" as const, dedupeKey: "access:folder:/Taxes", title: "Needs Taxes", body: "Prepare a return", actions: [{ kind: "dismiss_access" as const }, { kind: "allow_folder" as const }],
  access: { label: "Taxes", folderPath: "/Taxes", authorization: { policyRevision: "original-rev", requestIds: ["routine:r1:1"], target: "folder" as const, root: "/Taxes", identity: { device: "1", inode: "2" }, choices: ["not_now", "always", "once"] as const } },
};
test("allow_folder claims the saved authorization once, keeps the card open until committed and strips private data", async () => {
  let release!: () => void, called!: () => void;
  const entered = new Promise<void>((resolve) => { called = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: unknown[] = [];
  const app = setup({ allowFolder: async (...args) => { calls.push(args); called(); await gate; return "added"; } });
  const issue = await app.issues.raise(ACCESS_ISSUE);
  assert.equal("access" in issue, false);
  assert.equal(JSON.stringify(app.appends).includes("authorization"), false);
  const first = app.issues.act(BOT_ID, issue.id, { kind: "allow_folder" });
  await entered;
  assert.equal((await app.issues.list(BOT_ID, { open: true })).length, 1, "a crash before commit leaves the decision answerable");
  assert.equal(await app.issues.act(BOT_ID, issue.id, { kind: "allow_folder" }), "not_open");
  release(); assert.equal(await first, "done");
  assert.deepEqual(calls, [[BOT_ID, { folderPath: "/Taxes", authorization: ACCESS_ISSUE.access.authorization }, issue.id]]);
  assert.equal((await app.issues.list(BOT_ID))[0]!.resolution, "fixed");
  assert.equal(await app.issues.act(BOT_ID, issue.id, { kind: "allow_folder" }), "not_open");
  assert.equal((await app.store.read(BOT_ID))[0]!.access?.authorization.policyRevision, "original-rev");
  assert.equal(JSON.stringify(await app.issues.list(BOT_ID)).includes("authorization"), false);
});
test("a failed folder grant leaves the issue open and retry uses the same operation id", async () => {
  let count = 0; const operations: string[] = [];
  const app = setup({ allowFolder: async (_botId, access, operationId) => {
    operations.push(operationId); assert.equal(access.authorization.policyRevision, "original-rev");
    if (++count === 1) throw new Error("saved policy changed"); return "already_allowed";
  } });
  const issue = await app.issues.raise(ACCESS_ISSUE);
  await assert.rejects(app.issues.act(BOT_ID, issue.id, { kind: "allow_folder" }), /saved policy changed/u);
  assert.equal((await app.issues.list(BOT_ID, { open: true })).length, 1);
  assert.equal(await app.issues.act(BOT_ID, issue.id, { kind: "allow_folder" }), "done");
  assert.deepEqual(operations, [issue.id, issue.id]);
});
test("Whole Mac issues offer settings only and cannot run allow_folder", async () => {
  const app = setup({ allowFolder: async () => { throw new Error("must never grant"); } });
  const issue = await app.issues.raise({ ...ACCESS_ISSUE, actions: [{ kind: "open_settings", section: "access" }], access: { label: "your whole Mac", authorization: { policyRevision: "rev1", requestIds: ["routine:r1:1"], target: "whole_mac", root: "/", choices: ["not_now", "once"] } } });
  assert.equal(await app.issues.act(BOT_ID, issue.id, { kind: "allow_folder" }), "invalid");
  await assert.rejects(app.issues.raise({ ...ACCESS_ISSUE, dedupeKey: "bad-access", access: { ...ACCESS_ISSUE.access, folderPath: undefined } }), /persistable folder/u);
  assert.equal((await app.issues.list(BOT_ID, { open: true })).length, 1);
});

function statusEntries(appends: readonly Appended[]) {
  return appends.filter((entry) => entry.kind === BOT_ISSUE_STATUS_ENTRY_KIND).map(entry => ({ ...entry, data: botIssueStatusOf(entry.data) }));
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

test("an access issue's delivery obligation carries its durable audience gate without authorization", async () => {
  const app = setup();
  await app.issues.raise(ACCESS_ISSUE);
  assert.equal(app.deliveries.length, 1);
  assert.equal(app.deliveries[0]!.requiredCapability, "bot:access-requests");
  assert.equal(JSON.stringify(app.deliveries).includes("authorization"), false);
  assert.equal(JSON.stringify(app.deliveries).includes("/Taxes"), false);
  await app.issues.raise(ISSUE);
  assert.equal(app.deliveries[1]!.requiredCapability, undefined);
});

test("access Not now dismisses with status and notification, without grant, stop or snooze", async () => {
  const app = setup({ allowFolder: async () => { throw new Error("must not grant"); } });
  const issue = await app.issues.raise({ ...ACCESS_ISSUE, actions: [{ kind: "dismiss_access" }, { kind: "open_settings", section: "access" }], access: { label: "your whole Mac", authorization: { policyRevision: "rev1", requestIds: ["routine:r1:1"], target: "whole_mac", root: "/", choices: ["not_now", "once"] } } });
  const changes: string[] = []; app.issues.onChange(id => changes.push(id));
  assert.equal(await app.issues.act(BOT_ID, issue.id, { kind: "dismiss_access" }), "done");
  assert.deepEqual(await app.issues.list(BOT_ID, { open: true }), []);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(statusEntries(app.appends).map(entry => entry.data), [{issueId: issue.id, resolution: "dismissed", resolvedAt: 1000}]);
  assert.ok(changes.includes(BOT_ID));
});
test("a changed authorization creates a new immutable issue; a new run alone dedupes", async () => {
  const operations: string[] = [];
  const app = setup({ allowFolder: async (_id, _access, operationId) => { operations.push(operationId); return "added"; } });
  const old = await app.issues.raise(ACCESS_ISSUE);
  const anotherRun = { ...ACCESS_ISSUE, access: { ...ACCESS_ISSUE.access, authorization: { ...ACCESS_ISSUE.access.authorization, requestIds: ["routine:r2:1"] } } };
  assert.equal((await app.issues.raise(anotherRun)).id, old.id);
  const fresh = await app.issues.raise({ ...anotherRun, access: { ...anotherRun.access, authorization: { ...anotherRun.access.authorization, policyRevision: "fresh-rev" } } });
  assert.notEqual(fresh.id, old.id);
  assert.equal((await app.store.read(BOT_ID)).find(row => row.id === old.id)?.access?.authorization.policyRevision, "original-rev");
  assert.equal(await app.issues.act(BOT_ID, old.id, {kind: "allow_folder"}), "not_open");
  assert.equal(await app.issues.act(BOT_ID, fresh.id, {kind: "allow_folder"}), "done");
  assert.deepEqual(operations, [fresh.id]);
});
test("authoritative dismissal wins against later allow; in-flight allow cannot be dismissed mid-publication", async () => {
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; }); let grants = 0;
  const app = setup({ allowFolder: async () => { entered(); await gate; grants++; return "added"; } });
  const first = await app.issues.raise(ACCESS_ISSUE);
  await app.issues.act(BOT_ID, first.id, { kind: "dismiss_access" });
  assert.equal(await app.issues.act(BOT_ID, first.id, {kind:"allow_folder"}), "not_open");
  assert.equal(grants, 0);
  const next = await app.issues.raise(ACCESS_ISSUE);
  const allowing = app.issues.act(BOT_ID, next.id, {kind:"allow_folder"}); await started;
  assert.equal(await app.issues.act(BOT_ID, next.id, {kind:"dismiss_access"}), "not_open");
  release(); await allowing;
  assert.equal((await app.issues.list(BOT_ID)).find(row => row.id === next.id)?.resolution, "fixed");
});
test("issue reads and unrelated raises survive a failed settlement status append", async () => {
  const app = setup();
  const old = await app.issues.raise(ACCESS_ISSUE);
  await app.store.change(BOT_ID, rows => ({ issues: rows.map(row => row.id === old.id ? { ...row, resolvedAt: 2000, resolution: "superseded" as const, statusAppended: false } : row), result: undefined }));
  const restarted = createBotIssueService({ store: app.store, now: () => 3000,
    appendEntry: async (botId, kind, data) => {
      if (kind === BOT_ISSUE_STATUS_ENTRY_KIND) throw new Error("status disk busy");
      app.appends.push({ botId, kind, data });
    },
    funnel: { deliver: async () => "sent" },
    actions: { resumeRoutine: async () => "missing", stopRun: async () => {}, snoozeStall() {}, openSettings() {} },
  });
  assert.deepEqual(await restarted.list(BOT_ID, { open: true }), []);
  const ordinary = await restarted.raise(ISSUE);
  assert.deepEqual((await restarted.list(BOT_ID, { open: true })).map(row => row.id), [ordinary.id]);
  assert.equal((await app.store.read(BOT_ID)).find(row => row.id === old.id)?.statusAppended, false);
  assert.equal(app.appends.some(entry => entry.kind === BOT_ISSUE_ENTRY_KIND && (entry.data as { id: string }).id === ordinary.id), true);
});

test("restart repairs supersession status without withholding replacement and never mutates old private authority", async () => {
  const app = setup(); const old = await app.issues.raise(ACCESS_ISSUE);
  let failStatus = true;
  let reportFailure!: () => void;
  const failed = new Promise<void>(resolve => { reportFailure = resolve; });
  const service = () => createBotIssueService({ store: app.store, now: () => 2000,
    appendEntry: async (botId, kind, data) => { if (kind === BOT_ISSUE_STATUS_ENTRY_KIND && failStatus) throw new Error("status disk busy"); app.appends.push({botId, kind, data}); },
    onError: () => reportFailure(),
    funnel: {deliver: async () => "sent"}, actions: { resumeRoutine: async () => "missing", stopRun: async () => {}, snoozeStall() {}, openSettings() {} } });
  const nextInput = { ...ACCESS_ISSUE, access: { ...ACCESS_ISSUE.access, authorization: {...ACCESS_ISSUE.access.authorization, policyRevision:"rev2"} } };
  const first = service();
  const replacement = await first.raise(nextInput);
  assert.notEqual(replacement.id, old.id);
  // Wait for the failed background attempt before restoring storage.
  await failed;
  failStatus = false;
  const restarted = service();
  const repaired = new Promise<void>(resolve => restarted.onChange(() => resolve()));
  const open = await restarted.list(BOT_ID, {open:true});
  await repaired;
  assert.equal(open.length, 1); assert.notEqual(open[0]!.id, old.id);
  assert.equal(statusEntries(app.appends).some(entry => (entry.data as {issueId:string}).issueId === old.id), true);
  const fresh = await restarted.raise(nextInput); assert.equal(fresh.id, open[0]!.id);
  assert.equal(app.appends.filter(entry => entry.kind === BOT_ISSUE_ENTRY_KIND && (entry.data as {id:string}).id === fresh.id).length, 1);
  assert.equal((await app.store.read(BOT_ID)).find(row=>row.id===old.id)?.access?.authorization.policyRevision, "original-rev");
});

test("listing issues does not wait for a held transcript status write", async () => {
  const app = setup();
  const issue = await app.issues.raise(ISSUE);
  await app.store.change(BOT_ID, rows => ({ issues: rows.map(row => ({ ...row, resolvedAt: 2000, resolution: "fixed" as const, statusAppended: false })), result: undefined }));
  let started!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const restarted = createBotIssueService({ store: app.store, now: () => 3000,
    appendEntry: async () => { started(); await held; },
    funnel: { deliver: async () => "sent" },
    actions: { resumeRoutine: async () => "missing", stopRun: async () => {}, snoozeStall() {}, openSettings() {} },
  });
  const repaired = new Promise<void>(resolve => restarted.onChange(() => resolve()));
  const listing = restarted.list(BOT_ID, { open: true });
  await writing;
  try {
    assert.deepEqual(await listing, []);
    assert.equal((await app.store.read(BOT_ID)).find(row => row.id === issue.id)?.statusAppended, false);
  } finally { release(); }
  await repaired;
  assert.equal((await app.store.read(BOT_ID)).find(row => row.id === issue.id)?.statusAppended, true);
});

test("pending settlement survives retention and restart until its transcript status is repaired", async () => {
  const app = setup();
  const rows = Array.from({length:55},(_,index)=>({...ACCESS_ISSUE,id:`settled-${index}`,createdAt:1000-index,resolvedAt:2000,resolution:"superseded" as const,statusAppended:true}));
  await app.store.change(BOT_ID,()=>({issues:[...rows,{...ACCESS_ISSUE,id:"pending-status",createdAt:1,resolvedAt:2000,resolution:"superseded" as const,statusAppended:false}],result:undefined}));
  const reopened = createBotIssueStore({profileDir:()=>app.profile});
  assert.equal((await reopened.read(BOT_ID)).some(row=>row.id==="pending-status"&&row.statusAppended===false),true);
  const statuses: unknown[]=[];
  const restarted=createBotIssueService({store:reopened,now:()=>3000,appendEntry:async(_id,kind,data)=>{if(kind===BOT_ISSUE_STATUS_ENTRY_KIND)statuses.push(botIssueStatusOf(data));},funnel:{deliver:async()=>"sent"},actions:{resumeRoutine:async()=>"missing",stopRun:async()=>{},snoozeStall(){},openSettings(){}}});
  const repaired = new Promise<void>(resolve => restarted.onChange(() => resolve()));
  await restarted.list(BOT_ID);
  await repaired;
  assert.deepEqual(statuses,[{issueId:"pending-status",resolution:"superseded",resolvedAt:2000}]);
  assert.equal((await reopened.read(BOT_ID)).length,50);
});

test("known stale folder action supersedes only its old issue while a fresh authorization remains answerable", async () => {
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const app=setup({allowFolder:async(_id,access)=>{if(access.authorization.policyRevision==="original-rev"){entered();await gate;throw new BotAccessRequestStaleError("policy changed");}return"added";}});
  const old=await app.issues.raise(ACCESS_ISSUE);
  const action=app.issues.act(BOT_ID,old.id,{kind:"allow_folder"});
  const refused=assert.rejects(action,BotAccessRequestStaleError); await started;
  const fresh=await app.issues.raise({...ACCESS_ISSUE,access:{...ACCESS_ISSUE.access,authorization:{...ACCESS_ISSUE.access.authorization,policyRevision:"fresh-rev"}}});
  release();await refused;
  assert.deepEqual((await app.issues.list(BOT_ID,{open:true})).map(issue=>issue.id),[fresh.id]);
  assert.equal(await app.issues.act(BOT_ID,fresh.id,{kind:"allow_folder"}),"done");
});

for (const kind of ["dismiss_access", "allow_folder"] as const) {
  for (const ownStatusFails of [false, true]) {
    test(`${kind} settles despite unrelated pending status failure; own status failure ${ownStatusFails}`, async () => {
      const app = setup();
      const current = await app.issues.raise(ACCESS_ISSUE);
      // A newer unrelated row would be visited first by a global repair.
      const other = await app.issues.raise({ ...ISSUE, dedupeKey: "other-pending" });
      await app.store.change(BOT_ID, rows => ({
        issues: rows.map(row => row.id === other.id ? { ...row, resolvedAt: 2000, resolution: "fixed" as const, statusAppended: false } : row),
        result: undefined,
      }));
      let storageRecovered = false;
      let grants = 0;
      const errors: unknown[] = [];
      const service = createBotIssueService({
        store: app.store, now: () => 3000,
        appendEntry: async (botId, entryKind, data) => {
          const id = (data as { issueId?: string }).issueId;
          if (!storageRecovered && entryKind === BOT_ISSUE_STATUS_ENTRY_KIND && (id === other.id || ownStatusFails)) throw new Error("status disk busy");
          app.appends.push({ botId, kind: entryKind, data });
        },
        onError: error => { errors.push(error); },
        funnel: { deliver: async () => "sent" },
        actions: { allowFolder: async () => { grants++; return "added"; }, resumeRoutine: async () => "missing", stopRun: async () => { throw new Error("must not stop"); }, snoozeStall() { throw new Error("must not snooze"); }, openSettings() {} },
      });
      const changes: string[] = [];
      service.onChange(id => { changes.push(id); });
      if (ownStatusFails) await assert.rejects(service.act(BOT_ID, current.id, { kind }), /status disk busy/u);
      else assert.equal(await service.act(BOT_ID, current.id, { kind }), "done");
      const rows = await app.store.read(BOT_ID);
      const settled = rows.find(row => row.id === current.id)!;
      assert.equal(settled.resolution, kind === "dismiss_access" ? "dismissed" : "fixed");
      assert.equal(settled.resolvedAt, 3000);
      assert.equal(settled.statusAppended, !ownStatusFails);
      assert.equal(rows.find(row => row.id === other.id)?.statusAppended, false);
      assert.ok(changes.includes(BOT_ID), "a durable settlement notifies the host even if its transcript write fails");
      assert.equal(grants, kind === "allow_folder" ? 1 : 0);
      assert.deepEqual(await service.list(BOT_ID, { open: true }), []);
      assert.equal(await service.act(BOT_ID, current.id, { kind }), "not_open");
      assert.equal(grants, kind === "allow_folder" ? 1 : 0, "retry cannot regrant");
      // Flush the one active background attempt. Failure never schedules itself.
      await new Promise<void>(resolve => setImmediate(resolve));
      const before = errors.length;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(errors.length, before, "no hot automatic repair loop");
      storageRecovered = true;
      const repaired = new Promise<void>(resolve => service.onChange(() => resolve()));
      await service.list(BOT_ID);
      await repaired;
      // Wait for the entire serialized repair, including both markers.
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await app.store.read(BOT_ID)).every(row => row.statusAppended === true)) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.equal((await app.store.read(BOT_ID)).every(row => row.statusAppended === true), true);
      assert.equal(statusEntries(app.appends).filter(entry => (entry.data as { issueId: string }).issueId === current.id).length, 1);
    });
  }
}

for (const kind of ["dismiss_access", "allow_folder"] as const) {
  test(`${kind} claims during a held unrelated repair and writes its own status after that repair fails`, async () => {
    const app = setup();
    const current = await app.issues.raise(ACCESS_ISSUE);
    const other = await app.issues.raise(ISSUE);
    await app.store.change(BOT_ID, rows => ({ issues: rows.map(row => row.id === other.id ? { ...row, resolvedAt: 2000, resolution: "fixed" as const, statusAppended: false } : row), result: undefined }));
    let entered!: () => void, release!: () => void, claimed!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const changed = new Promise<void>(resolve => { claimed = resolve; });
    let active = 0, maximumActive = 0, grants = 0;
    const service = createBotIssueService({
      store: app.store, now: () => 3000,
      appendEntry: async (botId, entryKind, data) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if ((data as { issueId: string }).issueId === other.id) {
            entered(); await held; throw new Error("unrelated status failed");
          }
          app.appends.push({ botId, kind: entryKind, data });
        } finally { active--; }
      },
      funnel: { deliver: async () => "sent" },
      actions: { allowFolder: async () => { grants++; return "added"; }, resumeRoutine: async () => "missing", stopRun: async () => {}, snoozeStall() {}, openSettings() {} },
    });
    service.onChange(() => claimed());
    const acting = service.act(BOT_ID, current.id, { kind });
    try {
      await started;
      await changed;
      assert.equal((await app.store.read(BOT_ID)).find(row => row.id === current.id)?.resolvedAt, 3000, "claim and host notification happen while unrelated transcript work is held");
      assert.equal(statusEntries(app.appends).length, 0, "strict status effects remain serialized");
      release();
      assert.equal(await acting, "done", "an unrelated rejection does not reject our own successful append");
      assert.equal(maximumActive, 1);
      assert.equal(grants, kind === "allow_folder" ? 1 : 0);
      assert.equal((await app.store.read(BOT_ID)).find(row => row.id === current.id)?.statusAppended, true);
      assert.equal((await app.store.read(BOT_ID)).find(row => row.id === other.id)?.statusAppended, false);
    } finally { release(); }
  });
}
