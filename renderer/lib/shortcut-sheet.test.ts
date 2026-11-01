import assert from "node:assert/strict";
import test from "node:test";
import { applyKeybindingMutation, effectiveBindings, type CommandId } from "../shared/keybindings";
import { shortcutSheet, type ShortcutSheetSection } from "./shortcut-sheet";

const defaults = () => effectiveBindings(undefined);

function row(sections: ShortcutSheetSection[], title: string) {
  for (const section of sections) {
    const found = section.rows.find((entry) => entry.title === title);
    if (found) return { section: section.title, ...found };
  }
  return null;
}

test("the list groups keys as set, with ⌘1–⌘9 as one row and the built-in keys beside them", () => {
  const sections = shortcutSheet(defaults(), { platform: "darwin" });
  assert.deepEqual(
    sections.map((section) => section.title),
    ["General", "Moving around", "In a chat", "Workspace"],
  );
  assert.deepEqual(row(sections, "Find in chat"), {
    section: "In a chat",
    id: "chat.find",
    title: "Find in chat",
    keys: ["Command+F"],
  });
  const jump = row(sections, "Open a chat by its number");
  assert.equal(jump?.range, true);
  assert.deepEqual(jump?.keys, ["Command+1", "Command+9"]);
  assert.equal(row(sections, "Open chat 3"), null, "not nine separate rows");
  assert.equal(row(sections, "Next / previous area")?.section, "Moving around");
  assert.equal(row(sections, "Allow once")?.section, "In a chat");
  // Commands without a key aren't listed.
  assert.equal(row(sections, "Rename chat…"), null);
});

test("a changed key shows as changed, and a custom key for a number breaks the run into rows", () => {
  let overrides = applyKeybindingMutation(undefined, {
    commandId: "chat.find",
    binding: "Command+Shift+G",
  });
  overrides = applyKeybindingMutation(overrides, {
    commandId: "chat.jump.2",
    binding: "Command+Alt+2",
  });
  overrides = applyKeybindingMutation(overrides, { commandId: "chat.stop", disabled: true });
  const sections = shortcutSheet(effectiveBindings(overrides), { platform: "darwin" });
  assert.deepEqual(row(sections, "Find in chat")?.keys, ["Command+Shift+G"]);
  assert.equal(row(sections, "Stop reply"), null, "turned off");
  assert.equal(row(sections, "Open a chat by its number"), null);
  assert.deepEqual(row(sections, "Open chat 2"), {
    section: "Moving around",
    id: "chat.jump.2",
    title: "Open chat 2",
    keys: ["Command+Alt+2"],
  });
  assert.deepEqual(row(sections, "Open chat 9")?.keys, ["Command+9"]);
});

test("a key given to a Studio command shows only while that Studio is on", () => {
  const bindings = { ...defaults(), "images.open": "Command+Alt+I" } as Record<
    CommandId,
    string | null
  >;
  assert.equal(row(shortcutSheet(bindings, { platform: "darwin" }), "Open Create Images"), null);
  assert.equal(
    row(
      shortcutSheet(bindings, { platform: "darwin", capabilities: { createImages: true } }),
      "Open Create Images",
    )?.section,
    "Moving around",
  );
});

test("⌘⇧L lists Toggle design mode only while design mode is available", () => {
  assert.equal(row(shortcutSheet(defaults(), { platform: "darwin" }), "Toggle design mode"), null);
  const on = row(shortcutSheet(defaults(), { platform: "darwin", capabilities: { designMode: true } }), "Toggle design mode");
  assert.deepEqual(on?.keys, ["Command+Shift+L"]);
  assert.equal(on?.section, "Workspace");
});

test("⌘⇧D is not bound to anything", () => {
  const sections = shortcutSheet(defaults(), { platform: "darwin", capabilities: { createImages: true } });
  const keys = sections.flatMap((section) =>
    section.rows.flatMap((entry) => [...entry.keys, ...(entry.alsoKeys ?? [])]),
  );
  assert.ok(keys.length > 0);
  assert.equal(keys.includes("Command+Shift+D"), false);
  assert.ok(
    Object.values(defaults()).every((binding) => binding !== "Command+Shift+D"),
    "no command reserves it either",
  );
});

test("searching matches titles, conditions and the keys as shown on this computer", () => {
  const titles = (query: string, platform: "darwin" | "linux" = "darwin") =>
    shortcutSheet(defaults(), { platform, query }).flatMap((section) =>
      section.rows.map((entry) => entry.title),
    );
  assert.deepEqual(titles("F6"), ["Next / previous area"]);
  assert.ok(titles("⌘F").includes("Find in chat"));
  assert.ok(titles("ctrl+f", "linux").includes("Find in chat"));
  assert.deepEqual(titles("approval"), ["Allow once", "Deny"], "words from when a key applies");
  assert.ok(titles("⌘G").includes("Next / previous match"), "the other way to do it");
  assert.deepEqual(shortcutSheet(defaults(), { platform: "darwin", query: "zzz" }), []);
});
