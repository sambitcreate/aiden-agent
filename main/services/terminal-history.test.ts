import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_HISTORY_CHARS,
  TerminalHistoryStore,
  capHistory,
  sanitizeTerminalHistoryChunk,
} from "./terminal-history.js";

function safeId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

// Device-query / reply sequences that MUST be stripped from replayed history.
// CSI cursor-position report (CSI 6 n).
const CSI_CPR = "\u001b[6n";
// CSI device-attributes query (CSI c).
const CSI_DA = "\u001b[c";
// CSI device-status report (CSI 5 n).
const CSI_DSR = "\u001b[5n";

// Benign sequences that MUST survive sanitization.
// SGR red (CSI 3 1 m).
const SGR_RED = "\u001b[31m";
// SGR reset (CSI 0 m).
const SGR_RESET = "\u001b[0m";

test("sanitizer strips CSI cursor-position, device-attributes, and device-status queries", () => {
  const input = `hello ${CSI_CPR}${CSI_DA}world${CSI_DSR}!`;
  const { visibleText, pendingControlSequence } = sanitizeTerminalHistoryChunk("", input);
  assert.equal(pendingControlSequence, "");
  assert.equal(visibleText, "hello world!");
});

test("sanitizer preserves benign SGR color sequences", () => {
  const input = `${SGR_RED}error${SGR_RESET}`;
  const { visibleText } = sanitizeTerminalHistoryChunk("", input);
  assert.equal(visibleText, input);
});

test("sanitizer carries an incomplete escape sequence across chunk boundaries", () => {
  // Split right in the middle of a CSI sequence: "\x1b[6" then "n".
  const first = sanitizeTerminalHistoryChunk("", "a\u001b[6");
  assert.equal(first.visibleText, "a");
  assert.equal(first.pendingControlSequence, "\u001b[6");

  const second = sanitizeTerminalHistoryChunk(first.pendingControlSequence, "nb");
  assert.equal(second.pendingControlSequence, "");
  // The full CSI 6 n was recognized and stripped; "b" is the only new visible text.
  assert.equal(second.visibleText, "b");
});

test("sanitizer strips OSC color queries (10;?) and rgb: replies", () => {
  // OSC 10 ; ? ST — a foreground-color query. ST is ESC \.
  const oscQuery = "\u001b]10;?\u001b\\";
  const { visibleText } = sanitizeTerminalHistoryChunk("", `x${oscQuery}y`);
  assert.equal(visibleText, "xy");
});

test("sanitizer strips DCS DECRQSS ($q) queries", () => {
  // DCS $ q m ST — a DECRQSS query for SGR.
  const dcsQuery = "\u001bP$qm\u001b\\";
  const { visibleText } = sanitizeTerminalHistoryChunk("", `pre${dcsQuery}post`);
  assert.equal(visibleText, "prepost");
});

test("capHistory keeps only the most recent N lines", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
  const capped = capHistory(lines, 3);
  assert.equal(capped, "line7\nline8\nline9");
});

test("capHistory preserves a trailing newline", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n") + "\n";
  const capped = capHistory(lines, 2);
  assert.equal(capped, "line8\nline9\n");
});

test("capHistory bounds a long history without line breaks", () => {
  const capped = capHistory("x".repeat(MAX_HISTORY_CHARS + 100), 5_000);
  assert.equal(capped.length, MAX_HISTORY_CHARS);
});

test("TerminalHistoryStore round-trips appended chunks after flush", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-history-"));
  const store = new TerminalHistoryStore({ logsDir: dir, debounceMs: 0 });
  try {
    store.append("ws-1", "hello ");
    store.append("ws-1", "world");
    await store.flush("ws-1");
    const read = await store.read("ws-1");
    assert.equal(read, "hello world");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TerminalHistoryStore preserves restored history when appending after restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-history-restart-"));
  try {
    const first = new TerminalHistoryStore({ logsDir: dir, debounceMs: 0 });
    first.append("ws-1", "before restart\n");
    await first.flush("ws-1");

    const restarted = new TerminalHistoryStore({ logsDir: dir, debounceMs: 0 });
    assert.equal(await restarted.read("ws-1"), "before restart\n");
    restarted.append("ws-1", "after restart\n");
    await restarted.flush("ws-1");

    const verified = new TerminalHistoryStore({ logsDir: dir });
    assert.equal(await verified.read("ws-1"), "before restart\nafter restart\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TerminalHistoryStore flushAll settles every workspace before shutdown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-history-flush-all-"));
  const store = new TerminalHistoryStore({ logsDir: dir, debounceMs: 60_000 });
  try {
    store.append("ws-1", "alpha");
    store.append("ws-2", "beta");
    await store.flushAll();

    const verified = new TerminalHistoryStore({ logsDir: dir });
    assert.equal(await verified.read("ws-1"), "alpha");
    assert.equal(await verified.read("ws-2"), "beta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TerminalHistoryStore flushAll retains output appended during an active write", async () => {
  const writes: string[] = [];
  let fire: () => void = () => {};
  let releaseFirstWrite: () => void = () => {};
  const firstWriteBlocked = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const store = new TerminalHistoryStore({
    logsDir: "/unused-test-history",
    schedule: (fn) => {
      fire = fn;
      return () => {
        fire = () => {};
      };
    },
    writeFile: async (_filePath, history) => {
      writes.push(history);
      if (writes.length === 1) await firstWriteBlocked;
    },
  });

  store.append("ws-1", "alpha");
  fire();
  await new Promise<void>((resolve) => setImmediate(resolve));
  store.append("ws-1", " beta");
  releaseFirstWrite();
  await store.flushAll();

  assert.deepEqual(writes, ["alpha", "alpha beta"]);
});

test("TerminalHistoryStore persists sanitized output to disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-history-sanitize-"));
  const store = new TerminalHistoryStore({ logsDir: dir, debounceMs: 0 });
  try {
    store.append("ws-1", `visible ${CSI_CPR}text`);
    await store.flush("ws-1");
    const file = path.join(dir, `${safeId("ws-1")}.log`);
    const raw = await readFile(file, "utf8");
    // The device query must not be in the persisted file.
    assert.ok(!raw.includes(CSI_CPR));
    assert.equal(raw, "visible text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TerminalHistoryStore isolates histories per workspace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-history-iso-"));
  const store = new TerminalHistoryStore({ logsDir: dir, debounceMs: 0 });
  try {
    store.append("ws-1", "alpha");
    store.append("ws-2", "beta");
    await store.flush("ws-1");
    await store.flush("ws-2");
    assert.equal(await store.read("ws-1"), "alpha");
    assert.equal(await store.read("ws-2"), "beta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TerminalHistoryStore.clear removes the persisted log", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-history-clear-"));
  const store = new TerminalHistoryStore({ logsDir: dir, debounceMs: 0 });
  try {
    store.append("ws-1", "data");
    await store.flush("ws-1");
    assert.equal(await store.read("ws-1"), "data");
    await store.clear("ws-1");
    assert.equal(await store.read("ws-1"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TerminalHistoryStore coalesces rapid appends into one debounced write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-history-coalesce-"));
  // Use a fake scheduler so the test is deterministic and fast.
  let scheduledCount = 0;
  let fire: () => void = () => {};
  const store = new TerminalHistoryStore({
    logsDir: dir,
    debounceMs: 100,
    schedule: (fn) => {
      scheduledCount += 1;
      fire = fn;
      return () => {
        fire = () => {};
      };
    },
  });
  try {
    // Many rapid appends should schedule the write exactly once.
    for (let i = 0; i < 50; i += 1) store.append("ws-1", "x");
    assert.equal(scheduledCount, 1);
    // Fire the coalesced write.
    fire();
    // Allow the writeFile to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await store.read("ws-1"), "x".repeat(50));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production startup installs and flushes persisted terminal history", async () => {
  const main = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(main, /TerminalHistoryStore/u);
  assert.match(
    main,
    /terminalService\.installHistoryStore\(await TerminalHistoryStore\.create\(\)\)/u,
  );
  assert.match(main, /terminalService\.flushHistory\(\)/u);
});
