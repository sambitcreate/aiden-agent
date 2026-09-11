import assert from "node:assert/strict";
import test from "node:test";
import { GhosttyTerminalCore, ghosttyCellText, type GhosttyTheme } from "./core";

const testTheme: GhosttyTheme = {
  foreground: { r: 238, g: 238, b: 238 },
  background: { r: 17, g: 17, b: 17 },
  cursor: { r: 10, g: 132, b: 255 },
  palette: Array.from({ length: 256 }, (_, value) => ({ r: value, g: value, b: value })),
};

function codepointView(codepoints: ReadonlyArray<number>): DataView {
  const view = new DataView(new ArrayBuffer(codepoints.length * 4));
  codepoints.forEach((codepoint, index) => view.setUint32(index * 4, codepoint, true));
  return view;
}

test("ghosttyCellText converts oversized grapheme clusters without spread limits", () => {
  const graphemeLength = 130_000;
  const view = new DataView(new ArrayBuffer(graphemeLength * 4));
  for (let index = 0; index < graphemeLength; index += 1) {
    view.setUint32(index * 4, index === 0 ? "a".codePointAt(0)! : 0x301, true);
  }
  const text = ghosttyCellText(view, graphemeLength);
  assert.equal(text.length, graphemeLength);
  assert.equal(text.codePointAt(0), "a".codePointAt(0));
  assert.equal(text.codePointAt(1), 0x301);
  assert.equal(text.codePointAt(graphemeLength - 1), 0x301);
});

test("ghosttyCellText converts small clusters including astral codepoints", () => {
  const text = ghosttyCellText(codepointView([0x1f642, 0x20e3]), 2);
  assert.deepEqual([...text], ["\u{1F642}", "\u{20E3}"]);
});

test("ghosttyCellText returns an empty string for empty cells", () => {
  assert.equal(ghosttyCellText(codepointView([]), 0), "");
});

test("ED3 clears saved scrollback before the visible page is reset", async () => {
  const core = await GhosttyTerminalCore.create(20, 4, 8, 16, testTheme, () => undefined);
  try {
    core.write(Array.from({ length: 12 }, (_, index) => `line ${index}\r\n`).join(""));
    const before = core.scrollbarState();
    assert.ok(before && before.total > before.len);
    core.write("\x1b[3J\x1b[2J\x1b[H");
    const after = core.scrollbarState();
    assert.ok(after && after.total === after.len);
  } finally {
    core.dispose();
  }
});
