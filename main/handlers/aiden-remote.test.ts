import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  parseAidenRemoteConnectionMode,
  parseAidenRemoteScopedIdentifier,
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

test("Remote approval IPC identifiers are bounded and path-safe", () => {
  for (const value of ["chat-1", "approval_1", "stream:one", "chat.fixture"]) {
    assert.equal(parseAidenRemoteScopedIdentifier(value), value);
  }
  for (const invalid of ["", "../chat", "chat/one", "chat one", "A".repeat(129), null]) {
    assert.throws(() => parseAidenRemoteScopedIdentifier(invalid), /invalid/iu);
  }
});

test("Tailscale takeover IPC accepts only one exact opaque review token", () => {
  const token = "A".repeat(32);
  assert.equal(parseAidenRemoteTakeoverToken(token), token);
  for (const invalid of [undefined, null, "A".repeat(31), "A".repeat(33), `${"A".repeat(31)}+`, { token }]) {
    assert.throws(() => parseAidenRemoteTakeoverToken(invalid), /invalid/iu);
  }
});

test("Remote approval IPC is bound to the current main-frame document across awaits", async () => {
  const source = await readFile(new URL("./aiden-remote.ts", import.meta.url), "utf8");
  const approvalHandlers = source.slice(
    source.indexOf('ipcMain.handle("remote:getPendingApproval"'),
    source.indexOf('ipcMain.handle("remote:setEnabled"'),
  );
  assert.match(approvalHandlers, /rendererDocumentOwner\(/u);
  assert.match(approvalHandlers, /owner\.isDestroyed\(\)/u);
  assert.doesNotMatch(approvalHandlers, /async \(_event/u);
});

test("saved endpoint repair is an explicit IPC action", async () => {
  const source = await readFile(new URL("./aiden-remote.ts", import.meta.url), "utf8");
  assert.match(source, /ipcMain\.handle\("remote:moveToAvailablePort"/u);
  assert.match(source, /service\.moveToAvailablePort\(\)/u);
});

test("pairing and Tailscale mutations return structured results instead of rejecting IPC", async () => {
  const source = await readFile(new URL("./aiden-remote.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../../renderer/lib/ipc.ts", import.meta.url), "utf8");
  for (const channel of [
    "remote:beginPairing",
    "remote:tailscaleConnect",
    "remote:tailscaleDisconnect",
    "remote:tailscaleReconcile",
    "remote:tailscaleReviewTakeover",
    "remote:tailscaleTakeOver",
  ]) {
    const start = source.indexOf(`ipcMain.handle("${channel}"`);
    assert.ok(start >= 0, channel);
    const slice = source.slice(start, start + 420);
    assert.match(slice, /remoteDesktopResult\(/u);
    assert.match(ipc, new RegExp(String.raw`"${channel}"[\s\S]{0,180}?unwrapAidenRemoteDesktopResult`, "u"));
  }
  assert.doesNotMatch(source, /add your handlers/u);
});

test("home-folder approval uses a typed confirmation error", async () => {
  const source = await readFile(new URL("./aiden-remote.ts", import.meta.url), "utf8");
  assert.match(source, /AidenRemoteHomeDirectoryConfirmationRequiredError/u);
  assert.doesNotMatch(source, /error\.message\.includes\("entire home directory"\)/u);
});
