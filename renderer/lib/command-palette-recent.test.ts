import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_PALETTE_RECENT_LIMIT,
  normalizeRecentCommands,
  persistRecentCommands,
  recordRecentCommand,
} from "./command-palette-recent";

test("recent palette history keeps only unique command ids and no user text", () => {
  assert.deepEqual(
    normalizeRecentCommands([
      "chat.new",
      "not-a-command",
      "settings.open",
      "chat.new",
      { query: "private workspace name" },
    ]),
    ["chat.new", "settings.open"],
  );
});

test("recording promotes a command and caps local history", () => {
  let recent = normalizeRecentCommands([
    "chat.new",
    "settings.open",
    "terminal.toggle",
  ]);
  recent = recordRecentCommand(recent, "settings.open");
  assert.deepEqual(recent.slice(0, 3), [
    "settings.open",
    "chat.new",
    "terminal.toggle",
  ]);

  for (let index = 1; index <= 9; index += 1) {
    recent = recordRecentCommand(recent, `chat.jump.${index}` as never);
  }
  assert.ok(recent.length <= COMMAND_PALETTE_RECENT_LIMIT);
});

test("unavailable local storage cannot block a palette command", () => {
  assert.doesNotThrow(() => {
    persistRecentCommands(
      {
        setItem() {
          throw new DOMException("Storage is full", "QuotaExceededError");
        },
      },
      ["settings.open"],
    );
  });
});
