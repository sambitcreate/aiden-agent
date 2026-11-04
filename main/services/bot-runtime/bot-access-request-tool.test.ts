import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBotRegistry, type BotRegistry } from "./bot-extension.js";
import { createBotHarnessHost, type BotHarnessHost } from "./harness-host.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "./test-support/faux.js";
import { botAccessRequestCandidate, BOT_ACCESS_REQUEST_MEMO } from "./bot-access-request-tool.js";
import { createBotAccessRequests } from "./bot-access-requests.js";
import { createBotAccessAuthorizer } from "./bot-access-authorization.js";
import { createBotRunAccess } from "./bot-run-access.js";
import { resolveBotAccessTarget } from "./bot-access-target.js";
import { buildBotFileTools, type BotFileToolLocation } from "../bot-file-tool-router.js";
import type { BotToolCall } from "./tool-adapter.js";
import type { BotIssue } from "../../../renderer/shared/bot-issues.js";
import { createBotIssueService } from "../bot-issues/service.js";
import { createBotIssueStore } from "../bot-issues/store.js";

const BOT = "ada";
async function fixture(t: import("node:test").TestContext) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bot-access-tool-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, "Taxes"),
    botHome = path.join(home, "BotHome"),
    privateRoot = path.join(home, "Private");
  await fs.mkdir(root);
  await fs.mkdir(botHome);
  await fs.mkdir(privateRoot);
  await fs.writeFile(path.join(root, "report.txt"), "original");
  const requests = createBotAccessRequests(),
    runAccess = createBotRunAccess({ now: Date.now });
  let revision = "rev1",
    ids: readonly (string | undefined)[] = ["r1"],
    scoped = true;
  let holdAfterAnswer = false,
    answerHeld = false;
  let fixed: BotFileToolLocation[] = [{ id: "home", label: "Bot folder", root: botHome }];
  const raised: Array<Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">> = [];
  const issues = createBotIssueService({
    store: createBotIssueStore({ profileDir: () => privateRoot }),
    appendEntry: async () => {},
    funnel: { deliver: async () => "sent" },
    actions: {
      resumeRoutine: async () => "missing",
      stopRun: async () => {},
      snoozeStall() {},
      openSettings() {},
    },
    now: Date.now,
  });
  const roots: { id: string; folderPath: string }[] = [];
  const resolveTarget = (requested: string) =>
    resolveBotAccessTarget(requested, {
      homeDirectory: () => home,
      privateRoots: () => [privateRoot],
      approvedRoots: async () => roots,
    });
  const currentLocations = async () => {
    if (!scoped) throw new Error("access changed");
    return fixed;
  };
  const candidate = botAccessRequestCandidate(BOT, {
    requests: {
      request: async (input) => {
        const answer = await requests.request(input);
        if (holdAfterAnswer) {
          answerHeld = true;
          await new Promise<never>((_resolve, reject) => {
            if (input.signal?.aborted) reject(input.signal.reason);
            else
              input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
                once: true,
              });
          });
        }
        return answer;
      },
    },
    runAccess,
    resolveTarget,
    currentLocations,
    policyRevision: async () => revision,
    raiseIssue: async (input) => {
      raised.push(input);
      return issues.raise(input);
    },
  });
  const memos = new Map<string, unknown>();
  const call = (controller = new AbortController()): BotToolCall => ({
    callId: "call-1",
    taskId: "task-1",
    signal: controller.signal,
    runRequestIds: async () => ids,
    assertRunActive: async () => {
      if (!ids.length) throw new Error("No active input");
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    entries: async () => [],
    submissions: async () => [],
    appendEntry: async () => {},
    memo: async <T>(name: string, value: T) => {
      if (!memos.has(name)) memos.set(name, value);
      return memos.get(name) as T;
    },
  });
  const authorize = createBotAccessAuthorizer({
    now: Date.now,
    audienceId: "desktop",
    runAccess,
    resolveTarget,
    revalidate: async (_id, expected) => {
      if (!scoped || revision !== expected) throw new Error("policy changed");
    },
    grantFolder: async (input, owner) => {
      owner.assertCurrent();
      assert.equal(input.expectedRevision, revision);
      roots.push({ id: input.rootId ?? "root_taxes", folderPath: input.folderPath });
      revision = "rev2";
      return revision;
    },
    changed() {},
  });
  const execute = (
    value: unknown = { path: root, why: "Prepare a return" },
    controller?: AbortController,
  ) => candidate.bind!(call(controller)).execute("call-1", value);
  const answer = async (choice: "once" | "always" | "not_now") =>
    requests.answer(BOT, requests.pending()[0]!.waitId, choice, authorize);
  const fileTool = (name: string) =>
    buildBotFileTools({
      defaultLocation: { id: "home", label: "Bot folder", root: botHome },
      lateLocation: {
        id: "run.access",
        label: "Allowed for this task",
        resolve: async () => runAccess.location(BOT, ids, revision),
      },
    }).find((tool) => tool.name === name)!;
  return {
    home,
    root,
    botHome,
    privateRoot,
    requests,
    runAccess,
    candidate,
    execute,
    answer,
    raised,
    issues,
    fileTool,
    resolveTarget,
    memos,
    revision: () => revision,
    setRevision: (v: string) => {
      revision = v;
    },
    setIds: (v: readonly (string | undefined)[]) => {
      ids = v;
    },
    setScoped: (v: boolean) => {
      scoped = v;
    },
    setFixed: (v: BotFileToolLocation[]) => {
      fixed = v;
    },
    holdAnswers: (value: boolean) => {
      holdAfterAnswer = value;
    },
    answerHeld: () => answerHeld,
  };
}
test("asks once, authorizes the attempt and the same run can change its folder", async (t) => {
  const app = await fixture(t),
    result = app.execute();
  await waitFor(() => app.requests.pending().length === 1);
  const id = app.requests.pending()[0]!.waitId;
  assert.equal(await app.answer("once"), "answered");
  assert.deepEqual((await result).details, { target: "folder", label: "Taxes", outcome: "once" });
  await app
    .fileTool("write_file")
    .execute("write", { location: "run.access", path: "report.txt", content: "changed" });
  assert.equal(await fs.readFile(path.join(app.root, "report.txt"), "utf8"), "changed");
  assert.equal((await app.execute()).details?.outcome, "already_allowed");
  app.runAccess.revokeOwner(BOT, { kind: "access", id });
  assert.equal(app.runAccess.location(BOT, ["r1"], app.revision()), undefined);
  assert.deepEqual(Object.keys(app.memos.get(BOT_ACCESS_REQUEST_MEMO) as object), ["requestId"]);
});
test("Always uses the answer's validated publication revision without a second grant", async (t) => {
  const app = await fixture(t),
    result = app.execute();
  await waitFor(() => app.requests.pending().length === 1);
  await app.answer("always");
  assert.equal((await result).details?.outcome, "always");
  assert.equal(app.runAccess.location(BOT, ["r1"], "rev2")?.root, app.root);
  assert.equal(app.revision(), "rev2");
});
test("Whole Mac offers Allow once only", async (t) => {
  const app = await fixture(t),
    result = app.execute({ path: "whole_mac", why: "Find the project" });
  await waitFor(() => app.requests.pending().length === 1);
  assert.deepEqual(app.requests.pending()[0]!.choices, ["not_now", "once"]);
  await app.answer("once");
  assert.equal((await result).details?.outcome, "once");
  assert.equal(app.runAccess.location(BOT, ["r1"], "rev1")?.root, "/");
});
test("unattended routine, Telegram, Bot request/reply and joined runs raise issues without cards", async (t) => {
  for (const ids of [
    ["routine:t1:1"],
    ["tg:1"],
    ["bot:ada:1:00112233-4455-4677-8899-aabbccddeeff"],
    ["botreply:00112233-4455-4677-8899-aabbccddeeff"],
    ["r1", "tg:1"],
  ]) {
    const app = await fixture(t);
    app.setIds(ids);
    assert.equal((await app.execute()).details?.outcome, "asked_later");
    assert.equal(app.requests.pending().length, 0);
    assert.equal(app.raised.length, 1);
    assert.equal(app.raised[0]!.kind, "access_needed");
    assert.deepEqual(app.raised[0]!.actions, [{ kind: "allow_folder" }]);
    assert.equal(app.raised[0]!.access!.authorization.policyRevision, "rev1");
    app.raised.length = 0;
    await app.execute({ path: "whole_mac", why: "Need files" });
    assert.deepEqual(app.raised[0]!.actions, [{ kind: "open_settings", section: "access" }]);
    assert.equal(app.raised[0]!.access!.folderPath, undefined);
  }
});
test("Not now suppresses another card for the same run but does not affect a later run", async (t) => {
  const app = await fixture(t),
    first = app.execute();
  await waitFor(() => app.requests.pending().length === 1);
  await app.answer("not_now");
  await first;
  assert.equal((await app.execute()).details?.outcome, "declined_earlier");
  assert.equal(app.requests.pending().length, 0);
  app.setIds(["r2"]);
  const next = app.execute();
  await waitFor(() => app.requests.pending().length === 1);
  await app.answer("not_now");
  await next;
});

test("an unattended request for a long canonical path persists one bounded deduplicated issue", async (t) => {
  const app = await fixture(t);
  const root = path.join(
    app.home,
    ...Array.from({ length: 6 }, (_, index) => `nested-${index}-` + "x".repeat(65)),
  );
  await fs.mkdir(root, { recursive: true });
  app.setIds(["routine:task:1"]);
  assert.equal(
    (await app.execute({ path: root, why: "Prepare a return" })).details?.outcome,
    "asked_later",
  );
  assert.equal(
    (await app.execute({ path: root, why: "Prepare a return" })).details?.outcome,
    "asked_later",
  );
  assert.equal((await app.issues.list(BOT, { open: true })).length, 1);
  assert.equal(app.requests.pending().length, 0);
});
test("independent write authority needs no card; a read grant needs a separate write approval and survives Not now", async (t) => {
  for (const choice of ["once", "not_now"] as const) {
    const app = await fixture(t),
      stat = await fs.stat(app.root, { bigint: true });
    app.runAccess.grant(BOT, {
      requestIds: ["r1"],
      target: "folder",
      key: app.root,
      root: app.root,
      label: "Taxes",
      identity: { device: String(stat.dev), inode: String(stat.ino) },
      policyRevision: "rev1",
      access: "read",
      owner: { kind: "plan", id: "plan-1" },
      grantedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const waiting = app.execute();
    await waitFor(() => app.requests.pending().length === 1);
    assert.equal(app.runAccess.location(BOT, ["r1"], "rev1")?.access, "read");
    await assert.rejects(
      app
        .fileTool("write_file")
        .execute("w", { location: "run.access", path: "report.txt", content: "changed" }),
      /reading this folder only/u,
    );
    await app.answer(choice);
    await waiting;
    const read = await app
      .fileTool("read_file")
      .execute("r", { location: "run.access", path: "report.txt" });
    assert.match(JSON.stringify(read.content), /original/u);
    if (choice === "once") {
      app.runAccess.revokeOwner(BOT, { kind: "plan", id: "plan-1" });
      await app
        .fileTool("write_file")
        .execute("w", { location: "run.access", path: "report.txt", content: "changed" });
      assert.equal(await fs.readFile(path.join(app.root, "report.txt"), "utf8"), "changed");
    } else {
      assert.equal(app.runAccess.location(BOT, ["r1"], "rev1")?.access, "read");
      await assert.rejects(
        app.fileTool("edit_file").execute("e", {
          location: "run.access",
          path: "report.txt",
          old_string: "original",
          new_string: "changed",
        }),
        /reading this folder only/u,
      );
    }
  }
  const app = await fixture(t);
  app.setFixed([{ id: "taxes", label: "Taxes", root: app.root }]);
  assert.equal((await app.execute()).details?.outcome, "already_allowed");
  assert.equal(app.requests.pending().length, 0);
});
test("Stop withdraws; stale policy, inode replacement, Files off and newly unattended ownership grant nothing", async (t) => {
  for (const race of ["policy", "inode", "off", "unattended", "stop"] as const) {
    const app = await fixture(t),
      controller = new AbortController(),
      waiting = app.execute(undefined, controller);
    const rejected = race === "stop" ? assert.rejects(waiting, /Stop/u) : undefined;
    await waitFor(() => app.requests.pending().length === 1);
    if (race === "policy") app.setRevision("rev-changed");
    if (race === "inode") {
      await fs.rename(app.root, app.root + "old");
      await fs.mkdir(app.root);
    }
    if (race === "off") app.setScoped(false);
    if (race === "unattended") app.setIds(["r1", "routine:task:1"]);
    if (race === "stop") {
      controller.abort(new Error("Stop"));
      await rejected;
    } else {
      await assert.rejects(app.answer("once"), /changed|attended/u);
      assert.equal(app.requests.pending().length, 1);
      await app.answer("not_now");
      await waiting;
    }
    assert.equal(app.runAccess.location(BOT, ["r1"], app.revision()), undefined);
  }
});
test("invalid params and private/root targets never raise an issue or a card", async (t) => {
  const app = await fixture(t);
  for (const value of [
    { path: app.root, why: " " },
    { path: app.root, why: "x".repeat(401) },
    { path: app.root, why: "reason", authorize: true },
    { path: "/" + "é".repeat(2048), why: "reason" },
  ])
    await assert.rejects(app.execute(value));
  for (const target of ["/", "relative", app.privateRoot, path.join(app.home, "missing")]) {
    const result = await app.execute({ path: target, why: "reason" });
    assert.equal((result as { isError?: boolean }).isError, true);
  }
  assert.equal(app.raised.length, 0);
  assert.equal(app.requests.pending().length, 0);
});
test("real harness cannot call request_access from nested codemode", async (t) => {
  const app = await fixture(t);
  const read = buildBotFileTools({
    defaultLocation: { id: "home", label: "Bot folder", root: app.botHome },
  })[0]!;
  const registry = createBotRegistry(
    BOT,
    recordingDeps({
      tools: [
        { ...app.candidate, replay: "safe" },
        { tool: read, replay: "safe" },
      ],
    }),
  );
  await registry.refresh();
  const faux = createFauxModels([
    fauxAssistantMessage(
      [
        fauxToolCall("codemode", {
          code: `return await tools.request_access(${JSON.stringify({ path: app.root, why: "reason" })});`,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: faux.models }, ctx);
  registry.attachHarness(harness);
  try {
    const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
    await (await root.submit({ type: "input", content: "try", requestId: "r1" }, ctx)).wait(ctx);
    const result = (await root.context(ctx)).entries.find(
      (entry) => entry.kind === ToolResultEntry.kind,
    );
    assert.match(
      JSON.stringify(result?.model),
      /request_access.*(?:not|unknown|function)|(?:not|unknown).*request_access/iu,
    );
    assert.equal(app.requests.pending().length, 0);
    assert.equal(app.raised.length, 0);
  } finally {
    await harness.close(ctx);
  }
});
test("Allow once then quit before durable result commit requires a fresh decision on real Resume", async (t) => {
  const app = await fixture(t),
    profileDir = path.join(app.home, "profile");
  const open = async (models: ReturnType<typeof createFauxModels>) => {
    let registry: BotRegistry | undefined;
    const host = (await createBotHarnessHost({
      profileDir,
      models: models.models,
      buildRegistry: (botId) =>
        (registry = createBotRegistry(
          botId,
          recordingDeps({ tools: [{ ...app.candidate, replay: "safe" }] }),
        )),
    })) as BotHarnessHost;
    const opened = await host.open(BOT);
    await registry!.refresh();
    return { ...opened, host };
  };
  const before = await open(
    createFauxModels([
      fauxAssistantMessage([fauxToolCall("request_access", { path: app.root, why: "reason" })], {
        stopReason: "toolUse",
      }),
    ]),
  );
  await before.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  app.holdAnswers(true);
  await before.conversation.submit({ type: "input", content: "request", requestId: "r1" }, ctx);
  await waitFor(() => app.requests.pending().length === 1);
  const oldId = app.requests.pending()[0]!.waitId;
  await app.answer("once");
  await waitFor(app.answerHeld);
  assert.equal(app.runAccess.location(BOT, ["r1"], "rev1")?.root, app.root);
  await before.host.shutdown();
  app.runAccess.clearAll();
  app.holdAnswers(false);
  assert.equal(app.requests.pending().length, 0);
  const after = await open(createFauxModels([fauxAssistantMessage("done")]));
  try {
    const [submission] = (await after.harness.inspect(ctx)).submissions;
    after.harness.resume();
    await waitFor(() => app.requests.pending().length === 1);
    const id = app.requests.pending()[0]!.waitId;
    assert.notEqual(id, oldId);
    assert.equal(await app.requests.answer(BOT, oldId, "once", async () => {}), "not_waiting");
    await app.answer("not_now");
    const resumed = await after.harness.submission(submission!.id, ctx);
    assert.ok(resumed);
    assert.equal((await resumed.wait(ctx)).status, "done");
    assert.equal(app.runAccess.location(BOT, ["r1"], "rev1"), undefined);
  } finally {
    await after.host.shutdown();
  }
});
