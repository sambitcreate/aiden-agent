import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost, resolveLinkOpen, workspaceRelativePath, type LinkRouteInput } from "./browser-link-routing";

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

test("workspace HTML and PDF links preview in Aiden; other files open in Files", () => {
  const folder = "/Users/me/prompt-lab";
  const file = (href: string) => route({ href, workspaceFolder: folder });
  assert.deepEqual(file("docs/My%20Report.html#top"), { kind: "file", path: "docs/My Report.html", preview: true, workspacePath: "docs/My Report.html" });
  assert.deepEqual(file("out.pdf?page=2"), { kind: "file", path: "out.pdf", preview: true, workspacePath: "out.pdf" });
  assert.deepEqual(file("./thermostat/style.css"), { kind: "file", path: "./thermostat/style.css", preview: false, workspacePath: "thermostat/style.css" });
  assert.deepEqual(file("thermostat/glm-dgx/"), { kind: "file", path: "thermostat/glm-dgx/", preview: false, workspacePath: "thermostat/glm-dgx" });
  // Agents link file and line; the line is dropped, including the bare `name.ext:12` form.
  assert.deepEqual(file("script.js:12"), { kind: "file", path: "script.js", preview: false, workspacePath: "script.js" });
  assert.deepEqual(file("src/app.ts:12:4"), { kind: "file", path: "src/app.ts", preview: false, workspacePath: "src/app.ts" });
});

test("absolute paths and file:// links resolve against the workspace folder", () => {
  const folder = "/Users/me/prompt-lab";
  const file = (href: string) => route({ href, workspaceFolder: folder });
  assert.deepEqual(file("file:///Users/me/prompt-lab/thermostat/index.html"), {
    kind: "file", path: "/Users/me/prompt-lab/thermostat/index.html", preview: true, workspacePath: "thermostat/index.html",
  });
  assert.deepEqual(file("file:///Users/me/prompt-lab/a%20b/script.js"), {
    kind: "file", path: "/Users/me/prompt-lab/a b/script.js", preview: false, workspacePath: "a b/script.js",
  });
  assert.deepEqual(file("/Users/me/prompt-lab/thermostat"), { kind: "file", path: "/Users/me/prompt-lab/thermostat", preview: false, workspacePath: "thermostat" });
  assert.deepEqual(file("file://localhost/Users/me/prompt-lab/"), { kind: "file", path: "/Users/me/prompt-lab/", preview: false, workspacePath: "" });
  // Outside the workspace: still a file (the opener explains it can't open it), never a web link.
  assert.deepEqual(file("file:///etc/hosts"), { kind: "file", path: "/etc/hosts", preview: false, workspacePath: null });
  assert.deepEqual(file("/Users/me/prompt-lab-old/x.css"), { kind: "file", path: "/Users/me/prompt-lab-old/x.css", preview: false, workspacePath: null });
  assert.deepEqual(file("../secrets.txt"), { kind: "file", path: "../secrets.txt", preview: false, workspacePath: null });
  assert.deepEqual(file("~/notes.md"), { kind: "file", path: "~/notes.md", preview: false, workspacePath: null });
  assert.equal(file("file://fileserver/share/x.html"), null);
});

test("anchors, app routes, and other schemes are left to the app", () => {
  for (const href of ["#section", "/settings", "//cdn.example.com/x", "javascript:alert(1)", "https://", "https://user:pw@example.com/", "bad%zz.html"])
    assert.equal(route({ href, workspaceFolder: "/Users/me/prompt-lab" }), null, href);
  assert.equal(route({ href: "/settings" }), null);
});

test("workspace paths stay inside the folder", () => {
  assert.equal(workspaceRelativePath("a/./b/../c.ts", "/w"), "a/c.ts");
  assert.equal(workspaceRelativePath("a/../../c.ts", "/w"), null);
  assert.equal(workspaceRelativePath("/w/a/../../c.ts", "/w"), null);
  assert.equal(workspaceRelativePath("/w", "/w/"), "");
  assert.equal(workspaceRelativePath("/wx/a", "/w"), null);
  assert.equal(workspaceRelativePath("/w/a", null), null);
});
