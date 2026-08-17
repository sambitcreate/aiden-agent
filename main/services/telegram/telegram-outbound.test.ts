import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelegramButtonStore, markTelegramButtonSelected, planTelegramReply } from "./telegram-outbound.js";

test("plans assistant-authored Telegram buttons without leaking hidden markup", () => {
  let now = 1;
  const store = createTelegramButtonStore(() => now);
  const plan = planTelegramReply(
    'Choose.\n\n<!-- telegram_button: {"label":"Continue","prompt":"Keep going"} -->',
    store.register,
  );
  assert.equal(plan.markdown, "Choose.");
  assert.deepEqual(plan.attachments, []);
  const callback = plan.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
  assert.match(callback ?? "", /^tgbtn:/);
  assert.deepEqual(store.resolve(callback!), { label: "Continue", prompt: "Keep going" });
  assert.equal(store.resolve(callback!), undefined, "generated controls are single-use");
  now += 25 * 60 * 60 * 1_000;
  assert.equal(store.resolve(callback!), undefined);
});

test("plans explicit voice replies and selected button styles", () => {
  const plan = planTelegramReply(
    'Done.\n<!-- telegram_voice text="Your task is complete" lang="en" -->\n<!-- telegram_button label="Approve" prompt="Approve it" selected_style="success" -->',
    () => "tgbtn:1",
  );
  assert.deepEqual(plan.voices, [{ text: "Your task is complete", lang: "en" }]);
  const selected = markTelegramButtonSelected(plan.replyMarkup!, "tgbtn:1", "success");
  assert.equal(selected?.inline_keyboard[0]?.[0]?.style, "success");
});

test("plans workspace attachment actions without exposing local paths in text", () => {
  const plan = planTelegramReply(
    'Report ready.\n<!-- telegram_attach path="reports/final.pdf" caption="Final report" -->',
    () => "unused",
  );
  assert.equal(plan.markdown, "Report ready.");
  assert.deepEqual(plan.attachments, [{ path: "reports/final.pdf", caption: "Final report" }]);
});

test("button-only responses receive a visible fallback heading", () => {
  const plan = planTelegramReply(
    '<!-- telegram_button value="Done" -->',
    () => "tgbtn:1",
  );
  assert.equal(plan.markdown, "☑️ **Choose an option:**");
});
