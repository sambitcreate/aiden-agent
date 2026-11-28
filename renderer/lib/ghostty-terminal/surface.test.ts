import assert from "node:assert/strict";
import test from "node:test";
import { GhosttyTerminalCore, type GhosttyTheme } from "./core";
import { isMacPlatform } from "./host-platform";
import {
  isTerminalCopyShortcut,
  isTerminalHostReservedShortcut,
  isTerminalLinkActivatable,
  isTerminalLinkPointerGesture,
  isTerminalPasteShortcut,
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

function withNavigator(stub: unknown, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  if (stub === undefined) {
    Reflect.deleteProperty(globalThis, "navigator");
  } else {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: stub,
    });
  }
  try {
    run();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  }
}

test("isMacPlatform and terminal shortcuts read navigator.userAgentData.platform", () => {
  withNavigator(
    {
      userAgentData: { platform: "macOS" },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    },
    () => {
      assert.equal(isMacPlatform(), true);
      assert.equal(
        isTerminalCopyShortcut({ key: "c", metaKey: true, ctrlKey: false, shiftKey: false }),
        true,
      );
      assert.equal(
        isTerminalCopyShortcut({ key: "c", metaKey: false, ctrlKey: true, shiftKey: false }),
        false,
      );
      assert.equal(
        isTerminalPasteShortcut({ key: "v", metaKey: true, ctrlKey: false, shiftKey: false }),
        true,
      );
      assert.equal(
        isTerminalPasteShortcut({ key: "Insert", metaKey: false, ctrlKey: false, shiftKey: true }),
        false,
      );
      assert.equal(isTerminalLinkPointerGesture({ metaKey: true, ctrlKey: false }), true);
      assert.equal(isTerminalLinkPointerGesture({ metaKey: false, ctrlKey: true }), false);
    },
  );

  withNavigator({ userAgentData: { platform: "iOS" }, userAgent: "" }, () => {
    assert.equal(isMacPlatform(), true);
  });

  withNavigator(
    {
      userAgentData: { platform: "Linux" },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    },
    () => {
      assert.equal(isMacPlatform(), false);
      assert.equal(
        isTerminalCopyShortcut({ key: "c", metaKey: false, ctrlKey: true, shiftKey: false }),
        true,
      );
      assert.equal(
        isTerminalPasteShortcut({ key: "v", metaKey: false, ctrlKey: true, shiftKey: true }),
        true,
      );
      assert.equal(
        isTerminalPasteShortcut({ key: "Insert", metaKey: false, ctrlKey: false, shiftKey: true }),
        true,
      );
      assert.equal(isTerminalLinkPointerGesture({ metaKey: false, ctrlKey: true }), true);
    },
  );
});

test("isMacPlatform falls back to navigator.userAgent when userAgentData is absent or blank", () => {
  withNavigator(
    { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    () => {
      assert.equal(isMacPlatform(), true);
      assert.equal(
        isTerminalCopyShortcut({ key: "c", metaKey: true, ctrlKey: false, shiftKey: false }),
        true,
      );
    },
  );

  withNavigator(
    {
      userAgentData: { platform: "" },
      userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
    },
    () => {
      assert.equal(isMacPlatform(), true);
      assert.equal(
        isTerminalPasteShortcut({ key: "v", metaKey: true, ctrlKey: false, shiftKey: false }),
        true,
      );
    },
  );

  withNavigator(
    {
      userAgentData: { platform: "" },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
    () => {
      assert.equal(isMacPlatform(), false);
      assert.equal(isTerminalLinkPointerGesture({ metaKey: false, ctrlKey: true }), true);
    },
  );
});

test("terminal platform helpers handle missing navigator and honor explicit platform overrides", () => {
  withNavigator(undefined, () => {
    assert.equal(isMacPlatform(), false);
    assert.equal(
      isTerminalCopyShortcut({ key: "c", metaKey: false, ctrlKey: true, shiftKey: false }),
      true,
    );
    assert.equal(
      isTerminalPasteShortcut({ key: "v", metaKey: false, ctrlKey: true, shiftKey: true }),
      true,
    );
    assert.equal(isTerminalLinkPointerGesture({ metaKey: false, ctrlKey: true }), true);

    assert.equal(isMacPlatform("MacIntel"), true);
    assert.equal(isMacPlatform("macOS"), true);
    assert.equal(isMacPlatform("iOS"), true);
    assert.equal(
      isTerminalCopyShortcut(
        { key: "c", metaKey: true, ctrlKey: false, shiftKey: false },
        "MacIntel",
      ),
      true,
    );
    assert.equal(
      isTerminalPasteShortcut(
        { key: "v", metaKey: true, ctrlKey: false, shiftKey: false },
        "macOS",
      ),
      true,
    );
    assert.equal(isTerminalLinkPointerGesture({ metaKey: true, ctrlKey: false }, "iOS"), true);
  });

  withNavigator({ userAgentData: { platform: "macOS" } }, () => {
    assert.equal(isMacPlatform("Linux x86_64"), false);
    assert.equal(isMacPlatform(""), false);
    assert.equal(
      isTerminalPasteShortcut(
        { key: "v", metaKey: false, ctrlKey: true, shiftKey: true },
        "Linux x86_64",
      ),
      true,
    );
  });
});
