import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import playwright, { type Browser, type Page } from "playwright";
import {
  autocompleteFieldTokens,
  isSensitiveField,
  quadsBounds,
  scanCredentialTree,
  scanSensitiveFieldReach,
  scanSensitiveFields,
  SensitiveFieldMemory,
  sensitiveFieldBoxes,
  sensitiveFieldIds,
  type CdpDomNode,
} from "./credential-fields.js";
import {
  assertBoundarySelector,
  boundaryRefusalOf,
  BROWSER_BOUNDARY_AUTHOR_NAMED_ROLES,
  BROWSER_LOCATOR_UNCHECKED_REFUSED,
  BROWSER_OPAQUE_TYPING_REFUSED,
  BROWSER_RECALL_FIELD_FUNCTION,
  BROWSER_SENSITIVE_FIELD_SOURCE,
  BROWSER_SENSITIVE_TYPING_REFUSED,
  BROWSER_STATE_SELECTOR_REFUSED,
  BROWSER_VALUE_SELECTOR_REFUSED,
  BROWSER_XPATH_SELECTOR_REFUSED,
  browserBoundaryLocatorExpression,
  browserBoundarySelectorsExpression,
  browserTypingGuardSource,
  scrubBrowserSnapshot,
} from "./credential-boundary.js";
import type { BrowserTab } from "../../../renderer/shared/browser.js";
import { playwrightInjectedSource } from "./playwright-source.generated.js";

let nextId = 1;
function element(localName: string, attributes: Record<string, string> = {}, children: CdpDomNode[] = [], extra: Partial<CdpDomNode> = {}): CdpDomNode {
  return {
    backendNodeId: nextId++,
    nodeType: 1,
    nodeName: localName.toUpperCase(),
    localName,
    attributes: Object.entries(attributes).flat(),
    children,
    ...extra,
  };
}
function documentNode(children: CdpDomNode[]): CdpDomNode {
  return { backendNodeId: nextId++, nodeType: 9, nodeName: "#document", children };
}

/**
 * The bundled Playwright runtime installed in an isolated world of `page`,
 * as the browser service does, with Playwright's own matches (`plain`) and
 * the whole path a Bot's locator takes (`bot`: main's check, then the page),
 * each as the matched elements' ids.
 */
async function boundaryWorld(page: Page) {
  const options = { isUnderTest: false, sdkLanguage: "javascript", testIdAttributeName: "data-testid", stableRafCount: 1, browserName: "chromium", shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [] };
  const session = await page.context().newCDPSession(page);
  const frame = (await session.send("Page.getFrameTree")).frameTree.frame.id;
  const { executionContextId: contextId } = await session.send("Page.createIsolatedWorld", { frameId: frame, worldName: "aiden-browser", grantUniveralAccess: false });
  const run = async (expression: string): Promise<string> => {
    const result = await session.send("Runtime.evaluate", { expression, contextId, returnByValue: true });
    if (result.exceptionDetails) {
      const refused = boundaryRefusalOf(new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
      return `error: ${(refused as Error).message}`;
    }
    return String(result.result.value);
  };
  await run(`(() => { const module = {exports:{}}; ${playwrightInjectedSource}\n globalThis.__aidenPlaywright = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(options)}); })()`);
  const elementId = (element: string) => `(()=>{const e=${element};return e?e.id||e.localName:"none";})()`;
  const plain = (selector: string) =>
    run(`(()=>{const p=globalThis.__aidenPlaywright;return p.querySelectorAll(p.parseSelector(${JSON.stringify(selector)}),document).map(e=>e.id||e.localName).join(",")||"none";})()`);
  const bot = async (selector: string): Promise<string> => {
    try {
      assertBoundarySelector(selector);
    } catch (error) {
      return `refused: ${(error as Error).message}`;
    }
    return run(elementId(browserBoundaryLocatorExpression(selector)));
  };
  return { session, contextId, run, plain, bot, elementId };
}

test("password inputs and credential, one-time code and card autocomplete fields are sensitive", () => {
  const sensitive = [
    element("input", { type: "password" }),
    element("input", { type: " PassWord " }),
    element("input", { type: "text", autocomplete: "one-time-code" }),
    element("input", { autocomplete: "section-login current-password" }),
    element("input", { autocomplete: "new-password webauthn" }),
    element("input", { autocomplete: "billing cc-number" }),
    element("input", { autocomplete: "shipping cc-csc" }),
    element("select", { autocomplete: "cc-exp-month" }),
    element("div", { contenteditable: "true", autocomplete: "one-time-code" }),
  ];
  for (const node of sensitive) assert.equal(isSensitiveField(node), true, JSON.stringify(node.attributes));
  const ordinary = [
    element("input", { type: "text", name: "password" }),
    element("input", { type: "email", autocomplete: "username" }),
    element("input", { autocomplete: "shipping postal-code" }),
    element("input", { autocomplete: "section-cc tel" }),
    element("div", { type: "password" }),
    element("input", { type: "search", "aria-label": "Password manager search" }),
  ];
  for (const node of ordinary) assert.equal(isSensitiveField(node), false, JSON.stringify(node.attributes));
  assert.deepEqual(autocompleteFieldTokens("section-a billing CC-Number"), ["cc-number"]);
});

test("the walker finds fields in shadow roots and same-process frames, and reports unreadable frames", () => {
  const shadowPassword = element("input", { type: "password" });
  const framed = element("input", { autocomplete: "one-time-code" });
  const card = element("input", { autocomplete: "cc-number" });
  const templated = element("input", { type: "password" });
  const remote = element("iframe", { src: "https://pay.example/" }, [], { frameId: "remote" });
  const embed = element("embed", { type: "application/pdf" });
  const host = element("login-form", {}, [], { shadowRoots: [{ backendNodeId: nextId++, nodeType: 11, nodeName: "#document-fragment", children: [shadowPassword] }] });
  const sameOrigin = element("iframe", { src: "/frame" }, [], { frameId: "local", contentDocument: documentNode([element("html", {}, [element("body", {}, [framed])])]) });
  const template = element("template", {}, [], { templateContent: documentNode([templated]) } as Partial<CdpDomNode>);
  const root = documentNode([element("html", {}, [element("body", {}, [host, sameOrigin, card, template, remote, embed])])]);
  const scan = scanCredentialTree(root);
  assert.deepEqual(scan.sensitive, [shadowPassword.backendNodeId, framed.backendNodeId, card.backendNodeId]);
  assert.deepEqual(scan.opaqueFrames, [remote.backendNodeId, embed.backendNodeId]);
});

test("a tab remembers the fields it saw per renderer process, newest kept", () => {
  const memory = new SensitiveFieldMemory();
  memory.remember(7, [41, 42]);
  assert.deepEqual([...memory.of(7)], [41, 42]);
  assert.equal(memory.of(8).size, 0, "another process's node ids are other nodes");
  // A long-lived tab keeps a bounded memory: the latest fields stay, the oldest go.
  memory.remember(7, Array.from({ length: 10_000 }, (_, index) => 1_000 + index));
  assert.equal(memory.of(7).has(10_999), true);
  assert.equal(memory.of(7).has(41), false);
  assert.ok(memory.of(7).size < 10_000);
  // Seen again, an old field counts as recent.
  memory.remember(9, [5]);
  for (let process = 10; process < 100; process += 1) {
    memory.remember(process, [1]);
    memory.remember(9, [5]);
  }
  assert.equal(memory.of(9).has(5), true);
  assert.equal(memory.of(10).size, 0, "a process not seen for long is forgotten");
});

test("quads become one bounding box; degenerate quads are none", () => {
  assert.deepEqual(quadsBounds([[10, 20, 110, 20, 110, 60, 10, 60], [0, 70, 50, 70, 50, 90, 0, 90]]), { x: 0, y: 20, width: 110, height: 70 });
  assert.equal(quadsBounds([[5, 5, 5, 5, 5, 5, 5, 5]]), undefined);
  assert.equal(quadsBounds([]), undefined);
});

test("Chromium: boxes match where fields are drawn, hidden ones are skipped, and a cross-site frame is unreadable", { timeout: 30_000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const port = (server.address() as AddressInfo).port;
    if (request.url?.startsWith("/frame")) {
      response.end('<body style="margin:0"><input id="inner" autocomplete="one-time-code" style="position:absolute;left:10px;top:20px;width:100px;height:30px;border:0;padding:0"></body>');
      return;
    }
    const cross = request.url?.includes("cross") ? `<iframe src="http://localhost:${port}/frame" style="position:absolute;left:20px;top:420px;width:200px;height:100px;border:0"></iframe>` : "";
    response.end(`<body style="margin:0;height:3000px">
      <input id="pw" type="password" style="position:absolute;left:50px;top:300px;width:200px;height:40px;border:0;padding:0">
      <input id="card" autocomplete="cc-number" style="position:absolute;left:50px;top:360px;width:180px;height:30px;border:0;padding:0">
      <input id="gone" type="password" style="display:none">
      <input id="name" autocomplete="name" style="position:absolute;left:300px;top:300px;width:100px;height:30px">
      <iframe id="same" src="/frame" style="position:absolute;left:300px;top:100px;width:300px;height:150px;border:0"></iframe>
      <iframe src="http://localhost:${port}/frame" style="width:0;height:0;border:0"></iframe>
      ${cross}
    </body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let browser: Browser | undefined;
  try {
    // Electron isolates cross-site frames; Playwright turns that off unless asked.
    browser = await playwright.chromium.launch({ headless: true, args: ["--site-per-process"], ignoreDefaultArgs: ["--disable-site-isolation-trials"] });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.frameLocator("#same").locator("#inner").waitFor();
    await page.evaluate(() => window.scrollTo(0, 100));
    const session = await context.newCDPSession(page);
    const cdp = { call: (method: string, params?: Record<string, unknown>) => session.send(method as never, params as never) as Promise<unknown> };
    const result = await sensitiveFieldBoxes(cdp, { width: 800, height: 600 });
    // Three fields on the page (one `display:none`, so it has no box) and one in the same-process frame.
    assert.equal(result.sensitive.length, 4);
    assert.equal((await sensitiveFieldIds(cdp)).length, 4);
    const boxes = result.fields.map(({ box }) => box).sort((a, b) => a.y - b.y || a.x - b.x);
    assert.deepEqual(boxes, [
      { x: 310, y: 20, width: 100, height: 30 },
      { x: 50, y: 200, width: 200, height: 40 },
      { x: 50, y: 260, width: 180, height: 30 },
    ]);
    // A zero-size cross-site frame can't hold a visible field.
    assert.equal(result.opaqueFrames, 0);

    await page.goto(`http://127.0.0.1:${port}/?cross`);
    await page.waitForLoadState("load");
    const crossSite = await sensitiveFieldBoxes(cdp, { width: 800, height: 600 });
    assert.equal(crossSite.opaqueFrames, 1);
    // The cross-site frame's field is not readable from the page's process.
    assert.equal(crossSite.sensitive.length, 4);
  } finally {
    await browser?.close();
    server.close();
  }
});

test("Chromium: the in-page typing guard follows focus through shadow roots and frames", { timeout: 30_000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const port = (server.address() as AddressInfo).port;
    if (request.url?.startsWith("/card")) return void response.end('<input id="card" autocomplete="billing cc-number"><input id="plain">');
    if (request.url?.startsWith("/remote")) return void response.end('<input id="remote">');
    response.end(`<input id="pw" type="password"><input id="name" autocomplete="name"><div id="host"></div>
      <iframe id="same" src="/card"></iframe><iframe id="cross" src="http://localhost:${port}/remote"></iframe>
      <script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<input id="otp" autocomplete="one-time-code">';</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser: Browser | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ["--site-per-process"], ignoreDefaultArgs: ["--disable-site-isolation-trials"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await page.frameLocator("#same").locator("#card").waitFor();
    await page.frameLocator("#cross").locator("#remote").waitFor();
    const guard = (element: string): Promise<string> => page.evaluate<string>(`(()=>{${BROWSER_SENSITIVE_FIELD_SOURCE}${browserTypingGuardSource(element)}return "ok";})()`).catch((error: Error) => error.message);
    await page.focus("#name");
    assert.equal(await guard("null"), "ok");
    assert.match(await guard('document.getElementById("pw")'), new RegExp(BROWSER_SENSITIVE_TYPING_REFUSED.slice(0, 30)));
    await page.focus("#pw");
    assert.match(await guard("null"), /password, one-time code or card/u);
    await page.locator("#host").locator("#otp").focus();
    assert.match(await guard("null"), /password, one-time code or card/u);
    await page.frameLocator("#same").locator("#card").focus();
    assert.match(await guard("null"), /password, one-time code or card/u);
    await page.frameLocator("#same").locator("#plain").focus();
    assert.equal(await guard("null"), "ok");
    await page.frameLocator("#cross").locator("#remote").focus();
    assert.ok((await guard("null")).includes(BROWSER_OPAQUE_TYPING_REFUSED));
  } finally {
    await browser?.close();
    server.close();
  }
});

test("Chromium: a password field the page turns into plain text stays sensitive once seen, and the typing guard still refuses it", { timeout: 30_000 }, async () => {
  let browser: Browser | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`<input id="pw" type="password" value="hunter2" aria-label="Password">
      <button id="show" onclick="const f=document.getElementById('pw');f.type=f.type==='password'?'text':'password'">Show</button>
      <input id="name" aria-label="Name">`);
    const session = await page.context().newCDPSession(page);
    const cdp = { call: (method: string, params?: Record<string, unknown>) => session.send(method as never, params as never) as Promise<unknown> };
    const memory = new SensitiveFieldMemory();
    const seen = await scanSensitiveFields(cdp, memory.of(1));
    assert.equal(seen.sensitive.length, 1);
    memory.remember(1, seen.sensitive);

    await page.click("#show");
    assert.equal(await page.locator("#pw").getAttribute("type"), "text");
    assert.deepEqual((await scanSensitiveFields(cdp)).sensitive, [], "by its attributes alone, the field is plain text now");
    const recalled = await scanSensitiveFields(cdp, memory.of(1));
    assert.deepEqual(recalled.sensitive, seen.sensitive, "remembered, it is still sensitive");
    assert.deepEqual(recalled.recalled, seen.sensitive);
    assert.deepEqual(await sensitiveFieldIds(cdp, memory.of(1)), seen.sensitive);
    const boxes = await sensitiveFieldBoxes(cdp, { width: 1280, height: 720 }, memory.of(1));
    assert.deepEqual(boxes.fields.map((field) => field.backendNodeId), seen.sensitive, "and its box is still painted over");

    // In the page, the typing guard knows the field once main marks it.
    const guard = (): Promise<string> =>
      page.evaluate<string>(`(()=>{${BROWSER_SENSITIVE_FIELD_SOURCE}${browserTypingGuardSource('document.getElementById("pw")')}return "ok";})()`).catch((error: Error) => error.message);
    assert.equal(await guard(), "ok");
    const resolved = (await cdp.call("DOM.resolveNode", { backendNodeId: recalled.recalled[0] })) as { object: { objectId: string } };
    await cdp.call("Runtime.callFunctionOn", { objectId: resolved.object.objectId, functionDeclaration: BROWSER_RECALL_FIELD_FUNCTION });
    assert.ok((await guard()).includes(BROWSER_SENSITIVE_TYPING_REFUSED));
    await page.focus("#name");
    assert.equal(
      await page.evaluate<string>(`(()=>{${BROWSER_SENSITIVE_FIELD_SOURCE}${browserTypingGuardSource("null")}return "ok";})()`),
      "ok",
      "other fields are untouched",
    );
  } finally {
    await browser?.close();
  }
});

test("Chromium: every selector that can tell a field's value or state apart is refused; ordinary locators still work", { timeout: 30_000 }, async () => {
  // Frameworks that mirror a controlled input into its `value` attribute let a
  // selector test what the person typed. Chromium is the oracle: each refused
  // selector really matches with the field's prefix and not with another one.
  const reads = (prefix: string) => [
    `xpath=//input[@*[starts-with(.,'${prefix}')]]`,
    `xpath=//input[attribute::*[starts-with(.,'${prefix}')]]`,
    `xpath=//input[@node()[starts-with(.,'${prefix}')]]`,
    `input[/**/value^='${prefix}']`,
    `input[/* any */ value^='${prefix}']`,
  ];
  const ordinary = ["internal:role=textbox[name=\"Password\"i]", "#pw", "input[name=pw]", "text=Signed in as sam@example.com"];
  let browser: Browser | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<label>Password <input id="pw" name="pw" type="password" value="hunter2"></label><p>Signed in as sam@example.com</p>');
    const matches = async (selector: string) => page.locator(selector).count();
    const right = reads("hunt"), wrong = reads("zzzz");
    for (const [index, selector] of right.entries()) {
      assert.equal(await matches(selector), 1, `${selector} reads the field`);
      assert.equal(await matches(wrong[index]!), 0, `${wrong[index]} tells another value apart`);
      assert.throws(
        () => assertBoundarySelector(selector),
        (error: Error) => [BROWSER_VALUE_SELECTOR_REFUSED, BROWSER_XPATH_SELECTOR_REFUSED].includes(error.message),
        selector,
      );
    }
    for (const selector of ordinary) {
      assert.ok((await matches(selector)) >= 1, `${selector} finds its element`);
      assert.doesNotThrow(() => assertBoundarySelector(selector), selector);
    }

    // A field's state says what it holds too: the month a card-expiry list
    // has chosen, whether a field is empty, valid against the page's own
    // rules or in range, and which way its text runs. Each of these matches
    // differently once the person has filled the form in; states that don't
    // depend on the value match the same, and stay a Bot's to use.
    await page.setContent(`<form>
      <input id="pw" type="password" placeholder="Password" required minlength="4">
      <select id="exp" autocomplete="cc-exp-month">${Array.from({ length: 12 }, (_, month) => `<option>${String(month + 1).padStart(2, "0")}</option>`).join("")}</select>
      <input id="year" type="number" autocomplete="cc-exp-year" min="2024" max="2040">
      <div id="otp" contenteditable autocomplete="one-time-code"></div>
      <input id="name" autocomplete="cc-name" dir="auto"></form>`);
    const states = [
      "#exp option:nth-child(5):checked",
      "#exp option:nth-child(5):/**/checked",
      "#exp:has(option:nth-child(5):checked)",
      'form >> internal:has="#exp option:nth-child(5):checked"',
      "#pw:placeholder-shown",
      "#pw:not(:placeholder-shown)",
      "#pw:valid",
      "#pw:invalid",
      "#year:in-range",
      "#year:out-of-range",
      "#year:user-invalid",
      "#otp:empty",
      "#name:dir(rtl)",
    ];
    const steady = ["#pw:required", "#year:read-write", "#exp:enabled", "form:has(#pw:required)"];
    const before = await Promise.all([...states, ...steady].map(matches));
    await page.fill("#pw", "hunter2");
    await page.selectOption("#exp", "05");
    await page.fill("#year", "2050");
    await page.fill("#otp", "482913");
    await page.fill("#name", "שרה לוי");
    for (const [index, selector] of states.entries()) {
      assert.notEqual(await matches(selector), before[index], `${selector} tells what the field holds`);
      assert.throws(() => assertBoundarySelector(selector), { message: BROWSER_STATE_SELECTOR_REFUSED }, selector);
    }
    for (const [index, selector] of steady.entries()) {
      assert.equal(await matches(selector), before[states.length + index], `${selector} doesn't depend on the value`);
      assert.doesNotThrow(() => assertBoundarySelector(selector), selector);
    }
  } finally {
    await browser?.close();
  }
});

test("Chromium: a Bot's locator can't tell what a password, card or code field holds; ordinary locators find the same element", { timeout: 30_000 }, async () => {
  // A textarea's text (its default or a framework's copy of what was typed)
  // and a contenteditable code field's text are what text, label and XPath
  // engines read; role engines read a field's live value (a password's too)
  // into the name of the cell, row, checkbox or button around it, and a code
  // field's text into the description of a button that points at it. The
  // bundled runtime, installed as the browser service does in an isolated
  // world, is the oracle: each form below finds the field, or an element
  // around it, with the right prefix and nothing with a wrong one. A dialog
  // or group named by its heading or legend still matches by that name when
  // it holds a field, unless the legend itself holds one.
  const reads = (prefix: string) => [
    `xpath=//textarea[starts-with(.,'${prefix}')]`,
    `//form[contains(.,'${prefix}')]`,
    `text=${prefix}`,
    `text=/${prefix}/`,
    `internal:text="${prefix}"i`,
    `textarea:has-text("${prefix}")`,
    `form:has-text("${prefix}")`,
    `textarea:text-matches("^${prefix}")`,
    `form >> internal:has-text="${prefix}"i`,
    `form >> internal:has-not-text="${prefix}"i`,
    `internal:label=/${prefix}/`,
    `label:has-text("${prefix}")`,
    `textarea:not(:has-text("${prefix}"))`,
    `#host >> text=${prefix}`,
    `internal:role=cell[name=/^${prefix}/]`,
    `internal:role=row[name=/Password ${prefix}/]`,
    `internal:role=checkbox[name=/Save ${prefix}/]`,
    `form >> internal:has="internal:role=cell[name=/^${prefix}/]"`,
    `internal:role=button[name=/^${prefix}/]`,
    `internal:role=button[description=/${prefix}/]`,
    `internal:role=group[name=/Expiry ${prefix}/]`,
  ];
  const ordinary: Array<[selector: string, id: string]> = [
    ['internal:role=textbox[name="Card number"i]', "card"],
    ['internal:label="Card number"i', "card"],
    ["label:has-text('Card number') >> textarea", "card"],
    ["textarea[name=card]", "card"],
    ["text=Pay", "pay"],
    ['internal:role=button[name="Pay"i]', "pay"],
    ['form >> internal:has-text="Pay"i', "checkout"],
    ["text=Signed in as sam@example.com", "account"],
    ['internal:role=form[name="Checkout"i]', "checkout"],
    ['internal:role=cell[name="Password"i]', "pwlabel"],
    ["internal:role=checkbox", "remember"],
    ['internal:role=button[name="Help"i]', "help"],
    ['internal:role=dialog[name="Billing"i]', "billing"],
    ['internal:role=dialog[name="Billing"i] >> internal:role=button[name="Confirm"i]', "confirm"],
    ['internal:role=group[name="Card details"i]', "cardset"],
  ];
  let browser: Browser | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`<form id="checkout" aria-label="Checkout">
      <label>Card number <textarea id="card" name="card" autocomplete="cc-number">4111111111111111</textarea></label>
      <label id="code">Code <div id="otp" contenteditable autocomplete="one-time-code"><span>482913</span></div></label>
      <div id="host"></div>
      <table><tr><td id="pwlabel">Password</td><td><input id="pw" type="password"></td></tr>
        <tr><td>One-time code</td><td><input id="otp2" autocomplete="one-time-code"></td></tr>
        <tr><td>Card</td><td><input id="cc" autocomplete="cc-number"></td></tr></table>
      <label><input type="checkbox" id="remember"> Save <input id="cc2" autocomplete="cc-number"></label>
      <button id="help" type="button" aria-describedby="code">Help</button>
      <button id="pay">Pay</button></form>
      <div role="button" id="wrap" tabindex="0"><input id="cc3" autocomplete="cc-number"></div>
      <p id="account">Signed in as sam@example.com</p>
      <div role="dialog" id="billing" aria-labelledby="billing-title"><h2 id="billing-title">Billing</h2>
        <input id="cc4" autocomplete="cc-number"><button id="confirm" type="button">Confirm</button></div>
      <fieldset id="cardset"><legend>Card details</legend><input id="cc5" autocomplete="cc-number"></fieldset>
      <fieldset id="expset"><legend>Expiry <input id="exp" autocomplete="cc-exp"></legend></fieldset>
      <script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<textarea id="csc" autocomplete="cc-csc">737</textarea>';</script>`);
    // Typed live, as the person would: the value is a property, never an attribute.
    for (const [selector, value] of [["#pw", "hunter2xyz"], ["#otp2", "550071"], ["#cc", "4000123412341234"], ["#cc2", "5555444433332222"], ["#cc3", "6011000990139424"], ["#cc4", "378282246310005"], ["#cc5", "3530111333300000"], ["#exp", "1229"]] as const) {
      await page.fill(selector, value);
    }
    const { session, contextId, run, plain, bot, elementId } = await boundaryWorld(page);

    const told = new Set<number>();
    for (const [prefix, other] of [["4111", "9999"], ["4829", "9999"], ["737", "999"], ["hunt", "zzzz"], ["5500", "9999"], ["4000", "9999"], ["5555", "9999"], ["6011", "9999"], ["1229", "9999"]] as const) {
      const right = reads(prefix), wrong = reads(other);
      for (const [index, selector] of right.entries()) {
        const [matched, missed] = [await plain(selector), await plain(wrong[index]!)];
        if (matched === missed) continue;
        told.add(index);
        assert.equal(await bot(selector), await bot(wrong[index]!), `${selector} and ${wrong[index]} look the same to a Bot (${matched} vs ${missed} without the boundary)`);
      }
    }
    assert.deepEqual([...told].sort((a, b) => a - b), reads("").map((_, index) => index), "every form tells some field's text apart without the boundary");

    // A nested XPath that main's quick check would miss, were it written another way, is refused in the page.
    const nested = `form >> internal:has="//textarea[starts-with(.,'4111')]"`;
    assert.equal(await plain(nested), "checkout");
    assert.equal(await run(elementId(browserBoundaryLocatorExpression(nested))), `error: ${BROWSER_XPATH_SELECTOR_REFUSED}`);

    // Two card fields match: Playwright's own refusal quotes what one holds; a Bot's names only the count.
    const strict = (selector: string) =>
      run(`(()=>{const p=globalThis.__aidenPlaywright;p.querySelector(p.parseSelector(${JSON.stringify(selector)}),document,true);return "one";})()`);
    assert.match(await strict("form textarea, #csc"), /4111111111111111/u);
    const twoFields = await bot("form textarea, #csc");
    assert.match(twoFields, /strict mode violation: this locator matches 2 elements/u);
    assert.doesNotMatch(twoFields, /4111|737/u);

    for (const [selector, id] of ordinary) {
      assert.equal(await plain(selector), id, `${selector} finds its element`);
      assert.equal(await bot(selector), id, `${selector} still finds it for a Bot`);
    }

    // A runtime with a selector engine the boundary doesn't know (one that
    // reads what a field holds, here) runs no Bot locator at all.
    await run(`globalThis.__aidenPlaywright._engines.set("value",{queryAll:(root,body)=>[...root.querySelectorAll("input")].filter((e)=>e.value.startsWith(body))})`);
    assert.equal(await plain("value=hunt"), "pw", "the new engine reads the password");
    assert.equal(await bot("value=hunt"), `error: ${BROWSER_LOCATOR_UNCHECKED_REFUSED}`);
    assert.equal(await bot("text=Pay"), `error: ${BROWSER_LOCATOR_UNCHECKED_REFUSED}`);
    await run(`globalThis.__aidenPlaywright._engines.delete("value")`);
    assert.equal(await bot("text=Pay"), "pay");

    // The snapshot's locators: Playwright's generator names the button around
    // a card field by its number; in a Bot's view no locator carries a value,
    // and each still finds its element for the Bot.
    const listed = ["wrap", "remember", "card", "pay", "help", "pw", "cc"];
    const list = `${JSON.stringify(listed)}.map((id)=>document.getElementById(id))`;
    const values = /4111|4829|737|hunter2xyz|550071|4000123412341234|5555444433332222|6011000990139424/u;
    const generated = async (expression: string) => {
      const result = await session.send("Runtime.evaluate", { expression, contextId, returnByValue: true });
      return result.result.value as string[];
    };
    assert.match(JSON.stringify(await generated(`${list}.map((e)=>globalThis.__aidenPlaywright.generateSelectorSimple(e,{}))`)), values);
    const bounded = await generated(browserBoundarySelectorsExpression(list));
    assert.doesNotMatch(JSON.stringify(bounded), values);
    for (const [index, selector] of bounded.entries()) assert.equal(await bot(selector), listed[index], `${selector} finds #${listed[index]} for a Bot`);
  } finally {
    await browser?.close();
  }
});

test("Chromium: a Bot's role locators leave out only names that could read a field", { timeout: 30_000 }, async () => {
  let browser: Browser | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    // A page without password, code or card fields: nothing is left out, however large it is.
    await page.setContent(`<table><tr id="order"><td>Order 42</td><td id="lines"></td></tr></table>
      <script>const lines = document.getElementById("lines"); for (let i = 0; i < 25000; i += 1) lines.append(document.createElement("span"));</script>`);
    const { run, plain, bot } = await boundaryWorld(page);
    assert.equal(await plain("internal:role=row[name=/Order 42/]"), "order");
    assert.equal(await bot("internal:role=row[name=/Order 42/]"), "order");
    // The roles whose content a Bot's role locator doesn't follow: Playwright
    // never names an element with one of them from its text or the value of a
    // field inside it.
    const namedFromContent = await run(`(()=>{const u=globalThis.__aidenPlaywright.utils;return ${JSON.stringify(BROWSER_BOUNDARY_AUTHOR_NAMED_ROLES)}.filter((role)=>{const e=document.createElement("div");e.setAttribute("role",role);const field=document.createElement("input");field.value="4242";e.append("Text ",field);document.body.append(e);const seen=u.getAriaRole(e);const name=u.getElementAccessibleNameText(e,false);e.remove();return seen!==role||/Text|4242/.test(name);}).join(",")||"none";})()`);
    assert.equal(namedFromContent, "none");
  } finally {
    await browser?.close();
  }
});

test("Chromium: a Bot's snapshot names no element with what a field holds; names from elsewhere stay", { timeout: 30_000 }, async () => {
  // Chromium's accessibility tree names a table cell with the card number or
  // code typed in it (a password's cell with one bullet per character), a
  // checkbox with the card field inside its label, a fieldset with the field
  // in its legend, a button that owns a field (`aria-owns`), a cell a field is
  // slotted into, and describes a button with a code field it points at. The
  // raw tree is the oracle.
  let browser: Browser | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`<form aria-label="Checkout"><div role="dialog" aria-labelledby="title"><h2 id="title">Payment</h2>
      <table><tr><td>Password</td><td><input id="pw" type="password"></td></tr>
        <tr><td>Code</td><td><input id="otp" autocomplete="one-time-code"></td></tr>
        <tr><td>Card</td><td><input id="cc" autocomplete="cc-number"></td></tr></table>
      <label><input type="checkbox"> Save <input id="saved" autocomplete="cc-number"></label>
      <fieldset><legend>Expiry <input id="exp" autocomplete="cc-exp"></legend></fieldset>
      <div role="button" tabindex="0" aria-owns="owned">Use card</div><input id="owned" autocomplete="cc-number">
      <div id="host"><input id="slotted" autocomplete="cc-csc"></div>
      <p id="hint">Code <span contenteditable autocomplete="one-time-code">482913</span></p><button aria-describedby="hint">Resend</button>
      <label>Card number <textarea autocomplete="cc-number">4111111111111111</textarea></label>
      <button>Pay</button></div></form>
      <script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<table><tr><td>Security code <slot></slot></td></tr></table>";</script>`);
    const typed: Array<[string, string]> = [["#pw", "hunter2xyz"], ["#otp", "550071"], ["#cc", "4000123412341234"], ["#saved", "5555444433332222"], ["#exp", "1229"], ["#owned", "4242424242424242"], ["#slotted", "7373"]];
    for (const [selector, value] of typed) await page.fill(selector, value);
    const session = await page.context().newCDPSession(page);
    const cdp = { call: (method: string, params?: Record<string, unknown>) => session.send(method as never, params as never) as Promise<unknown> };
    const tree = (await session.send("Accessibility.getFullAXTree")) as { nodes: unknown[] };
    const scrubbed = scrubBrowserSnapshot(
      { tab: {} as BrowserTab, text: "", elements: [], diagnostics: [], accessibilityTree: tree },
      await scanSensitiveFieldReach(cdp),
    );
    type Node = { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; description?: { value?: string } };
    const named = (nodes: Node[]) => nodes.filter((node) => !node.ignored && node.role?.value !== "StaticText" && node.role?.value !== "InlineTextBox");
    const names = (nodes: Node[]) => named(nodes).map((node) => `${node.role?.value} ${JSON.stringify(node.name?.value ?? "")}${node.description?.value ? ` described ${JSON.stringify(node.description.value)}` : ""}`);
    const before = names(tree.nodes as Node[]).join("\n"), after = names((scrubbed.accessibilityTree as { nodes: Node[] }).nodes).join("\n");
    const secrets = ["\u2022".repeat(10), "550071", "4000123412341234", "5555444433332222", "1229", "4242424242424242", "7373", "482913"];
    for (const secret of secrets) assert.ok(before.includes(secret), `Chromium names an element with ${secret}:\n${before}`);
    assert.doesNotMatch(JSON.stringify(scrubbed.accessibilityTree), /hunter2xyz|\u2022\u2022|550071|4000123412341234|5555444433332222|1229|4242424242424242|7373|482913|4111111111111111/u);
    // Names from the page's own text, labels and attributes stay.
    for (const name of ['form "Checkout"', 'dialog "Payment"', 'LayoutTableCell "Password"', 'textbox "Card number "', 'button "Pay"', 'button "Resend"']) {
      assert.ok(after.includes(name), `${name} stays:\n${after}`);
    }
  } finally {
    await browser?.close();
  }
});
