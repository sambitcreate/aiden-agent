import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { focusRegionWhenShown, useFocusRegionKeys } from "./focus-regions";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider, useCommandHandler, useShortcutBinding } from "./command-system";
import { applyKeybindingMutation, effectiveBindings } from "../shared/keybindings";

afterEach(cleanup);

function Keys() {
  useFocusRegionKeys();
  return null;
}

/** The window's areas as the app marks them, with two replies in the conversation. */
function Window({
  panel = "open",
  draft = "",
  menuOpen = false,
}: {
  panel?: "open" | "closed";
  draft?: string;
  menuOpen?: boolean;
}) {
  return (
    <>
      <Keys />
      <button type="button">Title bar</button>
      <aside data-focus-region="sidebar">
        <button type="button">New chat</button>
        {/* Rows are tooltip triggers, which say data-state="closed". */}
        <button type="button" data-roving-item aria-current="page" data-state="closed">
          Open chat
        </button>
        <button type="button" data-roving-item tabIndex={-1}>
          Other chat
        </button>
      </aside>
      <div data-focus-region="chat" data-focus-region-entry tabIndex={-1} aria-label="Conversation" role="region">
        <div data-transcript-reply>
          <p>First answer</p>
          <div data-message-actions>
            <button type="button">Copy first</button>
          </div>
        </div>
        <p>A question</p>
        <div data-transcript-reply>
          <p>Second answer</p>
          <div data-message-actions>
            <button type="button">Copy second</button>
          </div>
        </div>
      </div>
      <div data-focus-region="composer">
        <button type="button">Attach</button>
        <textarea aria-label="Message" data-message-draft="" data-focus-region-entry defaultValue={draft} />
      </div>
      <aside data-focus-region="panel" data-state={panel}>
        <div role="separator" tabIndex={0} aria-label="Resize" />
        <button type="button" role="tab" aria-selected="false">
          Files
        </button>
        <button type="button" role="tab" aria-selected="true">
          Changes
        </button>
      </aside>
      {menuOpen ? (
        <div role="menu" data-state="open">
          <button type="button" role="menuitem">
            Rename
          </button>
        </div>
      ) : null}
    </>
  );
}

const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent;
const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

test("F6 visits the sidebar's open chat, the conversation, the message box and the panel's tab, then wraps", () => {
  render(<Window />);
  screen.getByRole("button", { name: "Title bar" }).focus();
  const visits = [];
  for (let step = 0; step < 5; step += 1) {
    press("F6");
    visits.push(focused());
  }
  assert.deepEqual(visits, ["Open chat", "Conversation", "Message", "Changes", "Open chat"]);
});

test("⇧F6 goes the other way, and a closed panel is skipped", () => {
  render(<Window panel="closed" />);
  screen.getByRole("textbox", { name: "Message" }).focus();
  press("F6", { shiftKey: true });
  assert.equal(focused(), "Conversation");
  press("F6", { shiftKey: true });
  assert.equal(focused(), "Open chat");
  press("F6", { shiftKey: true });
  assert.equal(focused(), "Message", "past the closed panel to the message box");
});

test("F6 does nothing while a menu is open, or with ⌘ held", () => {
  render(<Window menuOpen />);
  screen.getByRole("menuitem", { name: "Rename" }).focus();
  press("F6");
  assert.equal(focused(), "Rename");
  cleanup();
  render(<Window />);
  screen.getByRole("textbox", { name: "Message" }).focus();
  press("F6", { metaKey: true });
  assert.equal(focused(), "Message");
});

test("⌥↑ from an empty message box lands on the latest reply's Copy, and steps back and forward from there", () => {
  render(<Window />);
  screen.getByRole("textbox", { name: "Message" }).focus();
  press("ArrowUp", { altKey: true });
  assert.equal(focused(), "Copy second");
  press("ArrowUp", { altKey: true });
  assert.equal(focused(), "Copy first");
  press("ArrowUp", { altKey: true });
  assert.equal(focused(), "Copy first", "the first reply is as far as it goes");
  press("ArrowDown", { altKey: true });
  assert.equal(focused(), "Copy second");
  press("ArrowDown", { altKey: true });
  assert.equal(focused(), "Message", "past the latest reply, back to the message box");
});

test("⌥↑ in a message box that holds text moves the caret, not focus", () => {
  render(<Window draft="half a thought" />);
  screen.getByRole("textbox", { name: "Message" }).focus();
  const event = press("ArrowUp", { altKey: true });
  assert.equal(focused(), "Message");
  assert.equal(event, true, "the key is left to the text box");
});

function LateComposer({ shown }: { shown: boolean }) {
  return (
    <>
      <button type="button">Sidebar button</button>
      {shown ? (
        <div data-focus-region="composer">
          <textarea aria-label="Message" />
        </div>
      ) : null}
    </>
  );
}

test("after onboarding closes, the message box takes focus as soon as it appears", async () => {
  (document.activeElement as HTMLElement | null)?.blur();
  const { rerender } = render(<LateComposer shown={false} />);
  const cancel = focusRegionWhenShown("composer");
  await new Promise((resolve) => setTimeout(resolve, 50));
  rerender(<LateComposer shown />);
  await waitFor(() =>
    assert.ok(document.activeElement === screen.getByRole("textbox", { name: "Message" }), `focus is on ${document.activeElement?.tagName}`),
  );
  cancel();
});

test("if the page changes as onboarding closes, the new page's message box gets focus", async () => {
  (document.activeElement as HTMLElement | null)?.blur();
  const { rerender } = render(
    <div data-focus-region="composer">
      <textarea aria-label="Message" />
    </div>,
  );
  const cancel = focusRegionWhenShown("composer");
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("textbox", { name: "Message" })));
  // Opening a Bot's chat swaps in its own message box.
  rerender(
    <div data-focus-region="composer" key="bot">
      <textarea aria-label="Ask Chief of Staff" />
    </div>,
  );
  await waitFor(() =>
    assert.ok(
      document.activeElement === screen.getByRole("textbox", { name: "Ask Chief of Staff" }),
      `focus is on ${document.activeElement?.tagName}`,
    ),
  );
  cancel();
});

test("focus someone moves first is left where they put it", async () => {
  (document.activeElement as HTMLElement | null)?.blur();
  const { rerender } = render(<LateComposer shown={false} />);
  const cancel = focusRegionWhenShown("composer");
  const button = screen.getByRole("button", { name: "Sidebar button" });
  button.focus();
  rerender(<LateComposer shown />);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(document.activeElement === button, `focus moved to ${document.activeElement?.tagName}`);
  cancel();
});

for (const [binding, key, modifiers] of [
  ["Alt+Up", "ArrowUp", { altKey: true }],
  ["Alt+Down", "ArrowDown", { altKey: true }],
  ["Shift+F6", "F6", { shiftKey: true }],
] as const) {
  test(`saved ${binding} runs its command before built-in focus navigation`, async () => {
    const overrides = applyKeybindingMutation(undefined, { commandId: "model.change", binding });
    const snapshot = { overrides, effective: effectiveBindings(overrides), global: [] };
    installBotTestIpc({ "shortcut:get": () => snapshot, "app:renderer-ready": () => null, "app:setMenuCommands": () => true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    client.setQueryData(["shortcuts"], snapshot);
    let opened = 0;
    function Command() {
      useCommandHandler("model.change", () => { opened += 1; });
      const currentBinding = useShortcutBinding("model.change");
      return <><output aria-label="Model shortcut">{currentBinding ?? "Unassigned"}</output><Window /></>;
    }
    render(<QueryClientProvider client={client}><CommandSystemProvider><Command /></CommandSystemProvider></QueryClientProvider>);
    const origin = key === "ArrowDown"
      ? screen.getByRole("button", { name: "Copy second" })
      : screen.getByRole("textbox", { name: "Message" });
    origin.focus();
    press(key, modifiers);
    assert.equal(opened, 1, "the accepted saved key reaches its registered command");
    assert.equal(document.activeElement, origin, "built-in navigation did not also move focus");

    // A live rebind or disable gives the key back to its built-in action.
    act(() => emitBotTestNotification("shortcut:changed", {
      ...snapshot,
      effective: effectiveBindings(applyKeybindingMutation(overrides, { commandId: "model.change", disabled: true })),
    }));
    await waitFor(() => assert.equal(screen.getByLabelText("Model shortcut").textContent, "Unassigned"));
    origin.focus();
    press(key, modifiers);
    assert.equal(opened, 1, "the disabled command stays off");
    assert.equal(focused(), key === "ArrowUp" ? "Copy second" : key === "ArrowDown" ? "Message" : "Conversation");
    cleanup();
    client.clear();
  });
}
