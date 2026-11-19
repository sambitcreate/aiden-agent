import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createTelegramButtonStore, markTelegramButtonSelected, planTelegramReply } from "./telegram-outbound.js";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

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

test("button tokens are non-reused across restarts and scoped to their originating route and binding", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aiden-tg-buttons-"));
  tempDirs.push(dir);
  const file = path.join(dir, "buttons.json");
  let now = 1_000;
  const first = createTelegramButtonStore(() => now, { file });
  const scopeA = { profile: "work", chatId: 100, threadId: 5, ownerUserId: 42, bindingKey: "work:100:5:42:bot-a:w:bw:bc" };
  const token1 = first.register({ label: "Approve", prompt: "Approve deployment", selectedStyle: "success" }, scopeA);
  first.bindMessage([token1], 88);
  await first.flush();

  const second = createTelegramButtonStore(() => now);
  const token2 = second.register({ label: "Other", prompt: "Other" }, scopeA);
  assert.notEqual(token1, token2, "a fresh store does not mint predictable colliding tokens");

  assert.equal(
    await first.prepareCallback("cb-wrong-thread", token1, { ...scopeA, threadId: 6, messageId: 88 }),
    undefined,
    "wrong thread fails closed without consuming the button",
  );
  assert.equal(
    await first.prepareCallback("cb-rebound", token1, { ...scopeA, bindingKey: "work:100:5:42:bot-b:w:bw:bc2", messageId: 88 }),
    undefined,
    "rebound Bot route fails closed without consuming the button",
  );
  assert.equal(
    await first.prepareCallback("cb-wrong-msg", token1, { ...scopeA, messageId: 89 }),
    undefined,
    "different source message fails closed without consuming the button",
  );

  // Stage callback receipt before admission; simulate restart before completion.
  const staged = await first.prepareCallback("cb-valid", token1, { ...scopeA, messageId: 88 });
  assert.deepEqual(staged, {
    action: { label: "Approve", prompt: "Approve deployment", selectedStyle: "success" },
    alreadyCompleted: false,
  });

  const restarted = createTelegramButtonStore(() => now, { file });
  const replayed = await restarted.prepareCallback("cb-valid", token1, { ...scopeA, messageId: 88 });
  assert.deepEqual(replayed, {
    action: { label: "Approve", prompt: "Approve deployment", selectedStyle: "success" },
    alreadyCompleted: false,
  });

  await restarted.completeCallback("cb-valid", token1);
  // Same callbackQueryId replaying after offset persistence failure still sees its completed receipt.
  const duplicateDelivery = await restarted.prepareCallback("cb-valid", token1, { ...scopeA, messageId: 88 });
  assert.deepEqual(duplicateDelivery, {
    action: { label: "Approve", prompt: "Approve deployment", selectedStyle: "success" },
    alreadyCompleted: true,
  });
  // A second distinct tap of the consumed button expires cleanly.
  assert.equal(
    await restarted.prepareCallback("cb-second-tap", token1, { ...scopeA, messageId: 88 }),
    undefined,
  );
});
