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
// Name each step on stderr, so a stalled run says where it stopped.
const step = (name: string) => console.error(`[bot-browser] ${name}`);
const deadline = setTimeout(() => {
  step("deadline reached");
  app.exit(2);
}, 60_000);

const BOT = "bot:ada";
const BOT_WORKSPACE = "bot-home-ada";
const PERSON_WORKSPACE = "person";
const FIELD = "position:absolute;width:240px;height:44px;border:0;background:rgb(255,0,0);color:rgb(255,0,0)";

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title><style>html,body{margin:0;background:#fff}</style></head><body>${body}</body></html>`;
}

/**
 * The secrets found in what a snapshot shows: its strings, without Chromium's
 * node ids and the element refs. Those are counters, so a short code such as a
 * card's "737" can turn up in one by chance (node 4737).
 */
const NODE_ID_KEYS = new Set(["nodeId", "parentId", "childIds", "ref"]);
function leakedIn(secrets: readonly string[], ...parts: unknown[]): string[] {
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([key, item]) => (NODE_ID_KEYS.has(key) ? [] : strings(item)))
          : [];
  const shown = strings(parts);
  return secrets.filter((secret) => shown.some((text) => text.includes(secret)));
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
    case "/card-notes":
      // Card fields with text inside them: a textarea's default, or a framework's copy of what was typed.
      return html(`<form><label>Card number <textarea autocomplete="cc-number">4111111111111111</textarea></label>
        <label>Security code <textarea autocomplete="cc-csc">737</textarea></label><button type="button">Pay</button></form>`);
    case "/card-table":
      // A table-layout sign-in and payment form, and a checkbox whose label holds a card field:
      // Chromium names each cell, row and the checkbox with the field's live value.
      return html(`<form><table>
        <tr><td>Password</td><td><input id="pw" type="password"></td></tr>
        <tr><td>Code</td><td><input id="code" autocomplete="one-time-code"></td></tr>
        <tr><td>Card</td><td><input id="number" autocomplete="cc-number"></td></tr></table>
        <label><input type="checkbox"> Save <input id="saved" autocomplete="cc-number"></label>
        <div role="button" tabindex="0"><textarea autocomplete="cc-csc">737</textarea></div>
        <button type="button">Pay</button></form>
        <script>for(const [id,value] of [["pw","hunter2xyz"],["code","550071"],["number","4000123412341234"],["saved","5555444433332222"]])document.getElementById(id).value=value;</script>`);
    case "/covered":
      // A card field laid over its floating label; Playwright's hit-target error previews it.
      return html(`<div style="position:relative;width:300px;height:60px">
        <label id="float" for="cc" style="position:absolute;left:8px;top:8px">Card number</label>
        <input id="cc" autocomplete="cc-number" value="4111111111111111" style="position:absolute;left:0;top:0;width:300px;height:40px;background:transparent"></div>`);
    case "/framed":
      return html(`<p>Payment</p><iframe title="Pay" src="http://localhost:${port}/inner" style="width:300px;height:200px;border:0"></iframe>`);
    case "/inner":
      return html('<input type="password" value="frame-secret" aria-label="Frame password">');
    case "/reveal":
      // A "show password" toggle turns the field into plain text.
      return html(`
        <input id="secret" type="password" value="open-sesame-77" aria-label="Password" style="left:20px;top:20px;${FIELD}">
        <button id="show" onclick="const f=document.getElementById('secret');f.type=f.type==='password'?'text':'password'" style="position:absolute;left:320px;top:20px;width:120px;height:44px">Show</button>
        <div id="control" style="position:absolute;left:20px;top:100px;width:240px;height:44px;background:rgb(255,0,0)"></div>
        <script>const after=Number(new URLSearchParams(location.search).get("show"));if(after>0)setTimeout(()=>document.getElementById("show").click(),after);</script>`);
    case "/reveal-table":
      // A table-layout sign-in row and a password field inside a role=button, both with no
      // sensitive autocomplete; "Show" turns them into plain text.
      return html(`<table><tr><td>Password</td><td><input id="secret" type="password"></td></tr></table>
        <div role="button" tabindex="0"><input id="pin" type="password"></div>
        <button id="show" type="button" onclick="for(const f of document.querySelectorAll('#secret,#pin'))f.type='text'">Show</button>`);
    case "/saved-card":
      // Rendered on the server with the saved card month and a saved choice marked.
      return html(`<form><select id="exp" autocomplete="cc-exp-month">${Array.from({ length: 12 }, (_, index) => `<option${index === 4 ? " selected" : ""}>${String(index + 1).padStart(2, "0")}</option>`).join("")}</select>
        <label><input id="keep" type="checkbox" checked> Keep me signed in</label></form>`);
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
  step("1 sign-in isolation");
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
    return {
      note: login.imageNote,
      password: pixel(140, 42),
      otp: pixel(140, 122),
      card: pixel(140, 202),
      control: pixel(140, 322),
      leaked: leakedIn(["hunter2-secret", "481516", "4242424242424242"], login),
    };
  };
  step("2 masking");
  await navigate(BOT_WORKSPACE, botTab, `${origin}/login`);
  const masking = loginAsSeen(await snapshot(botTab));
  step("2 typing");
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
  // A locator can't tell what a card field holds by the text inside it, and
  // one that matches both card fields is refused without quoting either.
  step("2 text locators");
  await navigate(BOT_WORKSPACE, botTab, `${origin}/card-notes`);
  const waitFor = (locator: string) => outcome(agent({ action: "wait", tabId: botTab, locator, timeoutMs: 300 }));
  const textLocators = {
    right: [await waitFor("text=4111"), await waitFor('label:has-text("4111")'), await waitFor('form >> internal:has-text="737"i')],
    wrong: [await waitFor("text=9999"), await waitFor('label:has-text("9999")'), await waitFor('form >> internal:has-text="999"i')],
    xpath: await waitFor("xpath=//textarea[starts-with(.,'4111')]"),
    label: await waitFor('internal:label="Card number"i'),
    button: await waitFor("text=Pay"),
    both: await outcome(agent({ action: "scroll", tabId: botTab, locator: "textarea", deltaX: 0, deltaY: 10 })),
  };
  // Role names can't tell a field's live value apart either, and the
  // snapshot names no element with one, in its accessibility tree or locators.
  await navigate(BOT_WORKSPACE, botTab, `${origin}/card-table`);
  const roleLocators = {
    right: [
      await waitFor("internal:role=cell[name=/^hunter/]"),
      await waitFor("internal:role=row[name=/Password h/]"),
      await waitFor("internal:role=checkbox[name=/Save 5555/]"),
      await waitFor('form >> internal:has="internal:role=cell[name=/^4000/]"'),
    ],
    wrong: [
      await waitFor("internal:role=cell[name=/^zzzz/]"),
      await waitFor("internal:role=row[name=/Password z/]"),
      await waitFor("internal:role=checkbox[name=/Save 9999/]"),
      await waitFor('form >> internal:has="internal:role=cell[name=/^9999/]"'),
    ],
    button: await waitFor('internal:role=button[name="Pay"i]'),
    cell: await waitFor('internal:role=cell[name="Password"i]'),
  };
  const table = await snapshot(botTab);
  const tableSeen = {
    leaked: leakedIn(["hunter2xyz", "550071", "4000123412341234", "5555444433332222", "737"], table.text, table.elements, table.accessibilityTree),
    // Each element's locator still finds it for the Bot.
    found: await Promise.all(table.elements.map((element) => outcome(agent({ action: "wait", tabId: botTab, locator: element.selector, timeoutMs: 300 })))),
    // The name the Bot's rules see for a click on the checkbox, and on Pay.
    probed: {
      checkbox: (await browser.probeAgentTarget(BOT_WORKSPACE, botTab, { locator: "internal:role=checkbox", click: true }))?.accessibleName,
      button: (await browser.probeAgentTarget(BOT_WORKSPACE, botTab, { locator: 'internal:role=button[name="Pay"i]', click: true }))?.accessibleName,
    },
  };
  // A card field over the Bot's target: the error says so without describing the field.
  await navigate(BOT_WORKSPACE, botTab, `${origin}/covered`);
  await navigate(PERSON_WORKSPACE, personTab, `${origin}/covered`);
  const covered = {
    bot: await outcome(agent({ action: "click", tabId: botTab, locator: "#float", timeoutMs: 300 })),
    // A workspace chat's agent on the person's browser gets Playwright's own message.
    unbounded: await outcome(browser.command(PERSON_WORKSPACE, { action: "click", tabId: personTab, locator: "#float", timeoutMs: 300 }, { source: "agent" })),
  };

  // 3. A visible cross-site frame can't be inspected for fields: the image is dropped, with a note.
  step("3 cross-site frame");
  await navigate(BOT_WORKSPACE, botTab, `${origin}/framed`);
  const framed = await snapshot(botTab);
  const frame = {
    image: framed.image !== undefined,
    note: framed.imageNote,
    leaked: JSON.stringify(framed).includes("frame-secret"),
  };

  // 4. A tab the person holds (signing in) refuses the Bot until it is released;
  // after that the Bot sees it again, still masked.
  step("4 hold");
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

  // 5. A field the page turns into plain text ("show password") stays covered,
  // whether the Bot saw it as a password field first or the person showed it
  // on a tab they held, on a page the Bot never saw.
  step("5 show password");
  const revealAsSeen = (shot: BrowserSnapshot) => {
    assert.ok(shot.image, `reveal image: ${shot.imageNote}`);
    const decoded = nativeImage.createFromBuffer(Buffer.from(shot.image.data, "base64"));
    const size = decoded.getSize();
    const bitmap = decoded.toBitmap();
    const scale = size.width / shot.tab.viewport.width;
    const pixel = (x: number, y: number) => {
      const offset = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4;
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
    };
    return { field: pixel(140, 42), control: pixel(140, 122), leaked: JSON.stringify(shot).includes("open-sesame-77") };
  };
  await navigate(BOT_WORKSPACE, botTab, `${origin}/reveal`);
  await snapshot(botTab);
  await agent({ action: "click", tabId: botTab, selector: "#show" });
  const shownByBot = revealAsSeen(await snapshot(botTab));
  // What the approval of the Bot's typing and the rules read first, as in a Bot's call.
  const probedShownByBot = (await browser.probeAgentTarget(BOT_WORKSPACE, botTab, { selector: "#secret" }))?.type;
  const typingShownByBot = await outcome(agent({ action: "type", tabId: botTab, selector: "#secret", text: "guess" }));
  browser.hold(BOT_WORKSPACE, botTab, { holdId: "wait-2", reason: "sign_in" });
  // The person reads the page, then presses Show (the page shows the field after 2 s).
  await navigate(BOT_WORKSPACE, botTab, `${origin}/reveal?show=2000`);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const shownType = (await user(BOT_WORKSPACE, { action: "evaluate", tabId: botTab, expression: "document.getElementById('secret').type" })).value;
  // They leave the cursor in the field.
  await user(BOT_WORKSPACE, { action: "evaluate", tabId: botTab, expression: "document.getElementById('secret').focus()" });
  browser.release(BOT_WORKSPACE, "wait-2");
  const shownByPerson = revealAsSeen(await snapshot(botTab));
  // A printable key into the focused field is typing too (asked before anything else touches the field).
  const pressingShownByPerson = await outcome(agent({ action: "press", tabId: botTab, key: "x" }));
  const typingShownByPerson = await outcome(agent({ action: "type", tabId: botTab, selector: "#secret", text: "guess" }));
  // What an approval and the rules read about the field.
  const probedType = (await browser.probeAgentTarget(BOT_WORKSPACE, botTab, { selector: "#secret" }))?.type;
  const reveal = { shownByBot, probedShownByBot, typingShownByBot, shownByPerson, pressingShownByPerson, typingShownByPerson, shownType, probedType };
  // A remembered field is marked before any Bot locator runs, not only before
  // typing: a wait, a scroll's target and the snapshot's own locators. Each is
  // checked on a page nothing has marked yet: the Bot reads it while the fields
  // are password fields, then the person types the password and presses Show.
  step("5 remembered fields and locators");
  const shownTable = async () => {
    await navigate(BOT_WORKSPACE, botTab, `${origin}/reveal-table`);
    await snapshot(botTab);
    const shown = await user(BOT_WORKSPACE, {
      action: "evaluate", tabId: botTab,
      expression: "for(const f of document.querySelectorAll('#secret,#pin'))f.value='hunter2xyz';document.getElementById('show').click();document.getElementById('secret').type",
    });
    return shown.value;
  };
  const rowNamed = (prefix: string) => `internal:role=row[name=/Password ${prefix}/]`;
  // A scroll's target waits 15 s for its element; the call is cut short instead.
  const scrollTo = (locator: string) =>
    outcome(browser.command(BOT_WORKSPACE, { action: "scroll", tabId: botTab, locator, deltaX: 0, deltaY: 10 }, {
      source: "agent", credentialBoundary: true, signal: AbortSignal.timeout(800),
    }));
  const shownAs = [await shownTable()];
  const rememberedWait = { right: await waitFor(rowNamed("hunt")), wrong: await waitFor(rowNamed("zzzz")) };
  shownAs.push(await shownTable());
  const rememberedScroll = { right: await scrollTo(rowNamed("hunt")), wrong: await scrollTo(rowNamed("zzzz")) };
  shownAs.push(await shownTable());
  const shownTableSnapshot = await snapshot(botTab);
  const remembered = {
    shownAs,
    wait: rememberedWait,
    scroll: rememberedScroll,
    snapshot: {
      leaked: JSON.stringify([shownTableSnapshot.text, shownTableSnapshot.elements, shownTableSnapshot.accessibilityTree]).includes("hunter2xyz"),
      found: await Promise.all(shownTableSnapshot.elements.map((element) => waitFor(element.selector))),
    },
  };

  // A page that marks the saved card month: a Bot's wait can't test which one.
  await navigate(BOT_WORKSPACE, botTab, `${origin}/saved-card`);
  const savedMonth = {
    right: await waitFor("#exp option:nth-child(5)[selected]"),
    wrong: await waitFor("#exp option:nth-child(6)[selected]"),
    role: await waitFor("internal:role=checkbox[checked=true]"),
    // The approval probe refuses it too, so no card asks about a click it would refuse.
    probe: await outcome(browser.probeAgentTarget(BOT_WORKSPACE, botTab, { locator: "#exp option:nth-child(5)[selected]", click: true })),
  };

  // 6. Deleting the Bot clears its sign-ins and closes its tabs; the person's stay.
  step("6 delete");
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
        isolation, masking, typing, noteTyping, pressing, navigationKey, refused, textLocators, roleLocators, tableSeen, covered, frame,
        hold: { heldState, held, personMayUse, afterRelease, heldTraces },
        reveal,
        remembered,
        savedMonth,
        cleared,
        expected: {
          heldRefusal: boundary.BROWSER_HELD_TAB_REFUSED,
          typingRefusal: boundary.BROWSER_SENSITIVE_TYPING_REFUSED,
          actionRefusal: boundary.BROWSER_BOUNDARY_ACTION_REFUSED,
          valueSelectorRefusal: boundary.BROWSER_VALUE_SELECTOR_REFUSED,
          xpathRefusal: boundary.BROWSER_XPATH_SELECTOR_REFUSED,
          stateRefusal: boundary.BROWSER_STATE_SELECTOR_REFUSED,
          coveredTarget: boundary.BROWSER_COVERED_TARGET,
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
