import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAidenRemoteConnectionMode,
  parseAidenRemoteTakeoverToken,
  parseAidenRemoteTransport,
} from "./aiden-remote-parse.js";

test("Remote Access IPC parsers accept only exact transport values", () => {
  assert.equal(parseAidenRemoteConnectionMode("lan"), "lan");
  assert.equal(parseAidenRemoteConnectionMode("tailscale"), "tailscale");
  assert.equal(parseAidenRemoteConnectionMode("both"), "both");
  assert.equal(parseAidenRemoteTransport("lan"), "lan");
  assert.equal(parseAidenRemoteTransport("tailscale"), "tailscale");
  for (const invalid of [undefined, null, true, "LAN", "both", ["lan"], { value: "lan" }]) {
    assert.throws(() => parseAidenRemoteTransport(invalid), /invalid/iu);
  }
});

test("Tailscale takeover IPC accepts only one exact opaque review token", () => {
  const token = "A".repeat(32);
  assert.equal(parseAidenRemoteTakeoverToken(token), token);
  for (const invalid of [undefined, null, "A".repeat(31), "A".repeat(33), `${"A".repeat(31)}+`, { token }]) {
    assert.throws(() => parseAidenRemoteTakeoverToken(invalid), /invalid/iu);
  }
});
