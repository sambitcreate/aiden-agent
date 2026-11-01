// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog, TooltipProvider } from "./ui";
import { WindowControls } from "./window-controls";

// Aiden's Linux window controls sit above open dialogs. Using them is a window
// action, not a click outside the dialog: the dialog and what was typed in it
// must survive a minimize or maximize.

let calls: BotTestIpcCall[] = [];

beforeEach(() => {
  let maximized = false;
  calls = installBotTestIpc({
    "app:window:getState": () => ({ maximized, fullScreen: false }),
    "app:window:minimize": () => true,
    "app:window:toggleMaximize": () => {
      maximized = !maximized;
      return { maximized, fullScreen: false };
    },
  });
  (window as unknown as { aidenAPI: { window?: unknown } }).aidenAPI.window = { chrome: "aiden" };
});

afterEach(cleanup);

function EditorDialog({ closes }: { closes: boolean[] }) {
  const [open, setOpen] = React.useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closes.push(true);
        setOpen(next);
      }}
      title="Edit task"
    >
      <input aria-label="Task name" />
    </Dialog>
  );
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.pointerDown(element, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
    fireEvent.click(element);
  });
}

test("minimize and maximize leave an open dialog and its unsaved input alone", async () => {
  const closes: boolean[] = [];
  render(
    <TooltipProvider>
      <WindowControls />
      <EditorDialog closes={closes} />
    </TooltipProvider>,
  );
  // Radix starts listening for outside presses a tick after the dialog opens.
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), { target: { value: "Weekly digest" } });

  // The modal hides the rest of the app from assistive tech; the controls stay clickable.
  await click(screen.getByRole("button", { name: "Minimize", hidden: true }));
  await click(screen.getByRole("button", { name: "Maximize", hidden: true }));
  await click(await screen.findByRole("button", { name: "Restore", hidden: true }));

  assert.deepEqual(
    calls.map((call) => call.channel).filter((channel) => channel !== "app:window:getState"),
    ["app:window:minimize", "app:window:toggleMaximize", "app:window:toggleMaximize"],
  );
  assert.deepEqual(closes, [], "no window action asked the dialog to close");
  assert.equal(screen.getByRole("dialog", { name: "Edit task" }).isConnected, true);
  assert.equal((screen.getByRole("textbox", { name: "Task name" }) as HTMLInputElement).value, "Weekly digest");
});

test("a press on the app behind the dialog still dismisses it", async () => {
  const closes: boolean[] = [];
  render(
    <TooltipProvider>
      <button type="button">Behind</button>
      <WindowControls />
      <EditorDialog closes={closes} />
    </TooltipProvider>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  await click(screen.getByRole("button", { name: "Behind", hidden: true }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.deepEqual(closes, [true]);
  assert.equal(screen.queryByRole("dialog", { name: "Edit task" }), null);
});
