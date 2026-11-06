import assert from "node:assert/strict";
import test from "node:test";
import { GhosttyTerminalCore, type GhosttyTheme } from "./core";
import {
  isTerminalHostReservedShortcut,
  isTerminalLinkActivatable,
  terminalLinkAtPositionWithRange,
  terminalSelectionAutoscrollRows,
} from "./surface";

const testTheme: GhosttyTheme = {
  foreground: { r: 238, g: 238, b: 238 },
  background: { r: 17, g: 17, b: 17 },
  cursor: { r: 10, g: 132, b: 255 },
  palette: Array.from({ length: 256 }, (_, value) => ({ r: value, g: value, b: value })),
};

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

test("dragging past the edge speeds up with distance and stops inside the terminal", () => {
  assert.equal(terminalSelectionAutoscrollRows(100, 50, 300), 0);
  assert.equal(terminalSelectionAutoscrollRows(301, 50, 300), 1);
  assert.equal(terminalSelectionAutoscrollRows(49, 50, 300), -1);
  assert.equal(terminalSelectionAutoscrollRows(350, 50, 300), 15);
  assert.equal(terminalSelectionAutoscrollRows(0, 50, 300), -15);
  assert.equal(terminalSelectionAutoscrollRows(900, 50, 300), 15);
});

test("a link containing wide characters resolves whole from either half of a wide cell", async () => {
  const url = "https://example.com/界面/docs";
  const core = await GhosttyTerminalCore.create(60, 4, 8, 16, testTheme, () => undefined);
  try {
    core.write(`see ${url} now`);
    const rows = core.snapshot().rowData;
    const start = "see ".length;
    const firstWideColumn = start + "https://example.com/".length;
    for (const column of [start, firstWideColumn, firstWideColumn + 1]) {
      assert.equal(terminalLinkAtPositionWithRange(rows, 0, column)?.text, url);
    }
    const endColumn = firstWideColumn + "界面".length * 2 + "/docs".length - 1;
    assert.deepEqual(terminalLinkAtPositionWithRange(rows, 0, start)?.range, {
      start: { x: start, y: 0 },
      end: { x: endColumn, y: 0 },
    });
    assert.equal(terminalLinkAtPositionWithRange(rows, 0, endColumn + 2), null);
  } finally {
    core.dispose();
  }
});

test("a link ending in a wide character covers both of its cells", async () => {
  const url = "https://example.com/界";
  const core = await GhosttyTerminalCore.create(60, 4, 8, 16, testTheme, () => undefined);
  try {
    core.write(url);
    const rows = core.snapshot().rowData;
    const lastColumn = "https://example.com/".length + 1;
    assert.equal(terminalLinkAtPositionWithRange(rows, 0, 0)?.range.end.x, lastColumn);
    assert.equal(terminalLinkAtPositionWithRange(rows, 0, lastColumn)?.text, url);
  } finally {
    core.dispose();
  }
});
