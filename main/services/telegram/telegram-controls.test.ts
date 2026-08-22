import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TELEGRAM_COMMANDS,
  buildMainMenu,
  buildModelMenu,
  buildQueueItemMenu,
  buildQueueMenu,
  buildSettingsMenu,
  buildThinkingMenu,
  commandArgument,
  commandName,
  visibleTelegramModelChoices,
} from "./telegram-controls.js";

test("Telegram model choices omit hidden models without invalidating explicit execution state", () => {
  const choices = [
    { providerId: "google", providerLabel: "Google", model: "pro", reasoning: true },
    { providerId: "google", providerLabel: "Google", model: "flash", reasoning: false },
  ];
  assert.deepEqual(
    visibleTelegramModelChoices(choices, { google: ["pro"] }).map((choice) => choice.model),
    ["flash"],
  );
  assert.equal(choices[0]?.model, "pro");
});

test("command catalog exposes the first-class operator controls", () => {
  assert.deepEqual(
    TELEGRAM_COMMANDS.slice(0, 6).map((command) => command.command),
    ["start", "compact", "next", "continue", "abort", "stop"],
  );
  assert.equal(commandName("/MODEL@aiden_bot 2"), "/model");
  assert.equal(commandArgument("/workspace Aiden  Agent"), "Aiden  Agent");
});

test("main menu projects model, thinking, queue, workspace, and active controls", () => {
  const menu = buildMainMenu({
    botUsername: "aiden_bot",
    providerId: "openai-codex",
    providerLabel: "ChatGPT / Codex",
    model: "gpt-5.4",
    thinkingLevel: "high",
    queueCount: 2,
    active: true,
    workspaceLabel: "Aiden",
  });
  const callbacks = menu.inline_keyboard.flat().map((button) => button.callback_data);
  for (const expected of [
    "menu:model",
    "menu:thinking",
    "menu:queue",
    "menu:workspace",
    "turn:abort",
  ]) {
    assert.ok(callbacks.includes(expected));
  }
});

test("model, thinking, and queue menus carry short callback identities", () => {
  const model = buildModelMenu(
    [{ providerId: "p", providerLabel: "Provider", model: "m", reasoning: true }],
    "p",
    "m",
    0,
  );
  assert.equal(
    model.markup.inline_keyboard[model.markup.inline_keyboard.length - 1]?.[0]?.callback_data,
    "model:set:0",
  );

  const thinking = buildThinkingMenu("medium", ["off", "medium", "high"]);
  assert.equal(
    thinking.markup.inline_keyboard[thinking.markup.inline_keyboard.length - 1]?.[0]?.callback_data,
    "thinking:set:high",
  );

  const item = { id: 9, lane: "default" as const, text: "Review this", chatId: 1, ownerUserId: 2 };
  assert.equal(
    buildQueueMenu([item]).markup.inline_keyboard[2]?.[0]?.callback_data,
    "queue:item:9",
  );
  assert.equal(
    buildQueueItemMenu(item).markup.inline_keyboard[1]?.[1]?.callback_data,
    "queue:delete:9",
  );
});

test("Telegram settings expose native rendering and voice policy controls", () => {
  const menu = buildSettingsMenu({ rendering: "rich", voiceMode: "mirror" });
  const callbacks = menu.markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("settings:rendering:toggle"));
  assert.ok(callbacks.includes("settings:voice:next"));
});
