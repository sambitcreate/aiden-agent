import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { runDesignMdWorker } from "./lint-client.js";
import type { DesignAppRoots } from "./locate.js";
import { DesignMdOffers } from "./offers.js";
import { DesignMdReader } from "./reader.js";
import { designMdOfferSentence } from "./status.js";
import { createDesignMdTurn, DESIGN_MODE_SECTION, withDesignModeSection } from "./turn.js";

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A linter stand-in: each line starting `warn` is one warning, each `error` one error. */
const countingRun = (async (request: { content: string }) => {
  const lines = request.content.split("\n");
  const warnings = lines.filter((line) => line.startsWith("warn")).length;
  const errors = lines.filter((line) => line.startsWith("error")).length;
  return {
    ok: true,
    result: { summary: { errors, warnings, infos: 0 }, findings: [], sections: ["Overview"], omitted: [], symbols: [], tailwindConfig: null },
  };
}) as unknown as typeof runDesignMdWorker;

/** The two apps the turn describes, as app detection would find them. */
const twoApps: DesignAppRoots = async () => ({ roots: ["apps/web", "apps/admin"], more: 0 });

/** A workspace with two apps, `apps/web` with a DESIGN.md and `apps/admin` without one. */
async function monorepo(t: test.TestContext) {
  const workspace = await tempDir(t, "aiden-design-md-turn-");
  const userData = await tempDir(t, "aiden-design-md-turn-data-");
  for (const app of ["apps/web", "apps/admin"]) await fs.mkdir(path.join(workspace, app), { recursive: true });
  await fs.writeFile(path.join(workspace, "apps/web/DESIGN.md"), "---\nname: Web\n---\nwarn one\nwarn two\n");
  return { workspace, userData };
}

function turnFor(
  setup: { workspace: string; userData: string },
  options: {
    offerable?: boolean;
    askOffered?: boolean;
    reader?: ConstructorParameters<typeof DesignMdReader>[0];
    report?: (event: "design_md_drafted", props: { source: "app" }) => void;
    log?: (message: string, error?: unknown) => void;
    offers?: DesignMdOffers;
    appRoots?: DesignAppRoots;
    budgetMs?: number;
  } = {},
) {
  const offers = options.offers ?? new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") });
  return {
    offers,
    turn: createDesignMdTurn({
      workspaceRoot: setup.workspace,
      reader: new DesignMdReader({ run: countingRun, ...options.reader }),
      offers,
      appRoots: options.appRoots ?? twoApps,
      ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
      offerable: options.offerable ?? true,
      askOffered: options.askOffered ?? true,
      ...(options.report ? { report: options.report } : {}),
      ...(options.log ? { log: options.log } : {}),
      draftFor: async () => "---\nname: Draft\n---\n## Overview\n",
    }),
  };
}

const callTool = async (turn: ReturnType<typeof createDesignMdTurn>, args: Record<string, unknown>) => {
  const output = await turn.tool.execute("call-1", args as never);
  const first = output.content[0];
  assert.ok(first && first.type === "text");
  return JSON.parse(first.text.split("\n")[0]!) as Record<string, unknown>;
};

test("the status sentence describes each root, and offers a draft for the first missing one", async (t) => {
  const setup = await monorepo(t);
  const { turn, offers } = turnFor(setup);
  const sentence = await turn.statusSentence();
  assert.ok(sentence.startsWith('DESIGN.md: "apps/web/DESIGN.md" (0 errors, 2 warnings); No DESIGN.md for "apps/admin".'), sentence);
  assert.ok(sentence.endsWith(designMdOfferSentence("apps/admin")), "the offer names the first app without one");
  // The run shares one offer log, as main.ts does.
  const { turn: later } = turnFor(setup, { offers });
  assert.ok(!(await later.statusSentence()).includes("ask_user_question"), "an offer claimed this run isn't made twice");
});

test("the sentence is there but the offer isn't when the chat can't write", async (t) => {
  const setup = await monorepo(t);
  const sentence = await turnFor(setup, { offerable: false }).turn.statusSentence();
  assert.equal(sentence, 'DESIGN.md: "apps/web/DESIGN.md" (0 errors, 2 warnings); No DESIGN.md for "apps/admin".');
});

test("the offer isn't made when ask_user_question isn't offered", async (t) => {
  const setup = await monorepo(t);
  const { turn, offers } = turnFor(setup, { askOffered: false });
  assert.ok(!(await turn.statusSentence()).includes("ask_user_question"));
  assert.equal((await offers.offerFor(setup.workspace, "apps/admin"))?.sentence, designMdOfferSentence("apps/admin"), "nothing was claimed");
});

test("settle(true) logs the offer; settle(false) leaves it for a later turn", async (t) => {
  const setup = await monorepo(t);
  const offers = new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") });
  const first = turnFor(setup, { offers }).turn;
  assert.ok((await first.statusSentence()).includes("ask_user_question"));
  await first.settle(false);
  const second = turnFor(setup, { offers }).turn;
  assert.ok((await second.statusSentence()).includes("ask_user_question"), "a failed turn's offer comes back");
  await second.settle(true);
  const restarted = new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") });
  assert.ok(!(await turnFor(setup, { offers: restarted }).turn.statusSentence()).includes("ask_user_question"), "logged across a restart");
});

test("a draft whose target exists at a delivered turn's end sends design_md_drafted once", async (t) => {
  const setup = await monorepo(t);
  const events: unknown[] = [];
  const report = (event: string, props: unknown) => events.push({ event, props });
  const { turn } = turnFor(setup, { report });
  assert.equal((await callTool(turn, { action: "draft", appRoot: "apps/admin" })).status, "drafted");
  await fs.writeFile(path.join(setup.workspace, "apps/admin/DESIGN.md"), "---\nname: Admin\n---\n");
  await turn.settle(true);
  await turn.settle(true);
  assert.deepEqual(events, [{ event: "design_md_drafted", props: { source: "app" } }]);

  const unwritten = await monorepo(t);
  const missing = turnFor(unwritten, { report });
  await callTool(missing.turn, { action: "draft", appRoot: "apps/admin" });
  await missing.turn.settle(true);
  assert.equal(events.length, 1, "a draft that was never written sends nothing");

  const stopped = await monorepo(t);
  const failed = turnFor(stopped, { report });
  await callTool(failed.turn, { action: "draft", appRoot: "apps/admin" });
  await fs.writeFile(path.join(stopped.workspace, "apps/admin/DESIGN.md"), "---\nname: Admin\n---\n");
  await failed.turn.settle(false);
  assert.equal(events.length, 1, "an undelivered turn sends nothing");
});

test("two chats in one workspace settle only their own offers", async (t) => {
  const setup = await monorepo(t);
  await fs.mkdir(path.join(setup.workspace, "apps/docs"), { recursive: true });
  const offers = new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") });
  const roots: DesignAppRoots = async () => ({ roots: ["apps/web", "apps/admin", "apps/docs"], more: 0 });
  const first = turnFor(setup, { offers, appRoots: roots }).turn;
  const second = turnFor(setup, { offers, appRoots: roots }).turn;
  assert.ok((await first.statusSentence()).endsWith(designMdOfferSentence("apps/admin")));
  assert.ok((await second.statusSentence()).endsWith(designMdOfferSentence("apps/docs")), "the next missing app is offered");
  // The second chat's turn ends normally while the first one is still running, then fails.
  await second.settle(true);
  await first.settle(false);
  const later = turnFor(setup, { offers, appRoots: roots }).turn;
  assert.ok((await later.statusSentence()).endsWith(designMdOfferSentence("apps/admin")), "the failed chat's offer comes back");
  await later.settle(false);
  const restarted = new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") });
  assert.equal(await restarted.offerFor(setup.workspace, "apps/docs"), null, "the delivered offer was logged");
});

test("with no offer left for the first missing app, the next missing one is offered", async (t) => {
  const setup = await monorepo(t);
  await fs.mkdir(path.join(setup.workspace, "apps/docs"), { recursive: true });
  const offers = new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") });
  const made = await offers.offerFor(setup.workspace, "apps/admin");
  await offers.settle(made!.key, true);
  const roots: DesignAppRoots = async () => ({ roots: ["apps/admin", "apps/web", "apps/docs"], more: 0 });
  const sentence = await turnFor(setup, { offers, appRoots: roots }).turn.statusSentence();
  assert.ok(sentence.endsWith(designMdOfferSentence("apps/docs")), sentence);
});

test("roots are read together, and a sentence that takes over its budget is empty", async (t) => {
  const setup = await monorepo(t);
  let inFlight = 0;
  let most = 0;
  const logged: string[] = [];
  const slowRun = (async (request: { content: string }, options?: { signal?: AbortSignal }) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight--;
    return countingRun(request as never, options as never);
  }) as unknown as typeof runDesignMdWorker;
  await fs.writeFile(path.join(setup.workspace, "apps/admin/DESIGN.md"), "---\nname: Admin\n---\n");
  const quick = turnFor(setup, { reader: { run: slowRun } }).turn;
  assert.ok((await quick.statusSentence()).includes('"apps/admin/DESIGN.md"'));
  assert.equal(most, 2, "both roots were linted at once");

  let aborted = false;
  const stuck = createDesignMdTurn({
    workspaceRoot: setup.workspace,
    reader: {
      read: (_root, _located, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("stopped", "AbortError"));
          });
        }),
      lintContent: async () => ({ status: "busy" }),
      export: async () => ({ status: "busy", path: "x", source: "app" }),
    },
    offers: new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") }),
    appRoots: twoApps,
    offerable: true,
    askOffered: true,
    budgetMs: 50,
    log: (message) => logged.push(message),
  });
  const started = performance.now();
  assert.equal(await stuck.statusSentence(), "");
  assert.ok(performance.now() - started < 1_000);
  assert.equal(aborted, true, "the reads were stopped");
  assert.equal(logged.length, 1);
});

test("the canvas_read line is one sentence with the quoted path and counts", async (t) => {
  const setup = await monorepo(t);
  const { turn } = turnFor(setup);
  assert.equal(await turn.canvasReadLine(), 'DESIGN.md: "apps/web/DESIGN.md" (0 errors, 2 warnings); No DESIGN.md for "apps/admin".');
});

test("a reader failure leaves the sentence empty and is logged", async (t) => {
  const setup = await monorepo(t);
  const logged: string[] = [];
  const turn = createDesignMdTurn({
    workspaceRoot: setup.workspace,
    reader: { read: async () => { throw new Error("disk gone"); }, lintContent: async () => ({ status: "busy" }), export: async () => ({ status: "busy", path: "x", source: "app" }) },
    offers: new DesignMdOffers({ file: () => path.join(setup.userData, "design-md-offers.json") }),
    appRoots: twoApps,
    offerable: true,
    askOffered: true,
    log: (message: string) => logged.push(message),
  });
  assert.equal(await turn.statusSentence(), "");
  assert.equal(await turn.canvasReadLine(), "");
  assert.equal(logged.length, 2);
});

test("with the live flag on, withDesignModeSection appends when absent, keeps a match and patches a change", () => {
  const user: AgentMessage = { role: "user", content: "hi", timestamp: 1 };
  const added = withDesignModeSection([user], "flag off text", 2, { live: true });
  assert.equal(added.length, 2);
  assert.deepEqual((added[1] as { sections?: Record<string, string> }).sections, { [DESIGN_MODE_SECTION]: "flag off text" });
  assert.equal(withDesignModeSection(added, "flag off text", 3, { live: true }), added, "an unchanged section leaves the messages as they are");
  const patched = withDesignModeSection(added, "flag on text", 4, { live: true });
  assert.equal(patched.length, 3, "a flag flipped since the chat's last turn appends the new text");
  assert.deepEqual((patched[2] as { sections?: Record<string, string> }).sections, { [DESIGN_MODE_SECTION]: "flag on text" });
  assert.equal(withDesignModeSection(patched, "flag on text", 5, { live: true }), patched, "the latest one counts");
});

test("with the live flag off, any copy of the section already there is kept, as before the flag", () => {
  const user: AgentMessage = { role: "user", content: "hi", timestamp: 1 };
  const older = withDesignModeSection([user], "an older section text", 2, { live: false });
  assert.equal(older.length, 2, "absent, it's appended");
  assert.equal(withDesignModeSection(older, "today's section text", 3, { live: false }), older, "an older copy isn't replaced");
});
