import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import type * as React from "react";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { focusRegionWhenShown, useReplyFocusKeys } from "./focus-regions";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider, useCommandHandler, useShortcutBinding } from "./command-system";
import { applyKeybindingMutation, effectiveBindings, type KeybindingOverridesV1 } from "../shared/keybindings";
import { useDeviceStream } from "./use-device-stream";
import { DeviceViewer } from "../components/device-viewer";
import { DeviceTabRenameInput } from "../components/device-workspace-tabs";
import { TooltipProvider } from "../components/ui";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function renderWindow(props: Parameters<typeof Window>[0] = {}) {
  return renderCommands(<Window {...props} />);
}

function renderCommands(children: React.ReactNode, overrides?: KeybindingOverridesV1, applicationModal = false) {
  const snapshot = { overrides, effective: effectiveBindings(overrides), global: [] };
  const calls = installBotTestIpc({ "shortcut:get": () => snapshot, "app:renderer-ready": () => null, "app:setMenuCommands": () => true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["shortcuts"], snapshot);
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CommandSystemProvider applicationModal={applicationModal}>{children}</CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, calls };
}

function Keys() {
  useReplyFocusKeys();
  return null;
}

/** The window's areas as the app marks them, with two replies in the conversation. */
function Window({
  panel = "open",
  draft = "",
  menuOpen = false,
  panelContent,
}: {
  panel?: "open" | "closed";
  draft?: string;
  menuOpen?: boolean;
  panelContent?: React.ReactNode;
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
        {panelContent}
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
  renderWindow();
  screen.getByRole("button", { name: "Title bar" }).focus();
  const visits = [];
  for (let step = 0; step < 5; step += 1) {
    press("F6");
    visits.push(focused());
  }
  assert.deepEqual(visits, ["Open chat", "Conversation", "Message", "Changes", "Open chat"]);
});

test("⇧F6 goes the other way, and a closed panel is skipped", () => {
  renderWindow({ panel: "closed" });
  screen.getByRole("textbox", { name: "Message" }).focus();
  press("F6", { shiftKey: true });
  assert.equal(focused(), "Conversation");
  press("F6", { shiftKey: true });
  assert.equal(focused(), "Open chat");
  press("F6", { shiftKey: true });
  assert.equal(focused(), "Message", "past the closed panel to the message box");
});

test("F6 does nothing while a menu is open, or with ⌘ held", () => {
  renderWindow({ menuOpen: true });
  screen.getByRole("menuitem", { name: "Rename" }).focus();
  press("F6");
  assert.equal(focused(), "Rename");
  cleanup();
  renderWindow();
  screen.getByRole("textbox", { name: "Message" }).focus();
  press("F6", { metaKey: true });
  assert.equal(focused(), "Message");
});

test("⌥↑ from an empty message box lands on the latest reply's Copy, and steps back and forward from there", () => {
  renderWindow();
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
  renderWindow({ draft: "half a thought" });
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


function StreamScreen() {
  const stream = useDeviceStream({ hostId: "local", deviceId: "screen-1", platform: "ios", active: false });
  return <div role="application" aria-label="Stream screen" tabIndex={0} data-typing-surface="device"
    onKeyDown={stream.key("down")} onKeyUp={stream.key("up")} onBlur={stream.releaseKeys}>
    <canvas ref={stream.canvasRef} />
  </div>;
}

function DeviceScreen() {
  return <DeviceViewer chatId="chat-1"
    session={{ chatId: "chat-1", hostId: "local", deviceId: "screen-1", openedBy: "user" }}
    device={{ hostId: "local", id: "screen-1", name: "Test phone", platform: "ios", version: "27", booted: true, kind: "iphone" }}
    active={false} compact={false} onClose={() => {}} />;
}

for (const [name, content, target] of [
  ["stream screen", <StreamScreen />, () => screen.getByRole("application")],
  ["full device viewer", <DeviceScreen />, () => screen.getByRole("application")],
  ["device-tab rename", <DeviceTabRenameInput title="Phone tab" onCommit={() => {}} onCancel={() => {}} />, () => screen.getByRole("textbox", { name: "Device tab name" })],
] as const) {
  test(`F6 leaves the real ${name}; a saved key wins and disabling restores navigation`, async () => {
    localStorage.setItem("aiden.devices.framePreference", "flat");
    let commands = 0;
    function Host() {
      useCommandHandler("model.change", () => { commands += 1; });
      const binding = useShortcutBinding("model.change");
      return <><output aria-label="Model shortcut">{binding ?? "Unassigned"}</output><Window panelContent={content} /></>;
    }
    const { calls } = renderCommands(<Host />);
    const surface = target();
    surface.focus();
    press("F6", { code: "F6" });
    assert.equal(focused(), "Open chat", "unbound F6 leaves the nested handler for the sidebar");
    surface.focus();
    press("F6", { code: "F6", shiftKey: true });
    assert.equal(focused(), "Message", "unbound Shift-F6 leaves the nested handler for the composer");
    assert.equal(commands, 0);

    const overrides = applyKeybindingMutation(undefined, { commandId: "model.change", binding: "Shift+F6" });
    act(() => emitBotTestNotification("shortcut:changed", { overrides, effective: effectiveBindings(overrides), global: [] }));
    await waitFor(() => assert.equal(screen.getByLabelText("Model shortcut").textContent, "Shift+F6"));
    surface.focus();
    press("F6", { code: "F6", shiftKey: true });
    assert.equal(commands, 1);
    assert.equal(document.activeElement, surface, "the saved command did not also cycle focus");

    const disabled = applyKeybindingMutation(overrides, { commandId: "model.change", disabled: true });
    act(() => emitBotTestNotification("shortcut:changed", { overrides: disabled, effective: effectiveBindings(disabled), global: [] }));
    await waitFor(() => assert.equal(screen.getByLabelText("Model shortcut").textContent, "Unassigned"));
    surface.focus();
    press("F6", { code: "F6", shiftKey: true });
    assert.equal(focused(), "Message");
    assert.equal(commands, 1);
    assert.equal(calls.some((call) => call.channel === "devices:stream-grant"), false);
  });
}

for (const guard of ["application modal", "dialog", "menu", "picker", "shortcut recorder", "IME"] as const) {
  test(`area navigation stays off under the ${guard} guard`, () => {
    renderCommands(<Window />, undefined, guard === "application modal");
    const message = screen.getByRole("textbox", { name: "Message" });
    if (guard === "shortcut recorder") message.setAttribute("data-shortcut-recorder", "true");
    const overlay = document.createElement("div");
    if (guard === "dialog") { overlay.setAttribute("data-slot", "dialog-content"); overlay.setAttribute("data-state", "open"); }
    if (guard === "menu") { overlay.setAttribute("role", "menu"); overlay.setAttribute("data-state", "open"); }
    if (guard === "picker") { overlay.setAttribute("data-slot", "popover-content"); overlay.setAttribute("data-state", "open"); overlay.setAttribute("role", "listbox"); }
    document.body.append(overlay);
    try {
      message.focus();
      const untouched = press("F6", { code: "F6", shiftKey: true, isComposing: guard === "IME" });
      assert.equal(document.activeElement, message);
      assert.equal(untouched, true, "the guard leaves the key untouched");
    } finally { overlay.remove(); }
  });
}


test("an unavailable saved command leaves F6 free for area navigation", () => {
  const overrides = applyKeybindingMutation(undefined, { commandId: "model.change", binding: "Shift+F6" });
  // No model.change handler on this page.
  renderCommands(<Window />, overrides);
  screen.getByRole("textbox", { name: "Message" }).focus();
  press("F6", { code: "F6", shiftKey: true });
  assert.equal(focused(), "Conversation");
});

test("an already handled F6 does not also move between areas", () => {
  renderWindow();
  const message = screen.getByRole("textbox", { name: "Message" });
  message.focus();
  const key = new KeyboardEvent("keydown", { key: "F6", code: "F6", shiftKey: true, bubbles: true, cancelable: true });
  key.preventDefault();
  fireEvent(message, key);
  assert.equal(document.activeElement, message);
});
