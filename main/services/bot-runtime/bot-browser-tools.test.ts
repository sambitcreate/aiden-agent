import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserCommand,
  type BrowserState,
  type BrowserTab,
} from "../../../renderer/shared/browser.js";
import { botRuleLabel, defaultBotRules, type BotRule } from "../../../renderer/shared/bot-rules.js";
import type { BrowserCommandContext, BrowserFieldProbe } from "../browser/service.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { BROWSER_VALUE_SELECTOR_REFUSED, BROWSER_XPATH_SELECTOR_REFUSED } from "../browser/credential-boundary.js";
import { createBotHandoffs, ruleHandoffRequest } from "./bot-handoffs.js";
import { createBotRegistry, type BotExtensionDeps } from "./bot-extension.js";
import {
  BOT_BROWSER_GUIDANCE,
  botBrowserOwnerMissing,
  createBotBrowser,
  type BotBrowserService,
  type BotBrowserTurn,
} from "./bot-browser-tools.js";
import { botIngressAllowsTool, botToolVerdict } from "./bot-tool-policy.js";
import { withheldUntilDisclosed } from "./bot-tool-disclosure.js";
import { BOT_OLDER_SCREENSHOT_NOTE } from "./bot-images.js";
import { assemblyDeps, assemblyState, FULL_GRANTS, testAuthority } from "./test-support/assembly-fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;
const BOT = "bot-1";
const SLACK = "https://app.slack.com/client/T1/C2";
const COMPOSER: BrowserFieldProbe = { tag: "div", role: "textbox", accessibleName: "Message #general" };

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tab(id: string, url: string): BrowserTab {
  return {
    id, workspaceId: "bot-home-1", profileId: `bot:${BOT}`, url, title: id, loading: false, canGoBack: false,
    canGoForward: false, crashed: false, audible: false, muted: false, viewport: { mode: "fill", width: 1280, height: 720 },
    appearance: "system", zoom: 1, recording: false, agentControlling: false, floating: false, visible: true,
  };
}

const WINDOW: RendererDocumentOwner = {
  id: 1,
  documentId: "document-1",
  isDestroyed: () => false,
  send: () => undefined,
  onInvalidated: () => () => undefined,
};

/** The browser service as the Bot sees it: one Bot workspace with live page and control revisions. */
function fakeBrowser(options: { owned?: boolean; window?: RendererDocumentOwner | undefined } = {}) {
  const tabs: BrowserTab[] = [tab("slack", SLACK), tab("shop", "https://shop.example.com/checkout")];
  const page = { document: 1, control: 0 };
  let owner: RendererDocumentOwner | undefined = options.owned === false ? undefined : WINDOW;
  let probe: BrowserFieldProbe | undefined = COMPOSER;
  let probes = 0;
  const commands: Array<{ command: BrowserCommand; context: BrowserCommandContext }> = [];
  const transfers: RendererDocumentOwner[] = [];
  const closed: string[] = [];
  /** Runs inside a command before its effect: the page changing under the Bot. */
  let duringCommand: (() => void) | undefined;
  const state = (workspaceId: string): BrowserState => ({
    workspaceId, revision: 1, tabs: structuredClone(tabs), activeTabId: tabs[0]?.id ?? null,
    profiles: structuredClone(BUILT_IN_BROWSER_PROFILES), defaults: structuredClone(DEFAULT_BROWSER_SETTINGS),
    agentAccessOverride: "inherit", agentAccessAllowed: true, history: [], servers: [],
  });
  const service: BotBrowserService = {
    getState: state,
    async command(workspaceId, command, context) {
      duringCommand?.();
      context.beforeEffect?.();
      commands.push({ command, context });
      if (command.action !== "snapshot") return { state: state(workspaceId) };
      // Each look at the page is its own screenshot.
      const shot = Buffer.from(`screenshot-${commands.length}`).toString("base64");
      return {
        state: state(workspaceId),
        snapshot: {
          tab: tabs[0]!, text: "Inbox", elements: [], diagnostics: [],
          image: { data: shot, mimeType: "image/png", width: 1280, height: 720 },
        },
      };
    },
    getApprovalTarget(workspaceId, tabId) {
      const target = tabs.find((candidate) => candidate.id === tabId) ?? tabs[0]!;
      return { workspaceId, tabId: target.id, url: target.url, documentRevision: `doc:${page.document}`, controlRevision: page.control };
    },
    hasOwner: () => owner !== undefined,
    transferOwner(_workspaceId, next) {
      owner = next;
      transfers.push(next);
    },
    probeAgentTarget: async () => {
      probes += 1;
      return probe;
    },
    closeBotTabs: (botId) => void closed.push(botId),
  };
  const browser = createBotBrowser({
    service: async () => service,
    mintOwner: () => ("window" in options ? options.window : WINDOW),
  });
  return {
    browser, service, tabs, page, commands, transfers, closed,
    probes: () => probes,
    setProbe(next: BrowserFieldProbe | undefined) {
      probe = next;
    },
    duringCommand(next: (() => void) | undefined) {
      duringCommand = next;
    },
  };
}

const TURN: BotBrowserTurn = { workspaceId: "bot-home-1", chatId: "chat-1", generationId: "gen-1", supportsImages: true, botName: "Ada" };

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

test("a Bot's browser offers its gateway and the browser tools, without page scripts or recording", async () => {
  const fake = fakeBrowser();
  const candidates = await fake.browser.candidates(BOT, TURN);
  assert.deepEqual(candidates.map(({ tool }) => tool.name), [
    "browser", "browser_status", "browser_open", "browser_navigate", "browser_resize", "browser_set_appearance",
    "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_wait_for",
  ]);
  // Only the gateway, the status and a look at the page are safe to run again after a crash.
  const safe = candidates.filter(({ replay }) => replay === "safe").map(({ tool }) => tool.name).sort();
  assert.deepEqual(safe, ["browser", "browser_snapshot", "browser_status"]);
});

test("the gateway explains the browser and lists the Bot's tabs, marking the ones the person is using", async () => {
  const fake = fakeBrowser();
  fake.tabs[1]!.heldForPerson = { reason: "sign_in" };
  const gateway = (await fake.browser.candidates(BOT, TURN)).find(({ tool }) => tool.name === "browser")!.tool;
  const text = textOf(await gateway.execute("gateway-1", {}));
  assert.ok(text.startsWith(BOT_BROWSER_GUIDANCE));
  const listing = JSON.parse(text.slice(text.indexOf("{"))) as {
    tabs: Array<{ tabId: string; url: string; title: string; usedByThePerson?: boolean }>;
  };
  assert.deepEqual(
    listing.tabs.map((entry) => [entry.tabId, entry.url, entry.usedByThePerson === true]),
    [["slack", SLACK, false], ["shop", "", true]],
    "a tab the person is using shows no address while they use it",
  );
  assert.equal(text.includes("checkout"), false);
});

test("with no window to show it in, the Bot is told to ask the person to open Aiden; a window that appears owns it", async () => {
  const closedApp = fakeBrowser({ owned: false, window: undefined });
  const gateway = (await closedApp.browser.candidates(BOT, TURN)).find(({ tool }) => tool.name === "browser")!.tool;
  await assert.rejects(gateway.execute("gateway-1", {}), new RegExp(botBrowserOwnerMissing("Ada").replace(/[.]/gu, "\\.")));
  assert.equal(closedApp.transfers.length, 0);

  const open = fakeBrowser({ owned: false });
  const owned = (await open.browser.candidates(BOT, TURN)).find(({ tool }) => tool.name === "browser")!.tool;
  await owned.execute("gateway-1", {});
  assert.deepEqual(open.transfers, [WINDOW]);
});

test("a click runs only under the person's approval of that exact call, on the tab and page they saw", async () => {
  const fake = fakeBrowser();
  const tools = await fake.browser.candidates(BOT, TURN);
  const click = tools.find(({ tool }) => tool.name === "browser_click")!.tool;
  const args = { locator: "getByRole('button', { name: 'Send' })" };

  await assert.rejects(click.execute("call-0", args), /needs the person's approval/u);
  assert.equal(fake.commands.length, 0, "an unapproved click never reaches the page");

  const live = await fake.browser.approvalFor(BOT, "browser_click", { callId: "call-1", args, signal: undefined });
  assert.ok(live?.approval);
  assert.equal(live.approval.summary, `Click getByRole('button', { name: 'Send' }) in its browser\n${SLACK}`);
  assert.deepEqual(live.action, { surface: "browser", tool: "browser_click", url: SLACK, locator: args.locator, field: COMPOSER });
  // Asked but not answered yet: still refused.
  await assert.rejects(click.execute("call-1", args), /needs the person's approval/u);

  live.approval.onAllow!();
  await click.execute("call-1", args);
  assert.equal(fake.commands.length, 1);
  const [{ command, context }] = fake.commands;
  assert.equal(command.action, "click");
  assert.equal((command as { tabId?: string }).tabId, "slack", "the approved tab, though the Bot named none");
  assert.equal(context.source, "agent");
  assert.equal(context.credentialBoundary, true);

  // The approval is spent: the same call id doesn't click twice.
  await assert.rejects(click.execute("call-1", args), /needs the person's approval/u);
  assert.equal(fake.commands.length, 1);
});

test("an approved click expires when the page navigates, the person takes over, or the arguments change", async () => {
  const fake = fakeBrowser();
  const click = (await fake.browser.candidates(BOT, TURN)).find(({ tool }) => tool.name === "browser_click")!.tool;
  const args = { locator: "getByRole('button', { name: 'Send' })" };
  const approve = async (callId: string) => {
    const live = await fake.browser.approvalFor(BOT, "browser_click", { callId, args, signal: undefined });
    live!.approval!.onAllow!();
  };

  await approve("navigated");
  fake.page.document += 1;
  await assert.rejects(click.execute("navigated", args), /page navigated/u);

  await approve("taken-over");
  fake.page.control += 1;
  await assert.rejects(click.execute("taken-over", args), /user took control/u);

  await approve("changed");
  await assert.rejects(click.execute("changed", { locator: "getByRole('button', { name: 'Delete' })" }), /arguments changed/u);

  await approve("other-tab");
  await assert.rejects(click.execute("other-tab", { ...args, tabId: "shop" }), /tab changed/u);

  // The page changes after the call started but before the click lands.
  await approve("late");
  fake.duringCommand(() => void (fake.page.document += 1));
  await assert.rejects(click.execute("late", args), /page navigated/u);
  assert.equal(fake.commands.length, 0);

  // The person answers after the page moved on: Allow itself refuses.
  const stale = await fake.browser.approvalFor(BOT, "browser_click", { callId: "stale", args, signal: undefined });
  fake.page.document += 1;
  assert.throws(() => stale!.approval!.onAllow!(), /page navigated/u);
});

test("a tab the person is using refuses the Bot before anything is asked", async () => {
  const fake = fakeBrowser();
  await fake.browser.candidates(BOT, TURN);
  fake.tabs[0]!.heldForPerson = { reason: "handoff" };
  await assert.rejects(
    fake.browser.approvalFor(BOT, "browser_click", { callId: "c", args: { locator: "text=Send" }, signal: undefined }),
    /The person is using this tab\. Wait for them to finish\./u,
  );
});

test("a selector that tests what a field holds is refused before anything reads the page", async () => {
  const fake = fakeBrowser();
  await fake.browser.candidates(BOT, TURN);
  for (const [args, refusal] of [
    [{ selector: "input[value^='h']", text: "x" }, BROWSER_VALUE_SELECTOR_REFUSED],
    [{ locator: "xpath=//textarea[starts-with(.,'4111')]" }, BROWSER_XPATH_SELECTOR_REFUSED],
  ] as const) {
    await assert.rejects(
      fake.browser.approvalFor(BOT, "browser_click", { callId: "v", args, signal: undefined }),
      { message: refusal },
    );
  }
  assert.equal(fake.probes(), 0, "the page never evaluated the selector");
});

test("the card shows what the Bot will type, except into a password, code or card field or a field it couldn't read", async () => {
  const fake = fakeBrowser();
  await fake.browser.candidates(BOT, TURN);
  const typed = async (field: BrowserFieldProbe | undefined) => {
    fake.setProbe(field);
    const live = await fake.browser.approvalFor(BOT, "browser_type", {
      callId: "t",
      args: { locator: "getByLabel('Field')", text: "hunter2 rocks" },
      signal: undefined,
    });
    return live!.approval!.summary;
  };
  assert.equal(await typed(COMPOSER), `Type “hunter2 rocks” into getByLabel('Field') in its browser\n${SLACK}`);
  for (const secret of [
    { tag: "input", type: "password" },
    { tag: "input", type: "text", autocomplete: "one-time-code" },
    { tag: "input", type: "text", autocomplete: "cc-number" },
    { tag: "input", type: "text", accessibleName: "Verification code" },
    undefined,
  ]) {
    const summary = await typed(secret);
    assert.equal(summary.includes("hunter2"), false, JSON.stringify(secret));
    assert.ok(summary.startsWith("Type into getByLabel('Field') in its browser"), summary);
  }
});

test("a key press is classified with the focused field and its chord, never with typed text", async () => {
  const fake = fakeBrowser();
  await fake.browser.candidates(BOT, TURN);
  const live = await fake.browser.approvalFor(BOT, "browser_press", {
    callId: "p",
    args: { key: "Enter", modifiers: ["Control"] },
    signal: undefined,
  });
  assert.equal(live!.approval!.summary, `Press Control+Enter in its browser\n${SLACK}`);
  assert.deepEqual(live!.action, { surface: "browser", tool: "browser_press", url: SLACK, key: "Control+Enter", field: COMPOSER });
  // Reading a page asks nothing and isn't classified.
  assert.deepEqual(await fake.browser.approvalFor(BOT, "browser_snapshot", { callId: "s", args: {}, signal: undefined }), { approval: null });
  assert.equal(await fake.browser.approvalFor(BOT, "web_search", { callId: "w", args: {}, signal: undefined }), undefined);
});

test("a deleted Bot's browser closes its tabs and forgets its approvals", async () => {
  const fake = fakeBrowser();
  await fake.browser.candidates(BOT, TURN);
  await fake.browser.forget(BOT);
  assert.deepEqual(fake.closed, [BOT]);
  await assert.rejects(
    fake.browser.approvalFor(BOT, "browser_click", { callId: "c", args: {}, signal: undefined }),
    /not enabled/u,
  );
});

test("browser tools stay out of a request until the gateway has answered it", () => {
  const result = (toolName: string, isError: boolean): Message =>
    ({ role: "toolResult", toolCallId: `${toolName}-1`, toolName, content: [], isError, timestamp: 0 }) as Message;
  const before = withheldUntilDisclosed([]);
  assert.equal(before("browser_click"), true);
  assert.equal(before("browser_status"), true);
  assert.equal(before("browser"), false, "the gateway itself is always offered");
  assert.equal(before("web_search"), false);
  assert.equal(withheldUntilDisclosed([result("browser", true)])("browser_click"), true, "a failed gateway discloses nothing");
  assert.equal(withheldUntilDisclosed([result("web_search", false)])("browser_click"), true);
  assert.equal(withheldUntilDisclosed([result("browser", false)])("browser_click"), false);
});

test("the browser needs the Browser access and a person there to answer: never on routines or Telegram, never scripts", async () => {
  const facts = (kinds: string[]) =>
    ({ authority: { otherCapabilities: kinds.map((kind) => ({ kind })) } }) as unknown as Parameters<typeof botToolVerdict>[1];
  for (const name of ["browser", "browser_click", "browser_snapshot"]) {
    assert.deepEqual(await botToolVerdict(name, facts(["browser"]), {}), { allowed: true }, name);
    assert.deepEqual(await botToolVerdict(name, facts(["web"]), {}), { allowed: false, reason: "The browser is off for this Bot." });
    assert.equal((await botToolVerdict(name, facts(["browser"]), { routine: true })).allowed, false);
    assert.equal((await botToolVerdict(name, facts(["browser"]), { telegram: true })).allowed, false);
    assert.equal(botIngressAllowsTool(name, ["desk-1"]), true);
    assert.equal(botIngressAllowsTool(name, ["routine:task-1:2026-10-07T09:00:00.000Z"]), false);
    assert.equal(botIngressAllowsTool(name, ["tg:bot:1:0:5"]), false);
  }
  assert.deepEqual(await botToolVerdict("browser_evaluate", facts(["browser"]), {}), {
    allowed: false,
    reason: "A Bot's browser can't run page scripts or record.",
  });
});

/* ------------------------------------------------------------------------- */
/* Through a real Bot turn                                                    */
/* ------------------------------------------------------------------------- */

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-browser-"));
  roots.push(home);
  return home;
}

async function botTurn(deps: BotExtensionDeps, fauxModels: FauxModels) {
  const registry = createBotRegistry(BOT, deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root };
}

type ToolResultModel = { isError: boolean; toolName: string; content: Array<{ text?: string }> };

async function toolResults(conversation: Conversation): Promise<ToolResultModel[]> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
}

async function browserDeps(fake: ReturnType<typeof fakeBrowser>, options: Partial<Parameters<typeof assemblyDeps>[1]> = {}) {
  const state = assemblyState(testAuthority({ mode: "full", home: tempHome(), ...FULL_GRANTS, other: [...FULL_GRANTS.other, "browser"] }));
  const candidates = await fake.browser.candidates(BOT, TURN);
  return assemblyDeps(state, {
    candidates: () => candidates,
    approvalFor: (toolName, call) => fake.browser.approvalFor(BOT, toolName, call),
    botName: "Ada",
    ...options,
  });
}

test("a Bot turn sees the browser tools only after calling the gateway, then clicks once under the person's Allow", async () => {
  const fake = fakeBrowser();
  const offered: string[][] = [];
  const record = (reply: () => ReturnType<typeof fauxAssistantMessage>) => (context: { messages: readonly Message[] }) => {
    offered.push(getCurrentTools(context.messages as Message[]).map((tool) => tool.name));
    return reply();
  };
  const fauxModels = createFauxModels([
    record(() => fauxAssistantMessage([fauxToolCall("browser", {}, { id: "gateway" })], { stopReason: "toolUse" })),
    record(() =>
      fauxAssistantMessage([fauxToolCall("browser_click", { locator: "text=Archive" }, { id: "click" })], { stopReason: "toolUse" }),
    ),
    record(() => fauxAssistantMessage("archived")),
  ]);
  const deps = await browserDeps(fake, { rules: () => defaultBotRules() });
  const { harness, root } = await botTurn(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "archive it" }, ctx)).wait(ctx);
    assert.ok(offered[0]!.includes("browser"));
    assert.equal(offered[0]!.some((name) => name.startsWith("browser_")), false, "no browser_* before the gateway answers");
    assert.ok(offered[1]!.includes("browser_click"), "the gateway's answer discloses the browser tools");
    assert.deepEqual(deps.approvals.map((request) => request.summary), [`Click text=Archive in its browser\n${SLACK}`]);
    assert.deepEqual(fake.commands.map(({ command }) => command.action), ["click"]);
  } finally {
    await harness.close(ctx);
  }
});

test("Enter in a web message box falls under the Send a message rule, and a Deny never presses it", async () => {
  const fake = fakeBrowser();
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("browser", {}, { id: "gateway" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("browser_press", { key: "Enter" }, { id: "send" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("not sent"),
  ]);
  const rules = defaultBotRules();
  const communicate = rules.find((rule) => rule.actionClass === "communicate")!;
  const deps = await browserDeps(fake, { rules: () => rules, approve: async () => "deny" });
  const { harness, root } = await botTurn(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "send it" }, ctx)).wait(ctx);
    assert.deepEqual(deps.approvals.map((request) => request.summary), [
      `Rule · ${botRuleLabel(communicate)} — Press Enter in its browser\n${SLACK}`,
    ]);
    assert.equal(fake.commands.length, 0);
    const results = await toolResults(root);
    assert.equal(results.find((result) => result.toolName === "browser_press")?.isError, true);
  } finally {
    await harness.close(ctx);
  }
});

test("typing into a password field hands the step to the person on that page, and the card never shows what would be typed", async () => {
  const fake = fakeBrowser();
  fake.setProbe({ tag: "input", type: "password", accessibleName: "Password" });
  const handoffs = createBotHandoffs();
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("browser", {}, { id: "gateway" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("browser_type", { locator: "getByLabel('Password')", text: "hunter2" }, { id: "type" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("handed off"),
  ]);
  const rules: BotRule[] = [];
  const deps = await browserDeps(fake, {
    rules: () => rules,
    requestHandoff: (request) => handoffs.request(ruleHandoffRequest(request)),
  });
  const { harness, root } = await botTurn(deps, fauxModels);
  try {
    const run = await root.submit({ type: "input", content: "sign in" }, ctx);
    await waitFor(() => handoffs.pending(BOT).length === 1, { what: "the hand-off card" });
    const card = handoffs.pending(BOT)[0]!;
    assert.equal(card.rule?.id, "locked.credentials");
    assert.equal(JSON.stringify(card).includes("hunter2"), false);
    assert.deepEqual(card.open, { url: SLACK }, "Open takes the person to the page the Bot was on, in its own tab");
    handoffs.answer(BOT, card.waitId, { outcome: "done" });
    await run.wait(ctx);
    assert.equal(fake.commands.length, 0, "the Bot never typed it");
  } finally {
    await harness.close(ctx);
  }
});

test("a Bot's request carries only its newest three screenshots, and its transcript keeps every one", async () => {
  const fake = fakeBrowser();
  const seen: Array<{ images: number; notes: number }> = [];
  const looks = (context: { messages: readonly Message[] }) => {
    let images = 0;
    let notes = 0;
    for (const message of context.messages) {
      if (message.role !== "toolResult" || message.toolName !== "browser_snapshot") continue;
      for (const part of message.content) {
        if (part.type === "image") images += 1;
        else if (part.text === BOT_OLDER_SCREENSHOT_NOTE) notes += 1;
      }
    }
    seen.push({ images, notes });
  };
  const step = (reply: () => ReturnType<typeof fauxAssistantMessage>) => (context: { messages: readonly Message[] }) => {
    looks(context);
    return reply();
  };
  const snapshot = (id: string) => step(() => fauxAssistantMessage([fauxToolCall("browser_snapshot", {}, { id })], { stopReason: "toolUse" }));
  const fauxModels = createFauxModels([
    step(() => fauxAssistantMessage([fauxToolCall("browser", {}, { id: "gateway" })], { stopReason: "toolUse" })),
    snapshot("look-1"), snapshot("look-2"), snapshot("look-3"), snapshot("look-4"), snapshot("look-5"),
    step(() => fauxAssistantMessage("read it")),
  ]);
  const deps = await browserDeps(fake, { rules: () => defaultBotRules() });
  const { harness, root } = await botTurn(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "read my inbox" }, ctx)).wait(ctx);
    assert.deepEqual(seen.map(({ images }) => images), [0, 0, 1, 2, 3, 3, 3]);
    assert.deepEqual(seen[seen.length - 1], { images: 3, notes: 2 }, "the two oldest screenshots became notes");
    const kept = (await toolResults(root)).filter((result) => result.toolName === "browser_snapshot");
    assert.equal(kept.length, 5);
    for (const result of kept) {
      assert.ok((result.content as Array<{ type?: string }>).some((part) => part.type === "image"), "the transcript keeps every screenshot");
    }
  } finally {
    await harness.close(ctx);
  }
});
