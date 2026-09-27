import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ATOMIC_PASTE_SCRIPT,
  detectMacSecureInput,
  pasteTranscript,
  runJxa,
  SECURE_INPUT_PROBE_SCRIPT,
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
    isSecureInputActive: async () => false,
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
  assert.match(
    ATOMIC_PASTE_SCRIPT,
    /deliveredValue is originalValue or deliveredValue does not contain transcriptText then return "copied"/,
  );
  assert.ok(
    ATOMIC_PASTE_SCRIPT.indexOf("deliveredValue is originalValue") <
      ATOMIC_PASTE_SCRIPT.indexOf("set the clipboard to previousClipboard"),
  );
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
  assert.deepEqual(await pasteTranscript("hello world", subject.deps), {
    outcome: "pasted",
  });
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
  assert.deepEqual(await pasteTranscript("hello world", subject.deps), {
    outcome: "copied",
    reason: "accessibility-required",
    message: "Copied — allow Accessibility to paste automatically.",
  });
  assert.equal(subject.clipboard(), "hello world");
  assert.equal(attempts, 0);
});

test("focus changes degrade to the clipboard result returned by the native transaction", async () => {
  const subject = harness({
    pasteWithPreservedClipboard: async () => false,
  });
  assert.deepEqual(await pasteTranscript("hello world", subject.deps), {
    outcome: "copied",
    reason: "paste-unavailable",
    message: "Copied — Aiden couldn’t confirm delivery to the focused field.",
  });
});

test("paste failures leave the transcript on the clipboard instead of throwing", async () => {
  const subject = harness({
    pasteWithPreservedClipboard: async () => {
      throw new Error("osascript failed");
    },
  });
  assert.deepEqual(await pasteTranscript("hello world", subject.deps), {
    outcome: "copied",
    reason: "paste-unavailable",
    message: "Copied — Aiden couldn’t paste into the focused app.",
  });
  assert.equal(subject.clipboard(), "hello world");
});

test("active Secure Input keeps the transcript on the clipboard without sending a keystroke", async () => {
  let attempts = 0;
  const subject = harness({
    isSecureInputActive: async () => true,
    pasteWithPreservedClipboard: async () => {
      attempts += 1;
      return true;
    },
  });
  const result = await pasteTranscript("my secret note", subject.deps);
  assert.equal(result.outcome, "copied");
  assert.equal(result.reason, "secure-input");
  assert.match(result.message ?? "", /⌘V/);
  assert.equal(subject.clipboard(), "my secret note");
  assert.equal(attempts, 0);
});

test("missing Accessibility access takes precedence over Secure Input detection", async () => {
  let probes = 0;
  const subject = harness({
    isAccessibilityTrusted: () => false,
    isSecureInputActive: async () => {
      probes += 1;
      return true;
    },
  });
  const result = await pasteTranscript("hello world", subject.deps);
  assert.equal(result.reason, "accessibility-required");
  assert.equal(probes, 0);
});

test("a failed Secure Input probe preserves the transcript without attempting paste", async () => {
  const logged: string[] = [];
  const subject = harness({
    isSecureInputActive: async () => {
      throw new Error("osascript timed out");
    },
    log: (message) => logged.push(message),
  });
  assert.equal((await pasteTranscript("hello world", subject.deps)).outcome, "copied");
  assert.equal(subject.pastedText(), "");
  assert.equal(subject.clipboard(), "hello world");
  assert.equal(logged.length, 1);
});

test("Secure Input detection maps probe output and rejects unrecognized output", async () => {
  const probe = (output: string) => async () => `${output}\n`;
  assert.equal(await detectMacSecureInput(probe("secure")), true);
  assert.equal(await detectMacSecureInput(probe("clear")), false);
  await assert.rejects(detectMacSecureInput(probe("execution error: -2700")));
  await assert.rejects(
    detectMacSecureInput(async () => {
      throw new Error("spawn failed");
    }),
  );
});

test(
  "Secure Input probe runs against the documented Carbon API",
  { skip: process.platform !== "darwin" },
  async () => {
    assert.match(await runJxa(SECURE_INPUT_PROBE_SCRIPT), /^(secure|clear)$/);
  },
);
