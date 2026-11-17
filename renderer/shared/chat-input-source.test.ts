import assert from "node:assert/strict";
import test from "node:test";
import { parseChatInputSource, parseChatInputSourceStrict } from "./chat-input-source";
import { parseChatRunInput } from "./chat-run-input";

test("only the voice marker is kept; stored or wire values it does not know read as typed", () => {
  assert.equal(parseChatInputSource("voice"), "voice");
  for (const value of [undefined, null, "", "Voice", "dictation", 1, { kind: "voice" }]) {
    assert.equal(parseChatInputSource(value), undefined, String(value));
  }
});

test("an IPC envelope may omit the marker but never send another value", () => {
  assert.equal(parseChatInputSourceStrict(undefined), undefined);
  assert.equal(parseChatInputSourceStrict("voice"), "voice");
  assert.throws(() => parseChatInputSourceStrict("dictation"), /Invalid input source/u);
  assert.throws(() => parseChatInputSourceStrict(null), /Invalid input source/u);
});

test("desktop run input carries the voice marker for Live's steer and refuses other values", () => {
  assert.deepEqual(parseChatRunInput({ mode: "steer", text: "Use staging" }), { mode: "steer", text: "Use staging" });
  assert.deepEqual(parseChatRunInput({ mode: "steer", text: "Use staging", inputSource: "voice" }), {
    mode: "steer",
    text: "Use staging",
    inputSource: "voice",
  });
  assert.throws(() => parseChatRunInput({ mode: "steer", text: "Hi", inputSource: "phone" }), /Invalid chat run input/u);
  assert.throws(() => parseChatRunInput({ mode: "steer", text: "Hi", source: "voice" }), /Invalid chat run input/u);
});
