// Installs happy-dom and the fake IPC bridge; must stay the first import.
import {
  emitBotTestNotification,
  installBotTestIpc,
  type BotTestIpcCall,
} from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBotTestQueryClient, mountWithBotRouter } from "../main/bots/test-providers";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";
import { ShortcutSettings } from "./settings/shortcut-settings";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider, useCommandHandler, useCommandSystem } from "../lib/command-system";
import { applyKeybindingMutation, effectiveBindings, type CommandId } from "../shared/keybindings";

let calls: BotTestIpcCall[] = [];

function install(
  overrides = applyKeybindingMutation(undefined, {
    commandId: "chat.find",
    binding: "Command+Shift+G",
  }),
) {
  calls = installBotTestIpc({
    "shortcut:get": () => ({ overrides, effective: effectiveBindings(overrides), global: [] }),
    "shortcut:setRecording": () => ({
      overrides,
      effective: effectiveBindings(overrides),
      global: [],
    }),
    "app:setMenuCommands": () => true,
  });
}

beforeEach(() => install());
afterEach(cleanup);

let run: (commandId: CommandId) => boolean = () => false;
function Commands() {
  run = useCommandSystem().execute;
  return null;
}

test("⌘/ lists every key as set in Settings, with the built-in ones, and search narrows it", async () => {
  await mountWithBotRouter(null, {
    initialPath: "/",
    sidebar: (
      <TooltipProvider>
        <Commands />
        <KeyboardShortcutsDialog />
      </TooltipProvider>
    ),
  });
  await waitFor(() => assert.equal(run("shortcuts.show"), true));
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  const find = within(dialog).getByText("Find in chat").closest("li")!;
  // The key someone set in Settings, not the default ⌘F.
  assert.match(find.textContent ?? "", /Shift\+G|⇧G/u);
  assert.ok(within(dialog).getByText("Next / previous area"), "a built-in key");
  assert.ok(within(dialog).getByRole("heading", { name: "In a chat" }));

  const search = within(dialog).getByRole("searchbox", { name: "Search keyboard shortcuts" });
  assert.equal(document.activeElement, search, "ready to type");
  fireEvent.change(search, { target: { value: "F6" } });
  assert.deepEqual(
    within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.querySelector("p")?.textContent),
    ["Next / previous area"],
  );
  fireEvent.change(search, { target: { value: "nothing like this" } });
  assert.match(within(dialog).getByRole("status").textContent ?? "", /No keys match/u);
});

test("Esc closes the list and gives focus back to the message box", async () => {
  await mountWithBotRouter(<textarea aria-label="Message" />, {
    initialPath: "/",
    sidebar: (
      <TooltipProvider>
        <Commands />
        <KeyboardShortcutsDialog />
      </TooltipProvider>
    ),
  });
  const message = await screen.findByRole("textbox", { name: "Message" });
  message.focus();
  await waitFor(() => assert.equal(run("shortcuts.show"), true));
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  fireEvent.keyDown(within(dialog).getByRole("searchbox", { name: "Search keyboard shortcuts" }), {
    key: "Escape",
  });
  await waitFor(() =>
    assert.ok(!screen.queryByRole("dialog", { name: "Keyboard shortcuts" }), "closed"),
  );
  assert.ok(document.activeElement === message, `focus is on ${document.activeElement?.tagName}`);
});

test("Change keys… goes to Settings → Keyboard shortcuts", async () => {
  const { router } = await mountWithBotRouter(null, {
    initialPath: "/",
    sidebar: (
      <TooltipProvider>
        <Commands />
        <KeyboardShortcutsDialog />
      </TooltipProvider>
    ),
  });
  await waitFor(() => assert.equal(run("shortcuts.show"), true));
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  await act(async () => {
    within(dialog).getByRole("button", { name: "Change keys…" }).click();
  });
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.deepEqual({ ...router.state.location.search }, { section: "shortcut" });
  assert.equal(screen.queryByRole("dialog", { name: "Keyboard shortcuts" }), null);
});

test("Settings lists the built-in keys below the ones you can change, and its search finds them", async () => {
  const queryClient = createBotTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ShortcutSettings />
    </QueryClientProvider>,
  );
  const builtIn = await screen.findByRole("heading", { name: "Built-in keys" });
  const group = builtIn.closest("section")!;
  assert.ok(within(group).getByText("Allow once"));
  assert.ok(within(group).getByText("Next / previous area"));
  assert.match(group.textContent ?? "", /lists every key at once/u, "points to the ⌘/ list");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search keyboard shortcuts" }), {
    target: { value: "approval" },
  });
  assert.ok(
    within(screen.getByRole("heading", { name: "Built-in keys" }).closest("section")!).getByText(
      "Allow once",
    ),
  );
  assert.equal(screen.queryByText("Next / previous area"), null);
  queryClient.clear();
});

function Handler({ commandId, onRun }: { commandId: CommandId; onRun: () => void }) {
  useCommandHandler(commandId, onRun);
  return null;
}

function menuCommandsSent(): string[] | undefined {
  const sent = calls.filter((call) => call.channel === "app:setMenuCommands");
  return sent[sent.length - 1]?.args[0] as string[] | undefined;
}

test("the menu bar learns which commands can run now, and a menu key the page saw isn't run twice", async () => {
  const queryClient = createBotTestQueryClient();
  let found = 0;
  const app = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <CommandSystemProvider>
        {open ? <Handler commandId="chat.find" onRun={() => (found += 1)} /> : null}
        <textarea aria-label="Message" />
        <div data-command-scope="terminal" tabIndex={0} aria-label="Terminal" />
      </CommandSystemProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(app(true));
  await waitFor(() => assert.ok(menuCommandsSent()?.includes("chat.find")));
  rerender(app(false));
  await waitFor(() =>
    assert.equal(
      menuCommandsSent()?.includes("chat.find"),
      false,
      "greyed out once no chat can run it",
    ),
  );
  rerender(app(true));
  await waitFor(() => assert.ok(menuCommandsSent()?.includes("chat.find")));

  // A click on the menu item runs it.
  emitBotTestNotification("app:command", { commandId: "chat.find", source: "menu" });
  assert.equal(found, 1);
  // The terminal keeps Ctrl+Shift+G, so the page leaves it; the menu's copy of
  // that same press must not run it behind the terminal's back.
  const terminal = screen.getByLabelText("Terminal");
  fireEvent.keyDown(terminal, { key: "G", code: "KeyG", ctrlKey: true, shiftKey: true });
  emitBotTestNotification("app:command", { commandId: "chat.find", source: "menu-key" });
  assert.equal(found, 1);
  // A key press the page never saw (a different key last) is the menu's to run.
  fireEvent.keyDown(terminal, { key: "a", code: "KeyA" });
  emitBotTestNotification("app:command", { commandId: "chat.find", source: "menu-key" });
  assert.equal(found, 2);
  queryClient.clear();
});
