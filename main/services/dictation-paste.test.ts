import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ATOMIC_PASTE_SCRIPT,
  pasteTranscript,
  type PasteDeps,
} from "./dictation-paste.js";

const executeFile = promisify(execFile);

function harness(overrides: Partial<PasteDeps> = {}) {
  let clipboard: unknown = { image: Buffer.from([1, 2, 3]), files: ["/tmp/photo.png"] };
  let pastedText = "";
  const deps: PasteDeps = {
    writeClipboard: (text) => {
      clipboard = text;
    },
    isAccessibilityTrusted: () => true,
    pasteWithPreservedClipboard: async (text) => {
      pastedText = text;
      return true;
    },
    ...overrides,
  };
  return { deps, clipboard: () => clipboard, pastedText: () => pastedText };
}

test("native paste transaction preserves all pasteboard representations and rechecks focus", () => {
  assert.match(ATOMIC_PASTE_SCRIPT, /the clipboard as record/);
  assert.match(ATOMIC_PASTE_SCRIPT, /unix id of currentProcess/);
  assert.match(ATOMIC_PASTE_SCRIPT, /currentElement is not targetElement/);
  assert.match(ATOMIC_PASTE_SCRIPT, /clipboard as text.*transcriptText/s);
  assert.match(ATOMIC_PASTE_SCRIPT, /quietWindow/);
  assert.match(ATOMIC_PASTE_SCRIPT, /is not transcriptText then return "pasted"/);
  assert.match(ATOMIC_PASTE_SCRIPT, /set the clipboard to previousClipboard/);
});

test(
  "native paste transaction is valid AppleScript",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aiden-dictation-script-"));
    try {
      await executeFile("/usr/bin/osacompile", [
        "-o",
        path.join(directory, "paste.scpt"),
        "-e",
        ATOMIC_PASTE_SCRIPT,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("successful delivery delegates one atomic paste without flattening the clipboard", async () => {
  const subject = harness();
  assert.equal(await pasteTranscript("hello world", subject.deps), "pasted");
  assert.equal(subject.pastedText(), "hello world");
  assert.deepEqual(subject.clipboard(), {
    image: Buffer.from([1, 2, 3]),
    files: ["/tmp/photo.png"],
  });
});

test("without accessibility access the transcript is copied and paste is not attempted", async () => {
  let attempts = 0;
  const subject = harness({
    isAccessibilityTrusted: () => false,
    pasteWithPreservedClipboard: async () => {
      attempts += 1;
      return true;
    },
  });
  assert.equal(await pasteTranscript("hello world", subject.deps), "copied");
  assert.equal(subject.clipboard(), "hello world");
  assert.equal(attempts, 0);
});

test("focus changes degrade to the clipboard result returned by the native transaction", async () => {
  const subject = harness({
    pasteWithPreservedClipboard: async () => false,
  });
  assert.equal(await pasteTranscript("hello world", subject.deps), "copied");
});

test("paste failures leave the transcript on the clipboard instead of throwing", async () => {
  const subject = harness({
    pasteWithPreservedClipboard: async () => {
      throw new Error("osascript failed");
    },
  });
  assert.equal(await pasteTranscript("hello world", subject.deps), "copied");
  assert.equal(subject.clipboard(), "hello world");
});
