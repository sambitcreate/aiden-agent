import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { COMMANDS, type CommandId, type KeybindingMutation, type KeybindingSnapshot } from "../../shared/keybindings";
import { ShortcutSettings } from "./shortcut-settings";

afterEach(cleanup);

type Held = { mutation: KeybindingMutation; finish(): void; fail(): void };

function defaults(): KeybindingSnapshot {
  return {
    overrides: { version: 1, commands: {} },
    effective: Object.fromEntries(
      COMMANDS.map((command) => [command.id, command.defaultEnabled === false ? null : command.defaultBinding]),
    ) as Record<CommandId, string | null>,
    global: [],
  };
}

/** Main's shortcut store, with every save held open until the test finishes or fails it. */
async function mount() {
  let snapshot = defaults();
  const held: Held[] = [];
  installBotTestIpc({
    "shortcut:get": () => snapshot,
    "shortcut:set-recording": () => snapshot,
    "shortcut:set": (value: unknown) => {
      const mutation = value as KeybindingMutation;
      return new Promise((resolve, reject) => {
        held.push({
          mutation,
          finish() {
            const binding = "binding" in mutation ? mutation.binding : "disabled" in mutation && mutation.disabled ? null : snapshot.effective[mutation.commandId];
            snapshot = {
              ...snapshot,
              overrides: { version: 1, commands: { ...snapshot.overrides.commands, [mutation.commandId]: { binding } } },
              effective: { ...snapshot.effective, [mutation.commandId]: binding },
            };
            resolve(snapshot);
          },
          fail: () => reject(new Error("The shortcut could not be registered.")),
        });
      });
    },
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ShortcutSettings />
    </QueryClientProvider>,
  );
  await screen.findByRole("switch", { name: "Disable Focus composer" });
  return held;
}

test("a switch stays enabled and focused while its save runs; a second press then is ignored", async () => {
  const held = await mount();
  const toggle = screen.getByRole("switch", { name: "Disable Focus composer" });
  toggle.focus();
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(held.length, 1));
  assert.equal(toggle.hasAttribute("disabled"), false);
  assert.equal(document.activeElement, toggle);
  // Other rows stay usable too; their presses wait for nothing and are dropped while this one saves.
  assert.equal(screen.getByRole("switch", { name: "Disable Open Aiden" }).hasAttribute("disabled"), false);
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("switch", { name: "Disable Open Aiden" }));
  assert.equal(held.length, 1);

  await act(async () => held[0]!.finish());
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
  assert.equal(toggle.getAttribute("aria-label"), "Enable Focus composer");
  assert.equal(document.activeElement, toggle);
  assert.deepEqual(held.map((save) => save.mutation), [{ commandId: "composer.focus", disabled: true }]);
});

test("a failed save leaves the switch as it was and says why", async () => {
  const held = await mount();
  const toggle = screen.getByRole("switch", { name: "Disable Focus composer" });
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(held.length, 1));
  await act(async () => held[0]!.fail());
  await screen.findByText("The shortcut could not be registered.");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(toggle.hasAttribute("disabled"), false);
});

test("recording a shortcut keeps the recorder enabled and focused while it saves", async () => {
  const held = await mount();
  const recorder = screen.getByRole("button", { name: "Change shortcut for Focus composer" });
  const before = recorder.textContent;
  fireEvent.click(recorder);
  await screen.findByRole("button", { name: "Recording shortcut for Focus composer" });
  recorder.focus();
  fireEvent.keyDown(recorder, { key: "k", code: "KeyK", metaKey: true, ctrlKey: true, shiftKey: true });
  await waitFor(() => assert.equal(held.length, 1));
  assert.equal(recorder.hasAttribute("disabled"), false);
  assert.equal(document.activeElement, recorder);
  const recorded = held[0]!.mutation;
  assert.ok("binding" in recorded && recorded.commandId === "composer.focus");

  await act(async () => held[0]!.finish());
  await waitFor(() => assert.equal(recorder.getAttribute("aria-label"), "Change shortcut for Focus composer"));
  assert.notEqual(recorder.textContent, before, "the recorder shows the new shortcut");
  assert.equal(document.activeElement, recorder);
});
