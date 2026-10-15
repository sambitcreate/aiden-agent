import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost, resolveLinkOpen, type LinkRouteInput } from "./browser-link-routing";

const plain = { metaKey: false, ctrlKey: false };
const cmd = { metaKey: true, ctrlKey: false };
const route = (over: Partial<LinkRouteInput>) =>
  resolveLinkOpen({ href: "https://example.com/", modifiers: plain, preference: "ask", browserAvailable: true, ...over });

test("the preference decides a plain web link, and ask prompts with remember", () => {
  assert.deepEqual(route({ preference: "ask" }), { kind: "ask", url: "https://example.com/", remember: true, inApp: true });
  assert.deepEqual(route({ preference: "browser" }), { kind: "browser", url: "https://example.com/" });
  assert.deepEqual(route({ preference: "external" }), { kind: "external", url: "https://example.com/" });
});

test("cmd or ctrl flips the destination and never prompts", () => {
  assert.equal(route({ preference: "browser", modifiers: cmd })?.kind, "external");
  assert.equal(route({ preference: "external", modifiers: cmd })?.kind, "browser");
  assert.equal(route({ preference: "ask", modifiers: { metaKey: false, ctrlKey: true } })?.kind, "external");
});

test("loopback hosts open in Aiden whatever the preference, and cmd sends them out", () => {
  for (const href of ["http://localhost:5173/", "http://app.localhost/", "http://127.0.0.1:3000/x", "http://[::1]:8080/", "http://0.0.0.0:4000/"]) {
    assert.equal(route({ href, preference: "external" })?.kind, "browser", href);
    assert.equal(route({ href, preference: "ask" })?.kind, "browser", href);
    assert.equal(route({ href, preference: "ask", modifiers: cmd })?.kind, "external", href);
  }
  assert.equal(isLoopbackHost("localhost.example.com"), false);
  assert.equal(isLoopbackHost("128.0.0.1"), false);
});

test("loopback look-alike hosts are not treated as loopback and still prompt under ask", () => {
  for (const href of ["http://localhost.evil.com/", "http://127.0.0.1.nip.io/"]) {
    assert.equal(isLoopbackHost(new URL(href).hostname), false, href);
    assert.equal(route({ href, preference: "ask" })?.kind, "ask", href);
  }
  // Userinfo makes "localhost" the username, not the host (the real host is evil.com);
  // such URLs are rejected outright rather than routed anywhere, loopback or not.
  assert.equal(route({ href: "http://localhost@evil.com/", preference: "ask" }), null);
  // The IPv4-mapped IPv6 form isn't in the enumerated loopback spec (localhost, *.localhost,
  // 127.0.0.0/8, [::1], 0.0.0.0), and the current implementation does not special-case it.
  assert.equal(isLoopbackHost("[::ffff:127.0.0.1]"), false);
});

test("without a visible browser panel every web link goes out with no prompt", () => {
  assert.equal(route({ browserAvailable: false, preference: "browser" })?.kind, "external");
  assert.equal(route({ browserAvailable: false, href: "http://localhost:3000/" })?.kind, "external");
  assert.equal(route({ browserAvailable: false, href: "report.html" }), null);
});

test("explicitly external and mailto links skip the prompt", () => {
  assert.equal(route({ forceExternal: true, preference: "browser" })?.kind, "external");
  assert.deepEqual(route({ href: "mailto:hi@example.com" }), { kind: "external", url: "mailto:hi@example.com" });
});

test("model-generated links always prompt, without remember, unless cmd-clicked", () => {
  assert.deepEqual(route({ forcePrompt: true, preference: "browser" }), { kind: "ask", url: "https://example.com/", remember: false, inApp: true });
  assert.deepEqual(route({ forcePrompt: true, href: "http://localhost:3000/" }), { kind: "ask", url: "http://localhost:3000/", remember: false, inApp: true });
  // Without the panel the prompt still appears, offering only the system browser.
  assert.deepEqual(route({ forcePrompt: true, browserAvailable: false }), { kind: "ask", url: "https://example.com/", remember: false, inApp: false });
  assert.equal(route({ forcePrompt: true, preference: "browser", modifiers: cmd })?.kind, "external");
});

test("workspace HTML and PDF links preview in Aiden; everything else is left to the app", () => {
  assert.deepEqual(route({ href: "docs/My%20Report.html#top" }), { kind: "file", path: "docs/My Report.html" });
  assert.deepEqual(route({ href: "out.pdf?page=2" }), { kind: "file", path: "out.pdf" });
  assert.deepEqual(route({ href: "/abs/out.html" }), { kind: "file", path: "/abs/out.html" });
  for (const href of ["#section", "/settings", "//cdn.example.com/x", "javascript:alert(1)", "file:///etc/hosts", "notes.md", "https://", "https://user:pw@example.com/", "bad%zz.html"])
    assert.equal(route({ href }), null, href);
});
