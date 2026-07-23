import assert from "node:assert/strict";
import test from "node:test";
import {
  DictationOperationGate,
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
