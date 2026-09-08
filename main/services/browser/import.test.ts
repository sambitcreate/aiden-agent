import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  browserCookieScope,
  decryptBrowserCookie,
  firefoxCookieExpiry,
  firefoxCookieSameSite,
  parseSafariCookies,
  readBrowserCookieDatabase,
} from "./import.js";

test("cookie import preserves host-only domains and rejects widened or invalid scope", () => {
  assert.deepEqual(browserCookieScope("example.com", "/login", true), {
    url: "https://example.com/login",
    path: "/login",
  });
  assert.equal(browserCookieScope(".example.com", "/", true).domain, ".example.com");
  for (const value of ["", "example.com/evil", "user@example.com", "example.com:80", "a b"]) {
    assert.throws(() => browserCookieScope(value, "/", true));
  }
});
test("Chromium domain-bound decryption rejects swapped domains and unsupported ciphertext", () => {
  const key = Buffer.alloc(16, 7);
  const domain = ".example.com";
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const plaintext = Buffer.concat([
    createHash("sha256").update(domain).digest(),
    Buffer.from("secret"),
  ]);
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
  assert.equal(decryptBrowserCookie(encrypted, key, domain, 24), "secret");
  assert.equal(decryptBrowserCookie(encrypted, key, ".other.com", 24), null);
  assert.equal(decryptBrowserCookie(Buffer.from("v20invalid"), key, domain, 24), null);
});
test("Firefox expiry/schema and SameSite preserve the source cookie policy", () => {
  assert.equal(firefoxCookieExpiry(2000000000, 15), 2000000000);
  assert.equal(firefoxCookieExpiry(2000000000000, 16), 2000000000);
  assert.equal(firefoxCookieExpiry(0, 16), undefined);
  assert.equal(firefoxCookieSameSite(null, null), "unspecified");
  assert.equal(firefoxCookieSameSite(1, 0), "unspecified");
  assert.equal(firefoxCookieSameSite(0, null), "no_restriction");
  assert.equal(firefoxCookieSameSite(2, null), "strict");
});
test("Firefox SQLite backup includes current WAL and excludes private/container identities", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-browser-cookie-test-"));
  const file = path.join(folder, "cookies.sqlite");
  const database = new DatabaseSync(file);
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA user_version=16; CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)",
    );
    const insert = database.prepare("INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)");
    insert.run("example.com", "session", "live-wal", "/", 2000000000000, 1, 1, 1, "");
    insert.run(
      "example.com",
      "session",
      "container",
      "/",
      2000000000000,
      1,
      1,
      1,
      "^userContextId=1",
    );
    const result = await readBrowserCookieDatabase({
      id: "test",
      browser: "Firefox",
      profile: "test",
      path: file,
      engine: "firefox",
    });
    assert.equal(result.cookies.length, 1);
    assert.equal(result.cookies[0].value, "live-wal");
    assert.equal(result.cookies[0].expirationDate, 2000000000);
    assert.equal(result.cookies[0].domain, undefined);
  } finally {
    database.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
test("Safari parser rejects truncated pages and forged page/record offsets", () => {
  assert.throws(() => parseSafariCookies(Buffer.from("cook")));
  const header = Buffer.alloc(12);
  header.write("cook");
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(1000, 8);
  assert.throws(() => parseSafariCookies(header));
  const empty = Buffer.alloc(8);
  empty.write("cook");
  assert.deepEqual(parseSafariCookies(empty), []);
});
