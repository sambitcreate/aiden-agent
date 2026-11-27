import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalReport } from "../../shared/terminal-reports";
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

async function withCore(
  run: (core: GhosttyTerminalCore) => void,
  cols = 20,
  rows = 4,
): Promise<void> {
  const core = await GhosttyTerminalCore.create(cols, rows, 8, 16, testTheme, () => undefined);
  try {
    run(core);
  } finally {
    core.dispose();
  }
}

test("synchronized output follows the program's brackets and can be ended by the host", async () => {
  await withCore((core) => {
    assert.equal(core.isSynchronizedOutput(), false);
    core.write("\x1b[?2026h");
    assert.equal(core.isSynchronizedOutput(), true);
    core.write("\x1b[?2026l");
    assert.equal(core.isSynchronizedOutput(), false);
    core.write("\x1b[?2026h");
    core.endSynchronizedOutput();
    assert.equal(core.isSynchronizedOutput(), false);
  });
});

test("a write reports the open group closing even when the same chunk opens another", async () => {
  await withCore((core) => {
    core.write("\x1b[?2026h");
    let ended = 0;
    core.write("one\x1b[?2026l two\x1b[?2026h three", () => {
      ended += 1;
    });
    assert.equal(ended, 1);
    assert.equal(core.isSynchronizedOutput(), true);
    assert.match(core.snapshot().rowData[0]!.text, /one two three/u);
  });
});

test("a write inside an open group that never closes it reports nothing", async () => {
  await withCore((core) => {
    core.write("\x1b[?2026h");
    let ended = 0;
    core.write("\x1b[1mstill open", () => {
      ended += 1;
    });
    assert.equal(ended, 0);
    assert.equal(core.isSynchronizedOutput(), true);
  });
});

test("a grid resize ends an open synchronized group", async () => {
  await withCore((core) => {
    core.write("\x1b[?2026h");
    assert.equal(core.isSynchronizedOutput(), true);
    core.resize(30, 6, 8, 16);
    assert.equal(core.isSynchronizedOutput(), false);
  });
});

test("select all reports the live range and keeps the selected text", async () => {
  await withCore((core) => {
    assert.equal(core.selectionRange(), null);
    core.write("alpha\r\nbeta");
    const range = core.selectAll();
    assert.ok(range);
    assert.deepEqual(core.selectionRange(), range);
    assert.match(core.selectionText(), /alpha\s+beta/u);
    core.clearSelection();
    assert.equal(core.selectionRange(), null);
  });
});

test("the terminal's own replies to startup queries read as reports, and no key it encodes does", async () => {
  const replies: string[] = [];
  const core = await GhosttyTerminalCore.create(80, 24, 8, 16, testTheme, (data) => replies.push(data));
  try {
    // What shell startup files and prompt themes ask: device attributes,
    // status and cursor reports, mode and keyboard-flag queries, window size,
    // colors, version and capability queries.
    const queries = [
      "\x1b[c",
      "\x1b[>c",
      "\x1b[=c",
      "\x1b[5n",
      "\x1b[6n",
      "\x1b[?6n",
      "\x1b[?2004$p",
      "\x1b[4$p",
      "\x1b[?u",
      "\x1b[14t",
      "\x1b[16t",
      "\x1b[18t",
      "\x1b]10;?\x07",
      "\x1b]11;?\x1b\\",
      "\x1b]4;1;?\x07",
      "\x1b[>q",
      "\x1bP$qm\x1b\\",
      "\x1bP+q544e\x1b\\",
    ];
    const answered: string[] = [];
    for (const query of queries) {
      const before = replies.length;
      core.write(query);
      const reply = replies.slice(before).join("");
      if (reply) answered.push(query);
      assert.ok(reply === "" || isTerminalReport(reply), `reply to ${JSON.stringify(query)}: ${JSON.stringify(reply)}`);
    }
    // The ones every prompt theme sends are answered, so the check above is
    // not vacuous, and a burst of replies in one write reads as reports too.
    for (const query of ["\x1b[c", "\x1b[6n", "\x1b[?u", "\x1b[?2004$p"]) {
      assert.ok(answered.includes(query), `no reply to ${JSON.stringify(query)}`);
    }
    assert.ok(isTerminalReport(replies.join("")));

    const codes = [
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Key${letter}`),
      ..."0123456789".split("").map((digit) => `Digit${digit}`),
      ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Insert",
      "Delete",
      "Enter",
      "Tab",
      "Backspace",
      "Escape",
      "Space",
      "Minus",
      "Equal",
      "BracketLeft",
      "Semicolon",
      "Slash",
    ];
    const keyFor = (code: string) => {
      if (code.startsWith("Key")) return code.slice(3).toLowerCase();
      if (code.startsWith("Digit")) return code.slice(5);
      return code === "Space" ? " " : code;
    };
    // Plain keys, application cursor keys, and the kitty keyboard protocol's
    // disambiguate and report-everything levels.
    for (const mode of ["", "\x1b[?1h", "\x1b[>1u", "\x1b[>31u"]) {
      core.write(mode);
      let encodedKeys = 0;
      for (const code of codes) {
        for (let mods = 0; mods < 8; mods += 1) {
          const event = {
            code,
            key: keyFor(code),
            shiftKey: (mods & 1) !== 0,
            ctrlKey: (mods & 2) !== 0,
            altKey: (mods & 4) !== 0,
            metaKey: false,
            repeat: false,
            isComposing: false,
            getModifierState: () => false,
          } as unknown as KeyboardEvent;
          const encoded = core.encodeKey(event);
          if (encoded) encodedKeys += 1;
          assert.ok(!isTerminalReport(encoded) || encoded === "", `${mode || "normal"} ${code} mods ${mods}: ${JSON.stringify(encoded)}`);
        }
      }
      assert.ok(encodedKeys > codes.length, `${mode || "normal"} encoded ${encodedKeys} keys`);
      core.write(mode === "\x1b[?1h" ? "\x1b[?1l" : mode ? "\x1b[<u" : "");
    }
  } finally {
    core.dispose();
  }
});
