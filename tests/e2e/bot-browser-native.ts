// A Bot's own browser in real Electron: its partition, its credential
// boundary and its holds. Bundled by bot-browser.spec.ts and run as a
// standalone Electron main process, so no unrelated application service starts.
//
// Pages come from a loopback server: `127.0.0.1` serves the pages and
// `localhost` the cross-site frame, which Chromium puts in its own process.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { app, BrowserWindow, nativeImage, session } from "electron";
import type { BrowserCommand, BrowserCommandResult, BrowserSnapshot } from "../../renderer/shared/browser";

const root = process.env.AIDEN_BOT_BROWSER_ROOT!;
await mkdir(path.join(root, "user-data"), { recursive: true });
app.setPath("userData", path.join(root, "user-data"));
const deadline = setTimeout(() => app.exit(2), 60_000);

const BOT = "bot:ada";
const BOT_WORKSPACE = "bot-home-ada";
const PERSON_WORKSPACE = "person";
const FIELD = "position:absolute;width:240px;height:44px;border:0;background:rgb(255,0,0);color:rgb(255,0,0)";

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title><style>html,body{margin:0;background:#fff}</style></head><body>${body}</body></html>`;
}

function serve(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://fixture");
  const html = (body: string, headers: Record<string, string> = {}) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
    response.end(page(body));
  };
  switch (url.pathname) {
    case "/sign-in":
      // The site signs the visitor in with a session cookie.
      return html("<p>Signed in</p>", { "set-cookie": `sid=${url.searchParams.get("who") ?? "anon"}; Path=/; HttpOnly` });
    case "/whoami":
      return html(`<p id="who">cookie: ${request.headers.cookie ?? "none"}</p>`);
    case "/login":
      return html(`
        <div id="control" style="position:absolute;left:20px;top:300px;width:240px;height:44px;background:rgb(255,0,0)"></div>
        <input id="password" type="password" value="hunter2-secret" aria-label="Password" style="left:20px;top:20px;${FIELD}">
        <input id="otp" autocomplete="one-time-code" value="481516" aria-label="Code" style="left:20px;top:100px;${FIELD}">
        <input id="card" autocomplete="cc-number" value="4242424242424242" aria-label="Card" style="left:20px;top:180px;${FIELD}">
        <input id="note" aria-label="Note" style="position:absolute;left:320px;top:20px;width:240px;height:44px">`);
    case "/callback":
      // A sign-in's last step: a one-time code in the address, which the page logs.
      return html(`<p>Signing you in…</p><script>console.log("sign-in code", ${JSON.stringify(url.searchParams.get("code") ?? "")})</script>`);
    case "/framed":
      return html(`<p>Payment</p><iframe title="Pay" src="http://localhost:${port}/inner" style="width:300px;height:200px;border:0"></iframe>`);
    case "/inner":
      return html('<input type="password" value="frame-secret" aria-label="Frame password">');
    default:
      response.writeHead(404).end();
  }
}

const server = createServer(serve);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const origin = `http://127.0.0.1:${port}`;

void app.whenReady().then(async () => {
  const { BrowserService } = await import("../../main/services/browser/service");
  const { configStore } = await import("../../main/services/config-store");
  const { registerBotBrowserWorkspace } = await import("../../main/services/browser/bot-workspaces");
  const { botBrowserPartition } = await import("../../main/services/browser/bot-profile");
  const { browserPartition } = await import("../../main/services/browser/core");
  const boundary = await import("../../main/services/browser/credential-boundary");
  // Only the person's workspace is configured; the Bot's is admitted by registration.
  configStore.getWorkspace = async (id: string) =>
    (id === PERSON_WORKSPACE ? { id } : undefined) as Awaited<ReturnType<typeof configStore.getWorkspace>>;
  registerBotBrowserWorkspace(BOT_WORKSPACE, BOT);

  const browser = new BrowserService();
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  await window.loadURL("about:blank");
  window.show();
  const owner = {
    id: window.webContents.id, documentId: "bot-browser-native",
    isDestroyed: () => window.isDestroyed(), send: () => {}, onInvalidated: () => () => {},
  };
  browser.transferOwner(BOT_WORKSPACE, owner);
  browser.attachOwner(PERSON_WORKSPACE, owner);

  const user = (workspaceId: string, command: BrowserCommand) => browser.command(workspaceId, command, { source: "user", owner });
  const agent = (command: BrowserCommand) =>
    browser.command(BOT_WORKSPACE, command, { source: "agent", credentialBoundary: true, supportsImages: true });
  const navigate = (workspaceId: string, tabId: string, url: string) =>
    user(workspaceId, { action: "navigate", tabId, url, readiness: "load" });
  const opened = async (workspaceId: string, url: string): Promise<string> => {
    const result: BrowserCommandResult = await user(workspaceId, { action: "create", show: false });
    assert.ok(result.tabId);
    await user(workspaceId, { action: "present", tabId: result.tabId, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    await navigate(workspaceId, result.tabId, url);
    return result.tabId;
  };
  const snapshot = async (tabId: string): Promise<BrowserSnapshot> => {
    const result = await agent({ action: "snapshot", tabId, includeImage: true });
    assert.ok(result.snapshot);
    return result.snapshot;
  };
  const cookieNames = async (partition: string) =>
    (await session.fromPartition(partition).cookies.get({})).map((cookie) => `${cookie.name}=${cookie.value}`).sort();

  // 1. The Bot signs in to a site in its own browser; the person's browser stays signed out.
  const botTab = await opened(BOT_WORKSPACE, `${origin}/sign-in?who=bot`);
  const botProfile = browser.getState(BOT_WORKSPACE).tabs[0]?.profileId;
  const personTab = await opened(PERSON_WORKSPACE, `${origin}/whoami`);
  const personSees = (await user(PERSON_WORKSPACE, { action: "snapshot", tabId: personTab })).snapshot?.text ?? "";
  await navigate(PERSON_WORKSPACE, personTab, `${origin}/sign-in?who=person`);
  await navigate(BOT_WORKSPACE, botTab, `${origin}/whoami`);
  const botSees = (await snapshot(botTab)).text;
  const isolation = {
    botProfile,
    personSees: personSees.trim(),
    botSees: botSees.trim(),
    botCookies: await cookieNames(botBrowserPartition(BOT)),
    personCookies: await cookieNames(browserPartition("default", false)),
  };

  // 2. Password, one-time code and card fields are painted over; their values never leave main.
  /** The login page as the Bot's snapshot shows it: the colour over each field, and any secret in the result. */
  const loginAsSeen = (login: BrowserSnapshot) => {
    assert.ok(login.image, `login image: ${login.imageNote}`);
    const decoded = nativeImage.createFromBuffer(Buffer.from(login.image.data, "base64"));
    const size = decoded.getSize();
    const bitmap = decoded.toBitmap();
    const scale = size.width / login.tab.viewport.width;
    const pixel = (x: number, y: number) => {
      const offset = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4;
      // BGRA
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
    };
    const serialized = JSON.stringify(login);
    return {
      note: login.imageNote,
      password: pixel(140, 42),
      otp: pixel(140, 122),
      card: pixel(140, 202),
      control: pixel(140, 322),
      leaked: ["hunter2-secret", "481516", "4242424242424242"].filter((secret) => serialized.includes(secret)),
    };
  };
  await navigate(BOT_WORKSPACE, botTab, `${origin}/login`);
  const masking = loginAsSeen(await snapshot(botTab));
  const outcome = (run: Promise<unknown>) => run.then(() => "ran", (error: Error) => error.message);
  const typing = await outcome(agent({ action: "type", tabId: botTab, selector: "#password", text: "guess" }));
  const noteTyping = await outcome(agent({ action: "type", tabId: botTab, selector: "#note", text: "fine" }));
  // A key press into a focused password field is typing too; a non-printing key is not.
  await agent({ action: "click", tabId: botTab, selector: "#password" });
  const pressing = await outcome(agent({ action: "press", tabId: botTab, key: "x" }));
  const navigationKey = await outcome(agent({ action: "press", tabId: botTab, key: "Tab" }));
  // Main refuses what could read a field or leave the page, whatever the tools offer.
  const refused = {
    evaluate: await outcome(agent({ action: "evaluate", tabId: botTab, expression: "document.querySelector('#password').value" })),
    record: await outcome(agent({ action: "record_start", tabId: botTab })),
    openFile: await outcome(agent({ action: "open_file", path: path.join(root, "result.json") })),
    valueSelector: await outcome(agent({ action: "click", tabId: botTab, selector: "input[value^='hunter']" })),
    // An agent command on a Bot's browser without the boundary (a workspace chat's tools).
    unbounded: await outcome(browser.command(BOT_WORKSPACE, { action: "snapshot", tabId: botTab }, { source: "agent", supportsImages: true })),
  };

  // 3. A visible cross-site frame can't be inspected for fields: the image is dropped, with a note.
  await navigate(BOT_WORKSPACE, botTab, `${origin}/framed`);
  const framed = await snapshot(botTab);
  const frame = {
    image: framed.image !== undefined,
    note: framed.imageNote,
    leaked: JSON.stringify(framed).includes("frame-secret"),
  };

  // 4. A tab the person holds (signing in) refuses the Bot until it is released;
  // after that the Bot sees it again, still masked.
  await navigate(BOT_WORKSPACE, botTab, `${origin}/login`);
  browser.hold(BOT_WORKSPACE, botTab, { holdId: "wait-1", reason: "sign_in" });
  const heldState = browser.getState(BOT_WORKSPACE).tabs.find((tab) => tab.id === botTab)?.heldForPerson;
  const held = await snapshot(botTab).then(() => "read", (error: Error) => error.message);
  const personMayUse = await user(BOT_WORKSPACE, { action: "snapshot", tabId: botTab }).then(() => true, () => false);
  // What the person's own steps on the held tab load and log stays theirs.
  await navigate(BOT_WORKSPACE, botTab, `${origin}/callback?code=held-sign-in-code`);
  await navigate(BOT_WORKSPACE, botTab, `${origin}/login`);
  browser.release(BOT_WORKSPACE, "wait-1");
  const released = await snapshot(botTab).catch((error: Error) => error.message);
  const afterRelease = typeof released === "string" ? released : loginAsSeen(released);
  const heldTraces = typeof released === "string" ? null : JSON.stringify(released).includes("held-sign-in-code");

  // 5. Deleting the Bot clears its sign-ins and closes its tabs; the person's stay.
  await browser.clearBotProfile(BOT, BOT_WORKSPACE);
  const cleared = {
    botCookies: await cookieNames(botBrowserPartition(BOT)),
    personCookies: await cookieNames(browserPartition("default", false)),
    botTabs: browser.getState(BOT_WORKSPACE).tabs.length,
    personTabs: browser.getState(PERSON_WORKSPACE).tabs.length,
  };

  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify(
      {
        electron: process.versions.electron, platform: process.platform,
        isolation, masking, typing, noteTyping, pressing, navigationKey, refused, frame,
        hold: { heldState, held, personMayUse, afterRelease, heldTraces },
        cleared,
        expected: {
          heldRefusal: boundary.BROWSER_HELD_TAB_REFUSED,
          typingRefusal: boundary.BROWSER_SENSITIVE_TYPING_REFUSED,
          actionRefusal: boundary.BROWSER_BOUNDARY_ACTION_REFUSED,
          valueSelectorRefusal: boundary.BROWSER_VALUE_SELECTOR_REFUSED,
          frameNote: boundary.BROWSER_IMAGE_OMITTED.frame,
          maskedNote: boundary.BROWSER_IMAGE_MASKED_NOTE,
        },
      },
      null,
      2,
    ),
  );
  server.close();
  window.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
