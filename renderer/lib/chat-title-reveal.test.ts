import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_TITLE_CHARACTER_DURATION_MS,
  CHAT_TITLE_FADE_OUT_MS,
  CHAT_TITLE_REVEAL_DURATION_MS,
  CHAT_TITLE_STAGGER_WINDOW_MS,
  createChatTitleReveal,
} from "./chat-title-reveal.js";

test("reveals generated titles character by character in source order", () => {
  const reveal = createChatTitleReveal("Fix sync");

  assert.equal(reveal.map(({ value }) => value).join(""), "Fix sync");
  assert.equal(reveal[0]?.delayMs, 0);
  for (let index = 1; index < reveal.length; index += 1) {
    assert.ok(reveal[index]!.delayMs > reveal[index - 1]!.delayMs);
  }
});

test("fades the old title for 200ms before a 500ms generated-title reveal", () => {
  const reveal = createChatTitleReveal("Investigate intermittent workspace reconnect failures");
  const finalDelay = reveal[reveal.length - 1]?.delayMs ?? 0;

  assert.equal(CHAT_TITLE_FADE_OUT_MS, 200);
  assert.equal(CHAT_TITLE_REVEAL_DURATION_MS, 500);
  assert.ok(finalDelay <= CHAT_TITLE_STAGGER_WINDOW_MS);
  assert.ok(finalDelay + CHAT_TITLE_CHARACTER_DURATION_MS <= CHAT_TITLE_REVEAL_DURATION_MS);
});

test("keeps a single character immediately visible after its short fade", () => {
  assert.deepEqual(createChatTitleReveal("A"), [{ value: "A", delayMs: 0 }]);
});
