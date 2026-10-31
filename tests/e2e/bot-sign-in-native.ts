// A Bot's sign-in in real Electron: the `sign_in` tool asks, the card's Open
// sign-in opens the site in a new tab of the Bot's own browser held for the
// person, the Bot can neither see nor read that tab until they answer, and
// afterwards the Bot's browser has their sign-in while the person's own
// browser does not. Bundled by bot-sign-in.spec.ts and run as a standalone
// Electron main process, so no unrelated application service starts.
//
// Sign-in sites are always public https origins, so the site is served by
// intercepting https in the two browser sessions: nothing leaves the machine.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, session } from "electron";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BrowserCommand, BrowserState } from "../../renderer/shared/browser";

const root = process.env.AIDEN_BOT_SIGN_IN_ROOT!;
await mkdir(path.join(root, "user-data"), { recursive: true });
app.setPath("userData", path.join(root, "user-data"));
const deadline = setTimeout(() => app.exit(2), 60_000);

const BOT = "bot:ada";
const BOT_WORKSPACE = "bot-home-ada";
const PERSON_WORKSPACE = "person";
const SITE = "accounts.example.com";
const ONE_TIME_CODE = "held-callback-code";

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Example accounts</title></head><body>${body}</body></html>`;
}

/** The site: a login form, a callback that signs the visitor in, and a page that says who they are. */
function serve(request: Request): Response {
  const url = new URL(request.url);
  const html = (body: string) => new Response(page(body), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (url.host !== SITE) return new Response("Not served by this fixture", { status: 404 });
  switch (url.pathname) {
    case "/":
      return html('<form><label>Password <input id="password" type="password" value="person-password"></label></form>');
    case "/callback":
      // The site's sign-in sets its session cookie here.
      return html(`<p>Signed in</p><script>document.cookie = "sid=person-session; path=/; secure"</script>`);
    case "/whoami":
      return html(`<p id="who"></p><script>who.textContent = "cookie: " + (document.cookie || "none")</script>`);
    default:
      return new Response("", { status: 404 });
  }
}

const textOf = (result: AgentToolResult<unknown>) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > 15_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

void app.whenReady().then(async () => {
  const { BrowserService } = await import("../../main/services/browser/service");
  const { configStore } = await import("../../main/services/config-store");
  const { botBrowserPartition } = await import("../../main/services/browser/bot-profile");
  const { browserPartition } = await import("../../main/services/browser/core");
  const boundary = await import("../../main/services/browser/credential-boundary");
  const { createBotHandoffs } = await import("../../main/services/bot-runtime/bot-handoffs");
  const { signInCandidate } = await import("../../main/services/bot-runtime/bot-sign-in-tool");
  const { createBotBrowserHandoffOpener } = await import("../../main/services/bot-runtime/bot-browser-handoff");
  const { openBotHandoff } = await import("../../main/services/bot-runtime/bot-handoff-open");
  const { createBotBrowser, BOT_BROWSER_HELD_TAB_TITLE } = await import("../../main/services/bot-runtime/bot-browser-tools");
  const { signInDoneText } = await import("../../main/services/bot-runtime/bot-handoff-text");

  for (const partition of [botBrowserPartition(BOT), browserPartition("default", false)]) {
    session.fromPartition(partition).protocol.handle("https", serve);
  }
  // Only the person's workspace is configured; the Bot's is admitted by its browser tools.
  configStore.getWorkspace = async (id: string) =>
    (id === PERSON_WORKSPACE ? { id } : undefined) as Awaited<ReturnType<typeof configStore.getWorkspace>>;

  const browser = new BrowserService();
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  await window.loadURL("about:blank");
  window.show();
  const owner = {
    id: window.webContents.id, documentId: "bot-sign-in-native",
    isDestroyed: () => window.isDestroyed(), send: () => {}, onInvalidated: () => () => {},
  };
  browser.attachOwner(PERSON_WORKSPACE, owner);
  const user = (workspaceId: string, command: BrowserCommand) => browser.command(workspaceId, command, { source: "user", owner });
  const loaded = (tabId: string, pathname: string) =>
    until(() => {
      const tab = browser.getState(BOT_WORKSPACE).tabs.find((candidate) => candidate.id === tabId);
      return tab && !tab.loading && new URL(tab.url || "about:blank").pathname === pathname ? tab : undefined;
    }, `the tab on ${pathname}`);

  // The Bot's own browser tools, as a Bot turn gets them.
  const botBrowser = createBotBrowser({ service: async () => browser, mintOwner: () => owner });
  const tools = new Map<string, AgentTool>(
    (await botBrowser.candidates(BOT, {
      workspaceId: BOT_WORKSPACE, chatId: "chat-ada", generationId: "generation-1", supportsImages: false, botName: "Ada",
    })).map(({ tool }) => [tool.name, tool]),
  );
  let calls = 0;
  const call = async (name: string, params: Record<string, unknown> = {}) =>
    textOf(await tools.get(name)!.execute(`call-${(calls += 1)}`, params as never, undefined, undefined));
  const outcome = (run: Promise<unknown>) => run.then(() => "ran", (error: Error) => error.message);
  const botStatus = (tabId: string) =>
    call("browser_status", { tabId }).then((text) => JSON.parse(text) as { url: string | null; title: string | null });
  await call("browser");

  // 1. The Bot asks: the sign_in tool shows its card and waits.
  const handoffs = createBotHandoffs();
  const signIn = signInCandidate(BOT, handoffs, { botName: async () => "Ada" });
  const memos = new Map<string, unknown>();
  const turn = new AbortController();
  const asked = signIn.bind!({
    callId: "call-sign-in",
    signal: turn.signal,
    entries: async () => [],
    submissions: async () => [],
    appendEntry: async () => {},
    memo: async (name, candidate) => (memos.has(name) ? memos.get(name) : (memos.set(name, candidate), candidate)) as never,
  }).execute("call-sign-in", { site: `https://${SITE}/login?next=/settings`, why: "To read your project settings." } as never);
  const card = await until(() => handoffs.pending(BOT)[0], "the sign-in card");

  // 2. The person presses Open sign-in on the desktop.
  const opener = createBotBrowserHandoffOpener({
    service: async () => browser,
    handoffs,
    workspace: async () => BOT_WORKSPACE,
    hasBrowserAccess: async () => true,
    mintOwner: () => owner,
  });
  const elsewhere: string[] = [];
  const opened = await openBotHandoff(card, "desktop", {
    external: async (url) => void elsewhere.push(`external ${url}`),
    focusChat: async (botId) => void elsewhere.push(`chat ${botId}`),
    botBrowser: (botId, waitId, url, hold) => opener(botId, waitId, url, hold, owner),
  });
  const heldTab = await until(
    () => browser.getState(BOT_WORKSPACE).tabs.find((tab) => tab.heldForPerson !== undefined),
    "the held tab",
  );
  await user(BOT_WORKSPACE, { action: "present", tabId: heldTab.id, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  const onSite = await loaded(heldTab.id, "/");

  // 3. While the person signs in, the Bot can't read the tab or see where it is.
  const heldStatus = await botStatus(heldTab.id);
  const heldSnapshot = await outcome(call("browser_snapshot", { tabId: heldTab.id }));
  const heldNavigate = await outcome(call("browser_navigate", { tabId: heldTab.id, url: `https://${SITE}/whoami` }));
  await user(BOT_WORKSPACE, { action: "navigate", tabId: heldTab.id, url: `https://${SITE}/callback?code=${ONE_TIME_CODE}`, readiness: "load" });
  await loaded(heldTab.id, "/callback");
  const statusAfterCallback = await botStatus(heldTab.id);
  const gatewayWhileHeld = await call("browser");

  // 4. I'm signed in: the Bot gets its answer and its tab back.
  handoffs.answer(BOT, card.waitId, { outcome: "done" });
  const answer = textOf(await asked);
  const released = await until(
    () => (browser.getState(BOT_WORKSPACE).tabs.find((tab) => tab.id === heldTab.id)?.heldForPerson === undefined ? true : undefined),
    "the release",
  );
  await call("browser_navigate", { tabId: heldTab.id, url: `https://${SITE}/whoami` });
  const botSees = await call("browser_snapshot", { tabId: heldTab.id });

  // 5. The person's own browser never got the Bot's sign-in.
  const personTab = (await user(PERSON_WORKSPACE, { action: "create", show: false })).tabId!;
  await user(PERSON_WORKSPACE, { action: "present", tabId: personTab, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  await user(PERSON_WORKSPACE, { action: "navigate", tabId: personTab, url: `https://${SITE}/whoami`, readiness: "load" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const personSees = (await user(PERSON_WORKSPACE, { action: "snapshot", tabId: personTab })).snapshot?.text ?? "";
  const cookieNames = async (partition: string) =>
    (await session.fromPartition(partition).cookies.get({})).map((cookie) => `${cookie.name}=${cookie.value}`).sort();
  const state: BrowserState = browser.getState(BOT_WORKSPACE);
  assert.equal(state.tabs.length, 1, "the sign-in opened exactly one tab");

  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify(
      {
        electron: process.versions.electron, platform: process.platform,
        card: { kind: card.kind, action: card.action, why: card.why, origin: card.origin, open: card.open, target: card.target },
        opened, elsewhere,
        held: {
          reason: heldTab.heldForPerson?.reason,
          profileId: onSite.profileId,
          url: onSite.url,
          status: heldStatus,
          statusAfterCallback,
          gatewayMentionsSite: gatewayWhileHeld.includes(SITE),
          snapshot: heldSnapshot,
          navigate: heldNavigate,
        },
        answer, released,
        botSees: botSees.includes("cookie: sid=person-session"),
        botSeesPassword: botSees.includes("person-password"),
        personSees: personSees.trim(),
        botCookies: await cookieNames(botBrowserPartition(BOT)),
        personCookies: await cookieNames(browserPartition("default", false)),
        expected: {
          heldRefusal: boundary.BROWSER_HELD_TAB_REFUSED,
          heldTitle: BOT_BROWSER_HELD_TAB_TITLE,
          answer: signInDoneText(`https://${SITE}`, undefined, "browser"),
        },
      },
      null,
      2,
    ),
  );
  // Close the tabs first: with them still open, this process didn't exit.
  botBrowser.shutdown();
  await browser.shutdown();
  window.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
