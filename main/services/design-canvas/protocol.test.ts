// The aiden-design request handler, called directly with real files and a
// real grant registry: what a sandboxed design frame actually receives.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { DESIGN_BRIDGE_SOURCE } from "./bridge-source.js";
import { DesignGrantRegistry } from "./grants.js";
import {
  DESIGN_OFFLINE_SANDBOX_POLICY,
  designOfflineMissingFile,
  designOfflineRequestAllowed,
  withDesignOfflineSandbox,
} from "./offline-policy.js";
import { designProtocolHandler, designResponse, registerDesignProtocol } from "./protocol.js";

test("a handler whose file read throws answers not found instead of failing the request", async (t) => {
  const { grant, grants } = await fixture(t);
  const handler = designProtocolHandler({
    grants,
    readFile: () => {
      throw new Error("disk gone");
    },
  });
  assert.equal((await handler(new Request(`aiden-design://${grant}/design/a.css`))).status, 404);
});

test("the hidden window may reach only Aiden's local schemes, inline data and blobs made from them", () => {
  for (const url of [
    "aiden-design://grant-1/design/home.html",
    "aiden-genui://preview/token-1",
    "data:image/png;base64,AAAA",
    "blob:aiden-design://grant-1/0b6f3c8e-1d2a-4f5b-9c7d-2e8a1b3c4d5e",
    "about:blank",
    "about:srcdoc",
  ]) {
    assert.equal(designOfflineRequestAllowed(url), true, url);
  }
  for (const url of [
    "https://example.com/font.woff2",
    "http://127.0.0.1:8080/",
    "ws://localhost:3478/",
    "file:///etc/hosts",
    "blob:https://example.com/0b6f3c8e-1d2a-4f5b-9c7d-2e8a1b3c4d5e",
    "blob:blob:https://example.com/x",
    "about:config",
    "stun:stun.example.com:3478",
    "not a url",
    "",
  ]) {
    assert.equal(designOfflineRequestAllowed(url), false, url);
  }
});

test("a workspace script, import, stylesheet or image the scheme answered as missing is named, and nothing else is", () => {
  const script = "aiden-design://grant-1/design/js/app.js";
  assert.equal(designOfflineMissingFile({ url: script, statusCode: 404, resourceType: "script" }), script);
  assert.equal(designOfflineMissingFile({ url: script, statusCode: 403, resourceType: "script" }), script, "a path outside the grant");
  for (const resourceType of ["stylesheet", "image", "font", "media", "xhr", "other"]) {
    assert.equal(designOfflineMissingFile({ url: script, statusCode: 404, resourceType }), script, resourceType);
  }
  // A file that loaded, the page itself, and what is not a workspace file.
  assert.equal(designOfflineMissingFile({ url: script, statusCode: 200, resourceType: "script" }), null);
  assert.equal(designOfflineMissingFile({ url: script, statusCode: 304, resourceType: "script" }), null);
  assert.equal(designOfflineMissingFile({ url: "aiden-design://grant-1/design/home.html", statusCode: 404, resourceType: "mainFrame" }), null);
  assert.equal(designOfflineMissingFile({ url: "aiden-genui://preview/token-1", statusCode: 404, resourceType: "subFrame" }), null);
  assert.equal(designOfflineMissingFile({ url: "data:text/javascript,", statusCode: 404, resourceType: "script" }), null);
});

test("each response in the hidden window keeps its own policy, body and status and adds a sandbox that opens no dialog", async (t) => {
  const { get } = await fixture(t);
  const original = await get("design/missing.html");
  const status = original.status;
  const sandboxed = withDesignOfflineSandbox(
    new Response("<p>hi</p>", { status: 203, statusText: "Partial", headers: { "content-security-policy": CSP, "x-content-type-options": "nosniff" } }),
  );
  assert.equal(sandboxed.status, 203);
  assert.equal(sandboxed.statusText, "Partial");
  assert.equal(await sandboxed.text(), "<p>hi</p>");
  assert.equal(sandboxed.headers.get("x-content-type-options"), "nosniff");
  const policies = sandboxed.headers.get("content-security-policy")!.split(/,\s*/u);
  assert.deepEqual(policies, [CSP, DESIGN_OFFLINE_SANDBOX_POLICY]);
  const tokens = DESIGN_OFFLINE_SANDBOX_POLICY.split(/\s+/u);
  assert.equal(tokens[0], "sandbox");
  for (const opener of ["allow-modals", "allow-popups", "allow-forms", "allow-top-navigation", "allow-downloads"]) {
    assert.equal(tokens.includes(opener), false, opener);
  }
  // A refusal stays a refusal.
  assert.equal(withDesignOfflineSandbox(original).status, status);
});

const CSP =
  "default-src 'none'; script-src aiden-design: 'unsafe-inline'; style-src aiden-design: 'unsafe-inline'; img-src aiden-design: data: blob:; font-src aiden-design: data:; media-src aiden-design: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

async function fixture(t: TestContext) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-protocol-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "design"));
  const grants = new DesignGrantRegistry();
  const grant = grants.issue("chat-1", root);
  const libraryCalls: string[] = [];
  const deps = {
    grants,
    readFile: (file: string) => fs.readFile(file),
    readLibrary: async (name: string) => {
      libraryCalls.push(name);
      return name === "chart.js"
        ? {
            bytes: new TextEncoder().encode("window.Chart = 1;"),
            mimeType: "text/javascript; charset=utf-8",
          }
        : null;
    },
  };
  const get = (rest: string, init: { method?: string } = {}) =>
    designResponse({ url: `aiden-design://${grant}/${rest}`, ...init }, deps);
  return { root, grant, grants, deps, get, libraryCalls };
}

function bridgeTag(grant: string): string {
  return `<script src="aiden-design://${grant}/__aiden/bridge.js"></script>`;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("an HTML response carries the fixed CSP, nosniff and no-store", async (t) => {
  const { root, get } = await fixture(t);
  await fs.writeFile(
    path.join(root, "design", "a.html"),
    "<html><head></head><body>hi</body></html>",
  );
  const response = await get("design/a.html");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("content-security-policy"), CSP);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("one bridge script is injected directly after the head tag", async (t) => {
  const { root, grant, get } = await fixture(t);
  await fs.writeFile(
    path.join(root, "design", "a.html"),
    '<!doctype html><html lang="en"><HEAD data-x="1"><title>t</title></head><body><header>x</header></body></html>',
  );
  const body = await (await get("design/a.html")).text();
  assert.equal(
    body,
    `<!doctype html><html lang="en"><HEAD data-x="1">${bridgeTag(grant)}<title>t</title></head><body><header>x</header></body></html>`,
  );
  assert.equal(countOf(body, "__aiden/bridge.js"), 1);
});

test("without a head tag the bridge goes first, after any doctype and html tag", async (t) => {
  const { root, grant, get } = await fixture(t);
  await fs.writeFile(path.join(root, "design", "bare.html"), "<p>hi</p>");
  await fs.writeFile(path.join(root, "design", "doc.html"), "<!DOCTYPE html>\n<p>hi</p>");
  await fs.writeFile(
    path.join(root, "design", "html.html"),
    "<!doctype html><html><body><header>h</header></body></html>",
  );
  assert.equal(await (await get("design/bare.html")).text(), `${bridgeTag(grant)}<p>hi</p>`);
  assert.equal(
    await (await get("design/doc.html")).text(),
    `<!DOCTYPE html>${bridgeTag(grant)}\n<p>hi</p>`,
  );
  assert.equal(
    await (await get("design/html.html")).text(),
    `<!doctype html><html>${bridgeTag(grant)}<body><header>h</header></body></html>`,
  );
});

test("injection keeps the rest of the file byte for byte, including non-UTF-8 bytes", async (t) => {
  const { root, grant, get } = await fixture(t);
  const before = Buffer.from("<head>", "latin1");
  const after = Buffer.from([0xff, 0xfe, 0x00, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);
  await fs.writeFile(path.join(root, "design", "raw.html"), Buffer.concat([before, after]));
  const bytes = Buffer.from(await (await get("design/raw.html")).arrayBuffer());
  assert.deepEqual(bytes, Buffer.concat([before, Buffer.from(bridgeTag(grant), "latin1"), after]));
});

test("the bridge script is served as JavaScript under the same CSP", async (t) => {
  const { get } = await fixture(t);
  const response = await get("__aiden/bridge.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.equal(response.headers.get("content-security-policy"), CSP);
  assert.equal(await response.text(), DESIGN_BRIDGE_SOURCE);
});

test("vendored libraries come through readLibrary and unknown names are not found", async (t) => {
  const { get, libraryCalls } = await fixture(t);
  const chart = await get("__aiden/lib/chart.js");
  assert.equal(chart.status, 200);
  assert.equal(await chart.text(), "window.Chart = 1;");
  assert.equal(chart.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await get("__aiden/lib/unknown.js")).status, 404);
  assert.equal((await get("__aiden/lib/../bridge.js")).status, 404);
  assert.equal((await get("__aiden/lib/a/b.js")).status, 404);
  assert.equal((await get("__aiden/other.js")).status, 404);
  assert.deepEqual(libraryCalls, ["chart.js", "unknown.js"]);
});

test("an unknown, revoked or malformed grant is not found", async (t) => {
  const { root, grant, grants, deps } = await fixture(t);
  await fs.writeFile(path.join(root, "design", "a.html"), "<p>a</p>");
  for (const url of [
    `aiden-design://${"b".repeat(52)}/design/a.html`,
    `aiden-design:///design/a.html`,
    `aiden-design://${grant}`,
    `https://${grant}/design/a.html`,
    "not a url",
  ]) {
    const response = await designResponse({ url }, deps);
    assert.equal(response.status, 404, url);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), new RegExp(root.replace(/[/\\.]/gu, "."), "u"));
  }
  grants.revokeChat("chat-1");
  assert.equal(
    (await designResponse({ url: `aiden-design://${grant}/design/a.html` }, deps)).status,
    404,
  );
});

test("a non-HTML file is served byte for byte with its type and no injection", async (t) => {
  const { root, get } = await fixture(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  await fs.writeFile(path.join(root, "design", "logo.png"), png);
  await fs.writeFile(path.join(root, "design", "style.css"), "<head>body{}");
  const image = await get("design/logo.png");
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal(await (await get("design/style.css")).text(), "<head>body{}");
});

test("query strings and fragments are ignored when resolving the file", async (t) => {
  const { root, get } = await fixture(t);
  await fs.writeFile(path.join(root, "design", "a.css"), "a{}");
  assert.equal(await (await get("design/a.css?v=3#top")).text(), "a{}");
});

test("refusals keep their status, carry no path and are never cached", async (t) => {
  const { root, get } = await fixture(t);
  await fs.writeFile(path.join(root, "design", "a.exe"), "MZ");
  await fs.writeFile(path.join(root, "design", "big.png"), Buffer.alloc(9 * 1024 * 1024));
  const cases: Array<[string, number]> = [
    ["design/a.exe", 403],
    [".git/config", 403],
    ["%2e%2e/secret.txt", 404],
    ["design/missing.html", 404],
    ["design/big.png", 413],
  ];
  for (const [rest, status] of cases) {
    const response = await get(rest);
    assert.equal(response.status, status, rest);
    assert.equal(response.headers.get("cache-control"), "no-store", rest);
    assert.equal(response.headers.get("content-security-policy"), CSP, rest);
    assert.equal((await response.text()).includes(root), false, rest);
  }
});

test("only GET and HEAD are answered; HEAD has no body", async (t) => {
  const { root, get } = await fixture(t);
  await fs.writeFile(path.join(root, "design", "a.css"), "a{}");
  assert.equal((await get("design/a.css", { method: "POST" })).status, 405);
  const head = await get("design/a.css", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("a file that cannot be read after resolving is not found", async (t) => {
  const { root, grant, deps } = await fixture(t);
  await fs.writeFile(path.join(root, "design", "a.css"), "a{}");
  const response = await designResponse(
    { url: `aiden-design://${grant}/design/a.css` },
    { ...deps, readFile: async () => Promise.reject(new Error(`EACCES ${root}`)) },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes(root), false);
});

test("registerDesignProtocol registers one aiden-design handler that serves the grant's files", async (t) => {
  const { root, grant, grants } = await fixture(t);
  await fs.writeFile(path.join(root, "design", "a.css"), "a{}");
  const handlers = new Map<string, (request: Request) => Promise<Response>>();
  const protocol = {
    handle(scheme: string, handler: (request: Request) => Promise<Response>) {
      assert.equal(handlers.has(scheme), false, `${scheme} registered twice`);
      handlers.set(scheme, handler);
    },
  };
  registerDesignProtocol({ protocol, grants });
  registerDesignProtocol({ protocol, grants });
  assert.deepEqual([...handlers.keys()], ["aiden-design"]);
  const response = await handlers.get("aiden-design")!(
    new Request(`aiden-design://${grant}/design/a.css`),
  );
  assert.equal(await response.text(), "a{}");
});
