import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TELEGRAM_ASSISTANT_ONLY_VALUE,
  telegramWorkspaceOptions,
} from "./telegram-workspace-options.js";

test("Telegram workspace options include assistant-only and configured folders", () => {
  assert.deepEqual(
    telegramWorkspaceOptions(
      [
        {
          id: "folder",
          name: "Aiden",
          folderPath: "/tmp/aiden",
          permission: "ask",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "scratch",
          name: "Scratch",
          permission: "ask",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      undefined,
    ),
    [
      { value: TELEGRAM_ASSISTANT_ONLY_VALUE, label: "Assistant-only mode" },
      { value: "folder", label: "Aiden — /tmp/aiden" },
    ],
  );
});

test("Telegram workspace options retain an unavailable saved selection", () => {
  assert.deepEqual(telegramWorkspaceOptions([], "missing"), [
    { value: TELEGRAM_ASSISTANT_ONLY_VALUE, label: "Assistant-only mode" },
    { value: "missing", label: "Selected workspace is unavailable", unavailable: true },
  ]);
});
