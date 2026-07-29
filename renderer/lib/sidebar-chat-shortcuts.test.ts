import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_CHAT_SHORTCUT_LIMIT,
  COMMAND_CHAT_SHORTCUT_REVEAL_MS,
  commandChatShortcutNumber,
  chatShortcutRevealModifierSets,
  createSidebarChatShortcutAssignments,
  sidebarChatNavigationTargets,
} from "./sidebar-chat-shortcuts.js";

test("assigns Command digits from the canonical sidebar order without sorting", () => {
  const assignments = createSidebarChatShortcutAssignments([
    {
      chats: [
        { id: "pinned", updatedAt: 1 },
        { id: "custom-first", updatedAt: 10 },
      ],
    },
    { chats: [{ id: "custom-second", updatedAt: 100 }] },
  ]);

  assert.deepEqual(
    assignments.map(({ chat, number }) => ({ id: chat.id, number })),
    [
      { id: "pinned", number: 1 },
      { id: "custom-first", number: 2 },
      { id: "custom-second", number: 3 },
    ],
  );
});

test("caps shortcut assignments at nine ordered chats", () => {
  const chats = Array.from({ length: 12 }, (_, index) => ({ id: `chat-${index + 1}` }));
  const assignments = createSidebarChatShortcutAssignments([{ chats }]);

  assert.equal(assignments.length, COMMAND_CHAT_SHORTCUT_LIMIT);
  assert.equal(assignments[0]?.chat.id, "chat-1");
  assert.equal(assignments[8]?.chat.id, "chat-9");
});

test("previous and next chat commands exist only when they have a target", () => {
  const chats = [{ id: "first" }, { id: "second" }, { id: "third" }];

  assert.deepEqual(sidebarChatNavigationTargets(chats, "first"), {
    previous: null,
    next: chats[1],
  });
  assert.deepEqual(sidebarChatNavigationTargets(chats, "second"), {
    previous: chats[0],
    next: chats[2],
  });
  assert.deepEqual(sidebarChatNavigationTargets(chats, "third"), {
    previous: chats[1],
    next: null,
  });
  assert.deepEqual(sidebarChatNavigationTargets(chats.slice(0, 1), "first"), {
    previous: null,
    next: null,
  });
});

test("accepts only exact non-repeating Command digits one through nine", () => {
  const base = {
    key: "4",
    metaKey: true,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
  };

  assert.equal(commandChatShortcutNumber(base), 4);
  assert.equal(commandChatShortcutNumber({ ...base, key: "0" }), null);
  assert.equal(commandChatShortcutNumber({ ...base, key: "a" }), null);
  assert.equal(commandChatShortcutNumber({ ...base, metaKey: false }), null);
  assert.equal(commandChatShortcutNumber({ ...base, altKey: true }), null);
  assert.equal(commandChatShortcutNumber({ ...base, ctrlKey: true }), null);
  assert.equal(commandChatShortcutNumber({ ...base, shiftKey: true }), null);
  assert.equal(commandChatShortcutNumber({ ...base, repeat: true }), null);
  assert.equal(commandChatShortcutNumber({ ...base, isComposing: true }), null);
});

test("uses the requested half-second shortcut hint delay", () => {
  assert.equal(COMMAND_CHAT_SHORTCUT_REVEAL_MS, 500);
});

test("derives hint reveal modifiers from customized chat bindings", () => {
  assert.deepEqual(
    chatShortcutRevealModifierSets([
      "Control+1",
      "Alt+2",
      "Command+Shift+3",
      null,
    ]),
    [["Control"], ["Alt"], ["Meta", "Shift"]],
  );
});
