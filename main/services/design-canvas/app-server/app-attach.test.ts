import assert from "node:assert/strict";
import test from "node:test";
import { attachOrigin, attachOrigins, parseAttachUrl } from "./app-attach.js";

test("parseAttachUrl accepts a loopback http origin with an explicit port, as written", () => {
  assert.deepEqual(parseAttachUrl("http://localhost:4321"), { ok: true, url: "http://localhost:4321", port: 4321 });
  assert.deepEqual(parseAttachUrl("http://127.0.0.1:5173/"), { ok: true, url: "http://127.0.0.1:5173", port: 5173 });
  assert.deepEqual(parseAttachUrl("http://[::1]:3000"), { ok: true, url: "http://[::1]:3000", port: 3000 });
});

test("parseAttachUrl refuses anything that isn't exactly a loopback http origin", () => {
  const refused: unknown[] = [
    "https://localhost:4321",
    "ws://localhost:1",
    "http://192.168.1.10:3000",
    "http://localhost.evil.com:3000",
    "http://0.0.0.0:3000",
    "http://[::]:3000",
    "http://localhost",
    "http://u:p@localhost:3000",
    "http://localhost:3000/app",
    "http://localhost:3000?x=1",
    "http://localhost:3000#top",
    "http://localhost:80",
    "http://localhost:70000",
    "http://127.1:3000",
    " http://localhost:3000",
    `http://localhost:3000/${"a".repeat(280)}`,
    `http://localhost:${"0".repeat(290)}3000`,
    3000,
    null,
    undefined,
    { url: "http://localhost:3000" },
  ];
  for (const value of refused) assert.deepEqual(parseAttachUrl(value), { ok: false }, JSON.stringify(value));
});

const socket = (address: string, port = 5173) => ({ address, port });

test("attachOrigin picks the origin from the sockets the server holds", () => {
  assert.equal(attachOrigin([socket("127.0.0.1")], 5173), "http://127.0.0.1:5173");
  assert.equal(attachOrigin([socket("::ffff:127.0.0.1")], 5173), "http://127.0.0.1:5173");
  assert.equal(attachOrigin([socket("::1")], 5173), "http://[::1]:5173");
  assert.equal(attachOrigin([socket("::1"), socket("127.0.0.1")], 5173), "http://127.0.0.1:5173");
  assert.equal(attachOrigin([socket("127.0.0.2")], 5173), undefined, "another loopback address has no origin to load");
  assert.equal(attachOrigin([socket("127.0.0.1", 5174)], 5173), undefined, "a socket on another port");
});

test("attachOrigins lists every exact origin held on the port", () => {
  assert.deepEqual(attachOrigins([socket("127.0.0.1"), socket("::1")], 5173), ["http://127.0.0.1:5173", "http://[::1]:5173"]);
  assert.deepEqual(attachOrigins([socket("::1")], 5173), ["http://[::1]:5173"]);
  assert.deepEqual(attachOrigins([socket("127.0.0.2")], 5173), []);
});
