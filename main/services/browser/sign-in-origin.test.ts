import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSignInOrigin } from "./sign-in-origin.js";

test("a site name or https URL becomes its https origin", () => {
  const cases: Array<[string, string]> = [
    ["github.com", "https://github.com"],
    ["  GitHub.com  ", "https://github.com"],
    ["https://github.com/login?return_to=%2F", "https://github.com"],
    ["github.com/login", "https://github.com"],
    ["https://accounts.google.com:443/", "https://accounts.google.com"],
    ["https://github.com./", "https://github.com"],
    ["https://münchen.de", "https://xn--mnchen-3ya.de"],
  ];
  for (const [site, origin] of cases) assert.equal(normalizeSignInOrigin(site), origin, site);
});

test("anything that isn't a public https site is refused with one plain message", () => {
  const refused = [
    "http://github.com",
    "ftp://github.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://ada@github.com",
    "https://ada:secret@github.com",
    "https://github.com:8443",
    "github.com:8080",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://0177.0.0.1",
    "https://[::1]",
    "https://[2001:db8::1]/login",
    "https://localhost",
    "localhost",
    "https://intranet.localhost",
    "https://LOCALHOST./",
    "intranet",
    "",
    "   ",
    `https://${"a".repeat(2_100)}.com`,
  ];
  for (const site of refused) {
    assert.throws(() => normalizeSignInOrigin(site), { message: "Use an https site name like github.com." }, site);
  }
});
