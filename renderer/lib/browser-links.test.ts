import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLinkCommand } from "./browser-links";

test("web links preserve the saved-target decision and the system-browser modifier", () => {
  assert.deepEqual(browserLinkCommand("https://example.com/a", { metaKey: false, ctrlKey: false }), { action: "open_link", url: "https://example.com/a", alternateTarget: false });
  assert.deepEqual(browserLinkCommand("http://localhost:3000", { metaKey: true, ctrlKey: false }), { action: "open_link", url: "http://localhost:3000/", alternateTarget: true });
});
test("only supported workspace documents are routed to file preview", () => {
  assert.deepEqual(browserLinkCommand("docs/my%20page.html", { metaKey: false, ctrlKey: false }), { action: "open_file", path: "docs/my page.html" });
  for (const href of ["#section", "mailto:hello@example.com", "javascript:alert(1)", "file:///etc/passwd", "/settings", "//example.com", "https://", "bad%zz.html"])
    assert.equal(browserLinkCommand(href, { metaKey: false, ctrlKey: false }), null, href);
});