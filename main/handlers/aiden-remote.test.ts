import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAidenRemoteConnectionMode,
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
