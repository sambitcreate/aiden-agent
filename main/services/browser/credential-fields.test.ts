import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import playwright, { type Browser } from "playwright";
import {
  autocompleteFieldTokens,
  isSensitiveField,
  quadsBounds,
  scanCredentialTree,
  sensitiveFieldBoxes,
  sensitiveFieldIds,
  type CdpDomNode,
} from "./credential-fields.js";

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
    const cdp = { send: (method: string, params?: Record<string, unknown>) => session.send(method as never, params as never) as Promise<unknown> };
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
