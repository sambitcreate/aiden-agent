import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalHostReservedShortcut, isTerminalLinkActivatable } from "./surface";

test("macOS Command chords stay with the host instead of reaching the PTY", () => {
  assert.equal(isTerminalHostReservedShortcut({ metaKey: true }), true);
  assert.equal(isTerminalHostReservedShortcut({ metaKey: false }), false);
});

test("terminal link affordances honor the host navigation predicate", () => {
  const canActivate = (text: string) => /^https?:\/\//u.test(text) || /\.(?:html?|pdf)$/u.test(text);
  assert.equal(isTerminalLinkActivatable("https://example.com", canActivate), true);
  assert.equal(isTerminalLinkActivatable("docs/guide.pdf", canActivate), true);
  assert.equal(isTerminalLinkActivatable("renderer/main.ts:12", canActivate), false);
});
