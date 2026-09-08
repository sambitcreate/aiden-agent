import assert from "node:assert/strict";
import test from "node:test";
import type { Session, WebContents } from "electron";
import { canGrantBrowserPermission, configureBrowserPermissionHandlers } from "./permission-policy.js";

const page = "https://example.com/page";
const permitted = { permission: "clipboard-sanitized-write", guestUrl: page, isMainFrame: true, requestingUrl: page };

test("only same-origin main-frame sanitized clipboard writes receive automatic permission", () => {
  assert.equal(canGrantBrowserPermission({ ...permitted, kind: "request" }), true);
  assert.equal(canGrantBrowserPermission({ ...permitted, kind: "check", requestingOrigin: "https://example.com" }), true);
  assert.equal(canGrantBrowserPermission({ ...permitted, kind: "check", requestingOrigin: "https://example.com:443/" }), true);
  assert.equal(canGrantBrowserPermission({ ...permitted, kind: "request", guestUrl: "http://127.0.0.1:3000/preview.html", requestingUrl: "http://127.0.0.1:3000/preview.html" }), true);
});

test("sensitive and unknown permissions are denied even for an owned same-origin main frame", () => {
  for (const permission of ["clipboard-read", "deprecated-sync-clipboard-read", "geolocation", "notifications", "media", "display-capture", "fileSystem", "usb", "serial", "hid", "midi", "midiSysex", "idle-detection", "openExternal", "unknown", "future-permission"]) {
    assert.equal(canGrantBrowserPermission({ ...permitted, permission, kind: "request" }), false, permission);
    assert.equal(canGrantBrowserPermission({ ...permitted, permission, kind: "check", requestingOrigin: "https://example.com" }), false, permission);
  }
});

test("subframes, mismatched origins, opaque URLs and missing ownership cannot receive grants", () => {
  for (const change of [
    { isMainFrame: false }, { isMainFrame: undefined }, { guestUrl: undefined },
    { requestingUrl: undefined }, { requestingUrl: "https://attacker.example/" },
    { requestingUrl: "https://example.com.attacker.test/" },
    { requestingUrl: "http://example.com/page" }, { requestingUrl: "https://example.com:444/page" },
    { requestingUrl: "https://user:secret@example.com/page" },
    ...["about:blank", "file:///tmp/preview.html", "data:text/html,test", "blob:https://example.com/uuid", "null", "not a URL"].map((url) => ({ guestUrl: url, requestingUrl: url })),
  ]) assert.equal(canGrantBrowserPermission({ ...permitted, ...change, kind: "request" }), false, JSON.stringify(change));
  for (const requestingOrigin of ["", "null", "https://attacker.example", "http://example.com", "https://example.com:444", "blob:https://example.com/uuid"]) {
    assert.equal(canGrantBrowserPermission({ ...permitted, kind: "check", requestingOrigin }), false, requestingOrigin);
  }
});

test("Electron check and request handlers both deny unknown guests and owner lookup failure", () => {
  let check!: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
  let request!: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
  const owned = {} as WebContents;
  let closing = false;
  configureBrowserPermissionHandlers({
    setPermissionCheckHandler: (handler) => { check = handler!; },
    setPermissionRequestHandler: (handler) => { request = handler!; },
  }, (contents) => {
    if (closing) throw new Error("Guest was destroyed");
    return contents === owned ? page : undefined;
  });
  const details = { isMainFrame: true, requestingUrl: page };
  const requestResult = (contents: WebContents, permission: Parameters<typeof request>[1], frame = details) => {
    const results: boolean[] = [];
    request(contents, permission, (result) => results.push(result), frame);
    assert.equal(results.length, 1);
    return results[0];
  };
  assert.equal(check(owned, "clipboard-sanitized-write", "https://example.com", details), true);
  assert.equal(requestResult(owned, "clipboard-sanitized-write"), true);
  for (const permission of ["clipboard-read", "geolocation", "notifications"] as const) {
    assert.equal(check(owned, permission, "https://example.com", details), false);
    assert.equal(requestResult(owned, permission), false);
  }
  assert.equal(check(null, "clipboard-sanitized-write", "https://example.com", details), false);
  assert.equal(check({} as WebContents, "clipboard-sanitized-write", "https://example.com", details), false);
  assert.equal(requestResult({} as WebContents, "clipboard-sanitized-write"), false);
  assert.equal(check(owned, "clipboard-sanitized-write", "https://attacker.example", details), false);
  assert.equal(check(owned, "clipboard-sanitized-write", "https://example.com", { ...details, isMainFrame: false }), false);
  assert.equal(requestResult(owned, "clipboard-sanitized-write", { ...details, requestingUrl: "https://attacker.example/" }), false);
  assert.equal(requestResult(owned, "clipboard-sanitized-write", { ...details, isMainFrame: false }), false);
  closing = true;
  assert.equal(check(owned, "clipboard-sanitized-write", "https://example.com", details), false);
  assert.equal(requestResult(owned, "clipboard-sanitized-write"), false);
});
