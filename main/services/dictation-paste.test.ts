import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ATOMIC_PASTE_SCRIPT,
  confirmMacPasteDelivered,
  createSecureInputPrefetch,
  detectMacSecureInput,
  KEYSTROKE_SENT_MARKER,
  PASTE_CONFIRM_DELAY_MS,
  PASTE_CONFIRM_SCRIPT,
  PASTE_SCRIPT_HANDLERS,
  parseKeystrokeMarker,
  PasteAfterKeystrokeError,
  pasteTranscript,
  runAtomicMacPaste,
  runJxa,
  SECURE_INPUT_PROBE_SCRIPT,
  type PasteDeps,
  type PasteTarget,
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
  return {
    deps,
    clipboard: () => clipboard,
    setClipboard: (value: unknown) => {
      clipboard = value;
    },
    pastedText: () => pastedText,
  };
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

/** Runs the shared paste handlers under osascript with a test-only run handler. */
async function runPasteHandlers(body: string, args: string[]) {
  const script = `${PASTE_SCRIPT_HANDLERS}\n\non run argv\n${body}\nend run`;
  return executeFile("/usr/bin/osascript", ["-e", script, "--", ...args]);
}

test(
  "the delivery verdict counts only new, case-exact copies of the transcript",
  { skip: process.platform !== "darwin" },
  async () => {
    const verdict = async (fieldValue: string, transcript: string, priorCount: number) =>
      (
        await runPasteHandlers(
          "return my deliveryVerdict(item 1 of argv, item 2 of argv, (item 3 of argv) as integer)",
          [fieldValue, transcript, String(priorCount)],
        )
      ).stdout.trim();
    // A Terminal or field that already said "yes" before ⌘V is not a delivery.
    assert.equal(await verdict("$ yes", "yes", 1), "unconfirmed");
    assert.equal(await verdict("yes and yes", "yes", 1), "confirmed");
    assert.equal(await verdict("first line", "first line", 0), "confirmed");
    assert.equal(await verdict("Hello World", "hello world", 0), "unconfirmed");
    assert.equal(await verdict("", "hello world", 0), "unconfirmed");
    // The paste replaced a selected copy: the count did not rise, so it stays unconfirmed.
    assert.equal(await verdict("hello world", "hello world", 1), "unconfirmed");
  },
);

test(
  "the keystroke marker the transaction logs carries the target pid and prior count",
  { skip: process.platform !== "darwin" },
  async () => {
    const marker = async (fieldValue: string | null) =>
      (
        await runPasteHandlers(
          `set originalCount to "unknown"
	if (count of argv) is 2 then set originalCount to my countOccurrences(item 2 of argv, item 1 of argv)
	log my keystrokeMarker(4242, originalCount)
	return "pasted"`,
          fieldValue === null ? ["yes"] : ["yes", fieldValue],
        )
      ).stderr;
    assert.deepEqual(parseKeystrokeMarker(await marker("yes, yes and Yes")), { pid: 4242, priorCount: 2 });
    assert.deepEqual(parseKeystrokeMarker(await marker("")), { pid: 4242, priorCount: 0 });
    assert.equal(parseKeystrokeMarker(await marker(null)), null, "an unreadable field can never be confirmed");
    assert.equal(parseKeystrokeMarker(`${KEYSTROKE_SENT_MARKER}\n`), null, "a marker without a target is unconfirmable");
  },
);

test(
  "the delivery check refuses a missing or unreadable target before asking System Events",
  { skip: process.platform !== "darwin" },
  async () => {
    const answer = async (args: string[]) =>
      (await executeFile("/usr/bin/osascript", ["-e", PASTE_CONFIRM_SCRIPT, "--", ...args], { timeout: 5_000 })).stdout.trim();
    assert.equal(await answer(["yes"]), "unconfirmed");
    assert.equal(await answer(["yes", "4242", "unknown"]), "unconfirmed");
    assert.equal(await answer(["yes", "0", "0"]), "unconfirmed");
  },
);

test(
  "native paste transaction and its delivery check are valid AppleScript",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aiden-dictation-script-"));
    try {
      for (const [name, script] of [["paste", ATOMIC_PASTE_SCRIPT], ["confirm", PASTE_CONFIRM_SCRIPT]]) {
        await executeFile("/usr/bin/osacompile", ["-o", path.join(directory, `${name}.scpt`), "-e", script]);
      }
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

function killedAfterKeystroke(overrides: Partial<PasteDeps>, marker = `${KEYSTROKE_SENT_MARKER} pid=4242 count=0`) {
  const timedOut = Object.assign(new Error("Command failed: osascript"), { killed: true, stderr: `${marker}\n` });
  const restores: string[] = [];
  const waits: number[] = [];
  let releaseWait!: () => void;
  const subject = harness({
    // Like the real transaction: the transcript goes on the clipboard, ⌘V is sent, then the timeout kills it.
    pasteWithPreservedClipboard: (text) =>
      runAtomicMacPaste(text, async () => {
        subject.setClipboard(text);
        throw timedOut;
      }),
    saveClipboard: (text) => () => restores.push(text),
    wait: (ms) =>
      new Promise<void>((resolve) => {
        waits.push(ms);
        releaseWait = resolve;
      }),
    ...overrides,
  });
  return { subject, restores, waits, releaseWait: () => releaseWait() };
}

test("a transaction killed after ⌘V restores the clipboard only once the targeted field shows the transcript", async () => {
  const checked: Array<{ text: string; target: PasteTarget }> = [];
  const killed = killedAfterKeystroke(
    {
      confirmDelivered: async (text, target) => {
        checked.push({ text, target });
        return true;
      },
    },
    `${KEYSTROKE_SENT_MARKER} pid=4242 count=1`,
  );
  const delivery = pasteTranscript("hello world", killed.subject.deps);
  await new Promise<void>((resolve) => setImmediate(resolve));
  // A queued ⌘V the app has not read yet must still find the transcript, not the previous clipboard.
  assert.deepEqual(killed.restores, [], "nothing is restored while the paste may still be landing");
  assert.deepEqual(checked, [], "the field is checked only after the wait");
  assert.deepEqual(killed.waits, [PASTE_CONFIRM_DELAY_MS]);
  killed.releaseWait();
  assert.deepEqual(await delivery, { outcome: "pasted" });
  assert.deepEqual(
    checked,
    [{ text: "hello world", target: { pid: 4242, priorCount: 1 } }],
    "the check reads the process the ⌘V targeted and compares against the count seen before it",
  );
  assert.deepEqual(killed.restores, ["hello world"]);
});

for (const [name, confirmDelivered] of [
  ["does not show a new copy of the transcript", async () => false],
  ["cannot be read", async () => Promise.reject(new Error("System Events timed out"))],
] as const) {
  test(`a transaction killed after ⌘V leaves the transcript on the clipboard when the field ${name}`, async () => {
    const killed = killedAfterKeystroke({ confirmDelivered });
    const delivery = pasteTranscript("hello world", killed.subject.deps);
    await new Promise<void>((resolve) => setImmediate(resolve));
    killed.releaseWait();
    assert.deepEqual(await delivery, {
      outcome: "copied",
      reason: "paste-unavailable",
      message: "Check the field — transcript copied.",
    });
    assert.deepEqual(killed.restores, [], "the previous clipboard, which a late ⌘V would paste, stays away");
    assert.equal(killed.subject.clipboard(), "hello world");
  });
}

for (const [name, marker] of [
  ["could not read the field before ⌘V", `${KEYSTROKE_SENT_MARKER} pid=4242 count=unknown`],
  ["did not say which process it pasted into", KEYSTROKE_SENT_MARKER],
] as const) {
  test(`a transaction killed after ⌘V that ${name} is never confirmed`, async () => {
    let checks = 0;
    const killed = killedAfterKeystroke(
      {
        confirmDelivered: async () => {
          checks += 1;
          return true;
        },
      },
      marker,
    );
    const result = await pasteTranscript("hello world", killed.subject.deps);
    assert.equal(result.outcome, "copied");
    assert.equal(checks, 0, "whatever is frontmost now is never read as proof of delivery");
    assert.deepEqual(killed.restores, []);
    assert.equal(killed.subject.clipboard(), "hello world");
  });
}

test("a copy the person makes while an unconfirmed paste is checked survives", async () => {
  const killed = killedAfterKeystroke({ confirmDelivered: async () => false });
  const delivery = pasteTranscript("hello world", killed.subject.deps);
  await new Promise<void>((resolve) => setImmediate(resolve));
  killed.subject.setClipboard("a link the person copied");
  killed.releaseWait();
  assert.equal((await delivery).outcome, "copied");
  assert.equal(killed.subject.clipboard(), "a link the person copied");
});

test("the delivery check sends the transcript and target as argv, confirms only on its answer, and never throws", async () => {
  const calls: string[][] = [];
  const answering = (answer: string) => async (_script: string, args: string[]) => {
    calls.push(args);
    return answer;
  };
  const target = { pid: 4242, priorCount: 2 };
  assert.equal(await confirmMacPasteDelivered("hello world", target, answering("confirmed")), true);
  assert.deepEqual(calls[0], ["hello world", "4242", "2"]);
  assert.equal(await confirmMacPasteDelivered("hello world", target, answering("unconfirmed")), false);
  assert.equal(await confirmMacPasteDelivered("hello world", target, answering("")), false);
  const timedOut = Object.assign(new Error("Command failed: osascript"), { killed: true });
  assert.equal(await confirmMacPasteDelivered("hello world", target, async () => Promise.reject(timedOut)), false);
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
