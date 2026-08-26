import assert from "node:assert/strict";
import test from "node:test";
import {
  DictationOperationGate,
  DictationDeadline,
  recoverCommittedLiveTranscript,
  transcriptionBudgetMs,
  voiceErrorMessage,
  withDictationTimeout,
} from "./dictation-operation-gate.js";

test("duplicate starts are rejected while microphone permission is pending", () => {
  const gate = new DictationOperationGate();
  const first = gate.beginStart();
  assert.equal(typeof first, "number");
  assert.equal(gate.beginStart(), null);
  gate.finishStart(first!);
  assert.equal(typeof gate.beginStart(), "number");
});

test("cancel invalidates a pending microphone start and any late completion", () => {
  const gate = new DictationOperationGate();
  const token = gate.beginStart()!;
  gate.cancel();
  assert.equal(gate.isCurrent(token), false);
  assert.equal(typeof gate.beginStart(), "number");
});

test("transcription timeout recovers instead of waiting forever", async () => {
  await assert.rejects(
    withDictationTimeout(new Promise<string>(() => {}), 1),
    /Transcription timed out/,
  );
});

test("one deadline budget is shared across sequential attempts", async () => {
  let now = 100;
  const deadline = new DictationDeadline(50, () => now);
  assert.equal(await deadline.run(Promise.resolve("live")), "live");
  now = 149;
  assert.equal(deadline.remaining(), 1);
  now = 151;
  await assert.rejects(deadline.run(Promise.resolve("late")), /took too long/u);
});

test("on-device transcription keeps headroom around Parakeet's process deadline", () => {
  assert.equal(transcriptionBudgetMs("gemini"), 45_000);
  assert.equal(transcriptionBudgetMs("openai"), 45_000);
  assert.equal(transcriptionBudgetMs("local"), 125_000);
});

test("a stuck cancellation request cannot extend the transcription deadline", async () => {
  const deadline = new DictationDeadline(1);
  await assert.rejects(
    deadline.run(new Promise<string>(() => {}), () => new Promise<void>(() => {})),
    /took too long/u,
  );
});

test("an already-expired deadline does not await a stuck cancellation request", async () => {
  let now = 10;
  const deadline = new DictationDeadline(1, () => now);
  now = 12;
  await assert.rejects(
    deadline.run(Promise.resolve("late"), () => new Promise<void>(() => {})),
    /took too long/u,
  );
});

test("voice errors hide Electron wrappers and provide actionable setup copy", () => {
  assert.equal(
    voiceErrorMessage(
      new Error(
        "Error invoking remote method 'voice:streamStart': Error: Set up Google Gemini in Settings → Providers to use voice input.",
      ),
    ),
    "Gemini needs an API key. Add it in Settings → Providers, then try again.",
  );
  assert.equal(
    voiceErrorMessage(new Error("Gemini Live transcription timed out while finalizing.")),
    "Transcription took too long. Try again with a shorter recording.",
  );
});

test("committed live text survives an empty or failed final handshake", () => {
  assert.equal(recoverCommittedLiveTranscript("", " already visible "), "already visible");
  assert.equal(recoverCommittedLiveTranscript(" final ", "older"), "final");
});
