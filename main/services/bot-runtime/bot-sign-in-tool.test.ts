import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentTools, type ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import type { BotTranscriptEntry } from "../../../renderer/shared/bot-live.js";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserCommand,
  type BrowserState,
  type BrowserTab,
} from "../../../renderer/shared/browser.js";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { createBotBrowserHandoffOpener, type BotBrowserHandoffService } from "./bot-browser-handoff.js";
import { BOT_BROWSER_HELD_TAB_TITLE, createBotBrowser, type BotBrowserService } from "./bot-browser-tools.js";
import { createBotRegistry, type BotRegistry } from "./bot-extension.js";
import { openBotHandoff } from "./bot-handoff-open.js";
import { createBotHandoffs, type BotHandoffs } from "./bot-handoffs.js";
import { createBotHarnessHost, type BotHarnessHost } from "./harness-host.js";
import { signInCandidate, type BotSignInDeps } from "./bot-sign-in-tool.js";
import { createBotToolAssembly, type BotAdmission } from "./bot-tool-assembly.js";
import type { BotToolFacts } from "./bot-tool-policy.js";
import { projectBotTranscript } from "./live-projection.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "./test-support/faux.js";
import { SIGN_IN_ARGS, SIGN_IN_TOOL_NAME, signInEntries } from "./test-support/handoff-fixtures.js";

const ctx = BACKGROUND_CONTEXT;
const scenarioFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-support", "handoff-scenario.ts");
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-sign-in-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The plan's own wording (§5.2), as the model reads it.
const SIGNED_IN_TEXT =
  "The person says they signed in to https://github.com. Check with browser_snapshot; never ask for or type their password.";
const SKIPPED_TEXT =
  "The person chose not to do this: Sign in to github.com. Do not try another way to do it; say what you will do instead.";

type ToolResultModel = { isError: boolean; toolName: string; toolCallId: string; content: Array<{ text?: string }> };

async function signInResults(conversation: Conversation): Promise<ToolResultModel[]> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!)
    .filter((result) => result.toolName === SIGN_IN_TOOL_NAME);
}

const textOf = (result: { content: Array<{ type?: string; text?: string }> }) =>
  result.content.map((part) => part.text ?? "").join("");

/** What the chat shows on the person's side for their answers. */
async function answerRows(conversation: Conversation): Promise<Array<Extract<BotTranscriptEntry, { type: "handoff_result" }>>> {
  const view = await conversation.context(ctx);
  return projectBotTranscript(view.entries).flatMap((entry) => (entry.type === "handoff_result" ? [entry] : []));
}

async function memoryHarness(botId: string, handoffs: BotHandoffs, fauxModels: FauxModels, deps: BotSignInDeps = {}) {
  const extension = recordingDeps({ tools: signInEntries(handoffs, botId, deps) });
  const registry: BotRegistry = createBotRegistry(botId, extension);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root };
}

async function profileHost(profile: string, botId: string, handoffs: BotHandoffs, fauxModels: FauxModels) {
  const deps = recordingDeps({ tools: signInEntries(handoffs, botId) });
  let registry: BotRegistry | undefined;
  const host = (await createBotHarnessHost({
    profileDir: profile,
    models: fauxModels.models,
    buildRegistry: (id) => (registry = createBotRegistry(id, deps)),
  })) as BotHarnessHost;
  const opened = await host.open(botId);
  await registry!.refresh();
  return { host, ...opened };
}

const signInOnce = (args: unknown = SIGN_IN_ARGS) =>
  fauxAssistantMessage([fauxToolCall(SIGN_IN_TOOL_NAME, args as ToolCall["arguments"])], { stopReason: "toolUse" });

test("a Bot asks the person to sign in, waits, and I'm signed in becomes one tool result and one line on their side", async () => {
  const offered: string[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return signInOnce();
    },
    fauxAssistantMessage("Thanks, I'll look at your issues now."),
  ]);
  const handoffs = createBotHandoffs();
  const { harness, root } = await memoryHarness("bot-s", handoffs, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "triage my GitHub issues" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-s").length === 1, { what: "the sign-in card" });
    const [card] = handoffs.pending("bot-s");
    assert.ok(offered[0]!.includes(SIGN_IN_TOOL_NAME));
    assert.deepEqual(
      { kind: card!.kind, source: card!.source, action: card!.action, origin: card!.origin, open: card!.open, target: card!.target, why: card!.why },
      {
        kind: "sign_in",
        source: "tool",
        action: "Sign in to github.com",
        origin: "https://github.com",
        open: { url: "https://github.com" },
        target: "browser",
        why: "I need your GitHub account to read your issues.",
      },
      "the card names the site's https origin only: never the page or query the Bot gave",
    );

    assert.equal(handoffs.answer("bot-s", card!.waitId, { outcome: "done" }), "answered");
    assert.equal((await settled).status, "done");
    const results = await signInResults(root);
    assert.equal(results.length, 1, "the answer is recorded once");
    assert.equal(results[0]!.isError, false);
    assert.equal(textOf(results[0]!), SIGNED_IN_TEXT);
    const rows = await answerRows(root);
    assert.deepEqual(
      rows.map(({ id, kind, outcome, action, origin }) => ({ id, kind, outcome, action, origin })),
      [{ id: `handoff:${card!.toolCallId}`, kind: "sign_in", outcome: "done", action: "Sign in to github.com", origin: "https://github.com" }],
    );
    assert.equal(fauxModels.calls(), 2, "the model continues once, after the answer");
  } finally {
    await harness.close(ctx);
  }
});

test("Skip tells the model not to find another way in, and reads as skipped on the person's side", async () => {
  const fauxModels = createFauxModels([signInOnce({ site: "github.com" }), fauxAssistantMessage("Okay, I'll work from what you paste.")]);
  const handoffs = createBotHandoffs();
  const { harness, root } = await memoryHarness("bot-skip", handoffs, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "triage" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-skip").length === 1, { what: "the sign-in card" });
    const [card] = handoffs.pending("bot-skip");
    assert.equal(card!.why, undefined);
    assert.equal(handoffs.answer("bot-skip", card!.waitId, { outcome: "skipped", note: "Use the public page." }), "answered");
    assert.equal((await settled).status, "done");
    const [result] = await signInResults(root);
    assert.equal(textOf(result!), `${SKIPPED_TEXT}\nTheir note: Use the public page.`);
    assert.deepEqual((await answerRows(root)).map((row) => [row.kind, row.outcome, row.note]), [["sign_in", "skipped", "Use the public page."]]);
  } finally {
    await harness.close(ctx);
  }
});

test("a site that isn't a public https site, or a computer the Bot doesn't have, is an error result and never shows a card", async () => {
  const sites = [
    "http://github.com",
    "https://ada:secret@github.com",
    "https://github.com:8443",
    "https://127.0.0.1",
    "https://2130706433",
    "https://[::1]",
    "localhost",
    "https://intranet.localhost",
    "intranet",
    "javascript:alert(1)",
  ];
  const fauxModels = createFauxModels([
    fauxAssistantMessage(
      [
        ...sites.map((site, index) => fauxToolCall(SIGN_IN_TOOL_NAME, { site }, { id: `bad-${index}` })),
        fauxToolCall(SIGN_IN_TOOL_NAME, { site: "github.com", where: "computer" }, { id: "computer" }),
        fauxToolCall(SIGN_IN_TOOL_NAME, { site: `${"a".repeat(150)}.com` }, { id: "long" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("I'll ask for a real site."),
  ]);
  const handoffs = createBotHandoffs();
  let shown = 0;
  handoffs.onChange(() => (shown += handoffs.pending().length));
  const { harness, root } = await memoryHarness("bot-bad", handoffs, fauxModels, { botName: async () => "Ada" });
  try {
    assert.equal((await (await root.submit({ type: "input", content: "sign in" }, ctx)).wait(ctx)).status, "done");
    const results = await signInResults(root);
    assert.equal(results.length, sites.length + 2);
    assert.ok(results.every((result) => result.isError), "each bad call failed");
    const byId = new Map(results.map((result) => [result.toolCallId, textOf(result)]));
    for (const [index, site] of sites.entries()) {
      assert.match(byId.get(`bad-${index}`)!, /Use an https site name like github\.com\./u, site);
    }
    assert.match(byId.get("computer")!, /Ada has no computer to sign in on yet\./u);
    assert.match(byId.get("long")!, /too long to show on a card/u);
    assert.equal(shown, 0, "no card was ever shown");
    assert.deepEqual(await answerRows(root), []);
  } finally {
    await harness.close(ctx);
  }
});

test("quitting while a sign-in waits withdraws it; Resume shows it again under the same waitId and applies one answer", async () => {
  const profile = tempProfile();
  const firstRun = createBotHandoffs();
  const before = await profileHost(profile, "bot-quit", firstRun, createFauxModels([signInOnce()]));
  await before.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  await before.conversation.submit({ type: "input", content: "triage", requestId: "quit-1" }, ctx);
  await waitFor(() => firstRun.pending("bot-quit").length === 1, { what: "the sign-in card" });
  const [asked] = firstRun.pending("bot-quit");

  await before.host.shutdown();
  assert.deepEqual(firstRun.pending("bot-quit"), [], "quitting withdraws the card");

  const handoffs = createBotHandoffs();
  const fauxModels = createFauxModels([fauxAssistantMessage("Signed in, checking now.")]);
  const reopened = await profileHost(profile, "bot-quit", handoffs, fauxModels);
  try {
    assert.deepEqual(handoffs.pending("bot-quit"), [], "nothing is shown before Resume");
    const [placed] = (await reopened.harness.inspect(ctx)).submissions;
    reopened.harness.resume();
    await waitFor(() => handoffs.pending("bot-quit").length === 1, { what: "the re-shown card" });
    const [again] = handoffs.pending("bot-quit");
    assert.equal(again!.waitId, asked!.waitId);
    assert.equal(again!.kind, "sign_in");
    assert.equal(handoffs.answer("bot-quit", asked!.waitId, { outcome: "done" }), "answered");
    assert.equal((await (await reopened.harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");
    const answered = (await signInResults(reopened.conversation)).filter((result) => !result.isError);
    assert.deepEqual(answered.map(textOf), [SIGNED_IN_TEXT]);
    assert.equal(fauxModels.calls(), 1, "the sign-in is not re-generated, only the follow-up");
  } finally {
    await reopened.host.shutdown();
  }
});

test("after SIGKILL while a sign-in waits, Resume shows it under the same waitId and applies one answer", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [scenarioFile, JSON.stringify({ profileDir: profile, botId: "bot-s-kill", signIn: true })]);
  const childWaitId = await child.waitFor("HANDOFF");
  await child.kill();

  const handoffs = createBotHandoffs();
  const fauxModels = createFauxModels([fauxAssistantMessage("Thanks, I'll carry on.")]);
  const { host, harness, conversation } = await profileHost(profile, "bot-s-kill", handoffs, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    await waitFor(() => handoffs.pending("bot-s-kill").length === 1, { what: "the re-shown card" });
    assert.equal(handoffs.pending("bot-s-kill")[0]!.waitId, childWaitId, "the card keeps its waitId");
    assert.equal(handoffs.answer("bot-s-kill", childWaitId, { outcome: "done" }), "answered");
    assert.equal(handoffs.answer("bot-s-kill", childWaitId, { outcome: "skipped" }), "not_waiting");
    assert.equal((await (await harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");
    const results = await signInResults(conversation);
    assert.deepEqual(results.map(textOf), [SIGNED_IN_TEXT], "the answer is applied exactly once");
  } finally {
    await host.shutdown();
  }
});

/* ------------------------------------------------------------------------- */
/* The sign-in tab in the Bot's own browser                                   */
/* ------------------------------------------------------------------------- */

const WORKSPACE = "bot-home-s";
const WINDOW: RendererDocumentOwner = {
  id: 1,
  documentId: "document-1",
  isDestroyed: () => false,
  send: () => undefined,
  onInvalidated: () => () => undefined,
};

function browserTab(id: string, url: string): BrowserTab {
  return {
    id, workspaceId: WORKSPACE, profileId: "bot:bot-tab", url, title: `Page ${id}`, loading: false, canGoBack: true,
    canGoForward: false, crashed: false, audible: false, muted: false, viewport: { mode: "fill", width: 1280, height: 720 },
    appearance: "system", zoom: 1, recording: false, agentControlling: false, floating: false, visible: true,
  };
}

/**
 * The Bot's browser as both its hand-off opener and its tools use it: tabs,
 * the holds on them, and the person moving through a held tab.
 */
function fakeBotBrowser() {
  const tabs: BrowserTab[] = [browserTab("tab-1", "https://github.com/issues")];
  const holds = new Map<string, string>();
  const state = (): BrowserState => ({
    workspaceId: WORKSPACE, revision: 1, tabs: structuredClone(tabs), activeTabId: tabs[tabs.length - 1]?.id ?? null,
    profiles: structuredClone(BUILT_IN_BROWSER_PROFILES), defaults: structuredClone(DEFAULT_BROWSER_SETTINGS),
    agentAccessOverride: "inherit", agentAccessAllowed: true, history: [], servers: [],
  });
  const opened: BrowserCommand[] = [];
  const service: BotBrowserHandoffService & BotBrowserService = {
    getState: () => state(),
    hasOwner: () => true,
    transferOwner: () => undefined,
    async command(_workspaceId, command, context) {
      if (context.source === "user") opened.push(command);
      if (command.action === "create") {
        const tab = browserTab(`tab-${tabs.length + 1}`, command.url ?? "about:blank");
        tabs.push(tab);
        return { state: state(), tabId: tab.id };
      }
      return { state: state(), ...("tabId" in command ? { tabId: command.tabId } : {}) };
    },
    hold(_workspaceId, tabId, hold) {
      holds.set(tabId, hold.holdId);
      tabs.find((tab) => tab.id === tabId)!.heldForPerson = { reason: hold.reason };
    },
    release(_workspaceId, holdId) {
      for (const tab of tabs) {
        if (holds.get(tab.id) !== holdId) continue;
        holds.delete(tab.id);
        delete tab.heldForPerson;
      }
    },
    getApprovalTarget: (workspaceId, tabId) => ({ workspaceId, tabId: tabId ?? "tab-1", url: "https://github.com/issues", documentRevision: "doc:1", controlRevision: 0 }),
    probeAgentTarget: async () => undefined,
    closeBotTabs: () => undefined,
  };
  return {
    service,
    tabs,
    holds,
    opened,
    /** The person signs in: the held tab goes through the site's pages. */
    browse(tabId: string, url: string, title: string) {
      const tab = tabs.find((each) => each.id === tabId)!;
      tab.url = url;
      tab.title = title;
    },
  };
}

/** A sign-in card's Open on the Mac, through the production opener table and the Bot browser opener. */
function macOpen(browser: ReturnType<typeof fakeBotBrowser>, handoffs: BotHandoffs) {
  const opener = createBotBrowserHandoffOpener({
    service: async () => browser.service,
    handoffs,
    workspace: async () => WORKSPACE,
    hasBrowserAccess: async () => true,
    mintOwner: () => WINDOW,
  });
  return (botId: string, waitId: string) =>
    openBotHandoff(handoffs.get(botId, waitId)!, "desktop", {
      external: async () => assert.fail("a sign-in never opens in the system browser"),
      focusChat: async () => undefined,
      botBrowser: (id, wait, url, hold) => opener(id, wait, url, hold),
    });
}

/** Lets a release, which loads the browser service, land. */
const settledRelease = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Open sign-in holds a new tab of the Bot's browser for the person; the Bot sees no address while held and gets it back on I'm signed in", async () => {
  const browser = fakeBotBrowser();
  const handoffs = createBotHandoffs();
  const fauxModels = createFauxModels([signInOnce(), fauxAssistantMessage("Signed in.")]);
  const { harness, root } = await memoryHarness("bot-tab", handoffs, fauxModels);
  const bot = createBotBrowser({ service: async () => browser.service, mintOwner: () => WINDOW });
  const tools = await bot.candidates("bot-tab", { workspaceId: WORKSPACE, chatId: "chat-1", generationId: "gen-1", supportsImages: true, botName: "Ada" });
  const status = tools.find(({ tool }) => tool.name === "browser_status")!.tool;
  const gateway = tools.find(({ tool }) => tool.name === "browser")!.tool;
  try {
    const settled = (await root.submit({ type: "input", content: "triage" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-tab").length === 1, { what: "the sign-in card" });
    const [card] = handoffs.pending("bot-tab");
    const open = macOpen(browser, handoffs);

    assert.equal(await open("bot-tab", card!.waitId), "browser");
    assert.deepEqual(browser.opened, [{ action: "create", url: "https://github.com", show: true }], "a new tab, at the site's origin");
    assert.equal(browser.holds.get("tab-2"), card!.waitId, "held under the card's wait id");
    assert.deepEqual(browser.tabs[1]!.heldForPerson, { reason: "sign_in" });

    // The person moves through the sign-in; the Bot can't follow it.
    browser.browse("tab-2", "https://github.com/sessions/two-factor?return_to=%2Fissues", "Two-factor authentication");
    const seen = JSON.parse(textOf(await status.execute("status-1", { tabId: "tab-2" }))) as { url: string; title: string };
    assert.deepEqual([seen.url, seen.title], ["", BOT_BROWSER_HELD_TAB_TITLE]);
    const listing = textOf(await gateway.execute("gateway-1", {}));
    assert.equal(listing.includes("two-factor"), false, "the gateway lists the tab without its address");
    assert.equal(listing.includes("Two-factor authentication"), false);
    assert.match(listing, /"usedByThePerson":true/u);

    // Open again brings the same tab back rather than opening another.
    assert.equal(await open("bot-tab", card!.waitId), "browser");
    assert.deepEqual(browser.opened[browser.opened.length - 1], { action: "select", tabId: "tab-2" });
    assert.equal(browser.tabs.length, 2);

    browser.browse("tab-2", "https://github.com/issues", "Issues");
    assert.equal(handoffs.answer("bot-tab", card!.waitId, { outcome: "done" }), "answered");
    assert.equal((await settled).status, "done");
    await settledRelease();
    assert.equal(browser.tabs[1]!.heldForPerson, undefined, "the Bot has the tab back");
    const after = JSON.parse(textOf(await status.execute("status-2", { tabId: "tab-2" }))) as { url: string; title: string };
    assert.deepEqual([after.url, after.title], ["https://github.com/issues", "Issues"]);
  } finally {
    await harness.close(ctx);
  }
});

test("Stop while the person is signing in withdraws the card and gives the Bot its tab back", async () => {
  const browser = fakeBotBrowser();
  const handoffs = createBotHandoffs();
  const fauxModels = createFauxModels([signInOnce(), fauxAssistantMessage("never requested")]);
  const { harness, root } = await memoryHarness("bot-tab", handoffs, fauxModels);
  try {
    const settled = (await root.submit({ type: "input", content: "triage" }, ctx)).wait(ctx);
    await waitFor(() => handoffs.pending("bot-tab").length === 1, { what: "the sign-in card" });
    const [card] = handoffs.pending("bot-tab");
    await macOpen(browser, handoffs)("bot-tab", card!.waitId);
    assert.deepEqual(browser.tabs[1]!.heldForPerson, { reason: "sign_in" });

    await root.abort(ctx);
    assert.equal((await settled).status, "unanswered");
    await settledRelease();
    assert.equal(browser.tabs[1]!.heldForPerson, undefined);
    assert.equal(browser.holds.size, 0);
    assert.ok((await signInResults(root)).every((result) => result.isError), "no answer was recorded");
    assert.deepEqual(await answerRows(root), []);
  } finally {
    await harness.close(ctx);
  }
});

/* ------------------------------------------------------------------------- */
/* Who is offered it                                                          */
/* ------------------------------------------------------------------------- */

test("sign-in is offered only with the Browser in the Bot's access, and never on routine or Telegram turns", async () => {
  const admission: BotAdmission = {
    authority: {} as BotAdmission["authority"],
    signal: new AbortController().signal,
    revalidateBeforeEffect: async () => undefined,
    release: () => undefined,
  };
  const assemblyFor = (capabilities: string[]) =>
    createBotToolAssembly({
      admit: async () => admission,
      sources: {
        facts: async () =>
          ({
            authority: { otherCapabilities: capabilities.map((kind) => ({ kind })) } as unknown as BotRuntimeEffectiveAuthority,
            mcpTools: async () => new Map(),
            skillToolNames: async () => new Set(),
          }) as unknown as BotToolFacts,
        candidates: async () => ({ tools: [signInCandidate("bot-gate", createBotHandoffs())] }),
      },
    });
  const withBrowser = assemblyFor(["browser"]);
  const names = async (requestId?: string) =>
    (await withBrowser.currentTools("bot-gate", requestId === undefined ? {} : { requestId })).map((entry) => entry.tool.name);

  assert.deepEqual(await names("desk-1"), [SIGN_IN_TOOL_NAME]);
  assert.deepEqual(await names("remote:device:key"), [SIGN_IN_TOOL_NAME], "a phone's turn can ask: the card shows Finish on your Mac");
  assert.deepEqual(await names("routine:task-1:2026-10-07T09:00:00.000Z"), []);
  assert.deepEqual(await names("tg:1:2:0:3"), []);
  assert.deepEqual((await assemblyFor([]).currentTools("bot-gate", { requestId: "desk-1" })).map((entry) => entry.tool.name), []);

  const call = { callId: "c1", args: { site: "github.com" }, signal: new AbortController().signal };
  assert.deepEqual(await withBrowser.checkPolicy("bot-gate", SIGN_IN_TOOL_NAME, { ...call, requestIds: ["desk-1"] }), { allowed: true });
  for (const requestIds of [["routine:task-1:2026-10-07T09:00:00.000Z"], ["tg:1:2:0:3"], ["desk-1", "tg:1:2:0:3"]]) {
    const decision = await withBrowser.checkPolicy("bot-gate", SIGN_IN_TOOL_NAME, { ...call, requestIds });
    assert.equal(decision.allowed, false, `refused at call time for ${requestIds.join(", ")}`);
  }
  assert.deepEqual(await assemblyFor([]).checkPolicy("bot-gate", SIGN_IN_TOOL_NAME, { ...call, requestIds: ["desk-1"] }), {
    allowed: false,
    reason: "Sign-in needs the Browser in this Bot's access.",
  });
});
