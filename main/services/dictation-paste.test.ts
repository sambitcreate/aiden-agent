import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ATOMIC_PASTE_SCRIPT,
  createSecureInputPrefetch,
  detectMacSecureInput,
  KEYSTROKE_SENT_MARKER,
  PasteAfterKeystrokeError,
  pasteTranscript,
  runAtomicMacPaste,
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
    message: "Check the field — transcript copied.",
  });
});

test("an unconfirmed paste never tells the user to insert the transcript again", async () => {
  let textMayAlreadyBeInserted = false;
  const subject = harness({
    pasteWithPreservedClipboard: async () => {
      textMayAlreadyBeInserted = true;
      return false;
    },
  });
  const result = await pasteTranscript("Smart quotes may transform this text", subject.deps);
  assert.equal(textMayAlreadyBeInserted, true);
  assert.equal(result.outcome, "copied");
  assert.equal(result.message, "Check the field — transcript copied.");
  assert.doesNotMatch(result.message ?? "", /press|⌘V|couldn.t paste/i);
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
    message: "Check the field — transcript copied.",
  });
  assert.equal(subject.clipboard(), "hello world");
});

test("a transaction killed after sending ⌘V restores the clipboard instead of copying the transcript again", async () => {
  const timedOut = Object.assign(new Error("Command failed: osascript"), { killed: true, stderr: `${KEYSTROKE_SENT_MARKER}\n` });
  const restores: string[] = [];
  const subject = harness({
    pasteWithPreservedClipboard: (text) => runAtomicMacPaste(text, async () => Promise.reject(timedOut)),
    saveClipboard: (text) => () => restores.push(text),
  });
  const before = subject.clipboard();
  assert.deepEqual(await pasteTranscript("hello world", subject.deps), { outcome: "pasted" });
  assert.equal(subject.clipboard(), before, "the transcript is not written over the person's clipboard");
  assert.deepEqual(restores, ["hello world"]);
});

test("a transaction killed before sending ⌘V still leaves the transcript on the clipboard", async () => {
  const timedOut = Object.assign(new Error("Command failed: osascript"), { killed: true, stderr: "" });
  const restores: string[] = [];
  const subject = harness({
    pasteWithPreservedClipboard: (text) => runAtomicMacPaste(text, async () => Promise.reject(timedOut)),
    saveClipboard: (text) => () => restores.push(text),
  });
  const result = await pasteTranscript("hello world", subject.deps);
  assert.equal(result.outcome, "copied");
  assert.equal(subject.clipboard(), "hello world");
  assert.deepEqual(restores, []);
  await assert.rejects(runAtomicMacPaste("x", async () => Promise.reject(timedOut)), (error) => !(error instanceof PasteAfterKeystrokeError));
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

test(
  "documented Secure Input probe follows a process-owned enable/disable cycle",
  { skip: process.platform !== "darwin" },
  async () => {
    const result = await runJxa(`ObjC.import("Carbon");
var before = Boolean($.IsSecureEventInputEnabled());
var status = $.EnableSecureEventInput();
if (status !== 0) throw new Error("Could not enable Secure Input for test");
var enabled;
try { enabled = Boolean($.IsSecureEventInputEnabled()); }
finally { $.DisableSecureEventInput(); }
JSON.stringify({before: before, enabled: enabled, after: Boolean($.IsSecureEventInputEnabled())});`);
    const state = JSON.parse(result) as { before: boolean; enabled: boolean; after: boolean };
    assert.equal(state.enabled, true);
    assert.equal(state.after, state.before);
  },
);

function probeHarness() {
  let clock = 0;
  const answers: boolean[] = [];
  let probes = 0;
  const prefetch = createSecureInputPrefetch({
    probe: async () => {
      probes += 1;
      return answers.shift() ?? false;
    },
    now: () => clock,
    maxAgeMs: 1_000,
  });
  return {
    prefetch,
    answers,
    probes: () => probes,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a Secure Input probe started at stop answers the paste that follows", async () => {
  const subject = probeHarness();
  subject.answers.push(true);
  subject.prefetch.prefetch();
  subject.advance(300);
  // The second prefetch (as delivery begins) reuses the probe already running.
  subject.prefetch.prefetch();
  assert.equal(await subject.prefetch.isSecureInputActive(), true);
  assert.equal(subject.probes(), 1);
});

test("a stale or already used probe is never trusted for a paste", async () => {
  const subject = probeHarness();
  subject.answers.push(false, true, false);
  subject.prefetch.prefetch();
  subject.advance(1_001);
  // The focused field may have changed since: ask again.
  assert.equal(await subject.prefetch.isSecureInputActive(), true);
  assert.equal(subject.probes(), 2);
  assert.equal(await subject.prefetch.isSecureInputActive(), false);
  assert.equal(subject.probes(), 3);
});

test("a failed prefetched probe still keeps the transcript on the clipboard", async () => {
  const prefetch = createSecureInputPrefetch({
    probe: async () => {
      throw new Error("osascript timed out");
    },
    now: () => 0,
  });
  prefetch.prefetch();
  const { deps, clipboard } = harness({ isSecureInputActive: () => prefetch.isSecureInputActive() });
  const result = await pasteTranscript("hello", deps);
  assert.equal(result.outcome, "copied");
  assert.equal(clipboard(), "hello");
});
