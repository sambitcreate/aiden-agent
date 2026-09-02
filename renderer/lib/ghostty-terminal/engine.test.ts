import assert from "node:assert/strict";
import test from "node:test";
import { GhosttyEngine, parseCssColor } from "./engine";
import { Key, Mods } from "./keys";

test("libghostty-vt parses VT output into screen cells", async () => {
  const engine = await GhosttyEngine.load();
  const terminal = engine.createTerminal(40, 8);
  terminal.write("Hi\x1b[31m!\x1b[0m\r\nready");
  assert.equal(terminal.lineText(0), "Hi!");
  assert.equal(terminal.lineText(1), "ready");
  const bang = terminal.getLine(0)[2];
  assert.ok(bang);
  assert.equal(bang.codepoint, 33);
  assert.deepEqual(bang.fg, [204, 102, 102]);
  terminal.free();
  engine.dispose();
});

test("libghostty-vt encodes Enter and printable keys for the PTY", async () => {
  const engine = await GhosttyEngine.load();
  const enter = engine.encodeKey({ key: Key.ENTER, mods: Mods.NONE });
  assert.deepEqual([...enter], [13]);
  const letter = engine.encodeKey({ key: Key.A, mods: Mods.NONE, utf8: "a" });
  assert.deepEqual([...letter], [97]);
  engine.dispose();
});

test("theme color parsing accepts hex and rgb tokens", () => {
  assert.equal(parseCssColor("#0a84ff", 0), 0x0a84ff);
  assert.equal(parseCssColor("rgb(10, 132, 255)", 0), 0x0a84ff);
  assert.equal(parseCssColor("not-a-color", 0x112233), 0x112233);
});
