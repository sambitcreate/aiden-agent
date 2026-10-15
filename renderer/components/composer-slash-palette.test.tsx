// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import type { Chat } from "../lib/types";

// Boolean oracles throughout: a failing assert on a happy-dom node would
// util.inspect the whole DOM graph.

let queryClient: QueryClient;
let sends: string[];

beforeEach(() => {
  localStorage.clear();
  sends = [];
  installBotTestIpc({
    "pullRequests:list": () => [],
    "pullRequests:current": () => null,
    "pullRequests:pending": () => [],
    "settings:get": () => null,
    "shortcut:get": () => null,
    "app:renderer-ready": () => null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

const SESSION_CHAT = {
  id: "chat-1",
  title: "Plan the trip",
  messages: [],
  createdAt: 1,
  updatedAt: 1,
} as unknown as Chat;

function ComposerHarness({ slashPaletteBlocked = false }: { slashPaletteBlocked?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <Composer
            ready
            hasMessages={false}
            chatId="chat-1"
            sessionChat={SESSION_CHAT}
            onRenameChat={() => undefined}
            slashPaletteBlocked={slashPaletteBlocked}
            onSend={async (text) => {
              sends.push(text);
            }}
            onStop={() => undefined}
            isGenerating={false}
          />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

async function mountComposer() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ComposerHarness />);
  });
  return { view, textbox: screen.getByRole("textbox") as HTMLTextAreaElement };
}

async function type(textbox: HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.change(textbox, { target: { value } });
  });
}

async function press(textbox: HTMLTextAreaElement, key: string) {
  await act(async () => {
    fireEvent.keyDown(textbox, { key });
  });
}

function palette() {
  return screen.queryByRole("listbox", { name: "Slash commands" });
}

/** Options a keyboard user can land on, in on-screen order. */
function selectableOptionIds(): string[] {
  return screen
    .getAllByRole("option")
    .filter((option) => option.getAttribute("aria-disabled") !== "true")
    .map((option) => option.id);
}

function selectedOptionIds(): string[] {
  return screen
    .getAllByRole("option")
    .filter((option) => option.getAttribute("aria-selected") === "true")
    .map((option) => option.id);
}

function assertActiveOption(textbox: HTMLTextAreaElement, expectedId: string) {
  const active = textbox.getAttribute("aria-activedescendant");
  assert.ok(active === expectedId, `textarea points at ${active}, expected ${expectedId}`);
  assert.deepEqual(selectedOptionIds(), [expectedId]);
}

test('typing "/" opens a textarea-owned listbox with the first available command active', async () => {
  const { textbox } = await mountComposer();
  assert.ok(palette() === null);
  assert.ok(textbox.getAttribute("aria-autocomplete") === null);

  await type(textbox, "/");

  assert.ok(palette() !== null, "the slash palette opens");
  assert.ok(textbox.getAttribute("aria-autocomplete") === "list");
  const selectable = selectableOptionIds();
  assert.ok(selectable.length >= 3, "the fixture offers several available commands");
  // Unavailable commands are listed but never become the active option.
  assert.ok(screen.getAllByRole("option").length > selectable.length);
  assertActiveOption(textbox, selectable[0]!);
});

test("ArrowDown and ArrowUp move the active option across available commands and wrap", async () => {
  const { textbox } = await mountComposer();
  await type(textbox, "/");
  const selectable = selectableOptionIds();

  await press(textbox, "ArrowDown");
  assertActiveOption(textbox, selectable[1]!);
  await press(textbox, "ArrowDown");
  assertActiveOption(textbox, selectable[2]!);
  await press(textbox, "ArrowUp");
  assertActiveOption(textbox, selectable[1]!);
  await press(textbox, "ArrowUp");
  assertActiveOption(textbox, selectable[0]!);
  await press(textbox, "ArrowUp");
  assertActiveOption(textbox, selectable[selectable.length - 1]!);
  await press(textbox, "ArrowDown");
  assertActiveOption(textbox, selectable[0]!);

  assert.ok(textbox.value === "/", "arrow keys never edit the draft");
});

test("Home and End jump to the first and last available commands", async () => {
  const { textbox } = await mountComposer();
  await type(textbox, "/");
  const selectable = selectableOptionIds();

  await press(textbox, "End");
  assertActiveOption(textbox, selectable[selectable.length - 1]!);
  await press(textbox, "Home");
  assertActiveOption(textbox, selectable[0]!);
});

test("Enter on a command that takes text inserts it and closes the palette without sending", async () => {
  const { textbox } = await mountComposer();
  await type(textbox, "/renam");
  assert.ok(palette() !== null);
  const active = screen
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-selected") === "true");
  assert.ok(active?.textContent?.includes("Rename chat"), "the query narrows to Rename chat");

  await press(textbox, "Enter");

  assert.ok(textbox.value === "/name ", `draft became ${JSON.stringify(textbox.value)}`);
  assert.ok(palette() === null, "the palette closes after a pick");
  assert.ok(textbox.getAttribute("aria-activedescendant") === null);
  assert.deepEqual(sends, []);
});

test("Escape closes the palette and keeps the typed draft", async () => {
  const { textbox } = await mountComposer();
  await type(textbox, "/");
  assert.ok(palette() !== null);

  await press(textbox, "Escape");

  assert.ok(palette() === null, "Escape dismisses the palette");
  assert.ok(textbox.getAttribute("aria-autocomplete") === null);
  assert.ok(textbox.getAttribute("aria-activedescendant") === null);
  assert.ok(textbox.value === "/");
  assert.deepEqual(sends, []);
});

test("a blocked slash palette closes while the draft stays", async () => {
  const { view, textbox } = await mountComposer();
  await type(textbox, "/");
  assert.ok(palette() !== null);

  await act(async () => {
    view.rerender(<ComposerHarness slashPaletteBlocked />);
  });

  assert.ok(palette() === null);
  assert.ok(textbox.value === "/");
});
