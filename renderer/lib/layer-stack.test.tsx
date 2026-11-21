import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider } from "./command-system";
import { effectiveBindings } from "../shared/keybindings";
import { hasOpenLayer, openLayer, useLayer, type LayerKind } from "./layer-stack";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SplitView,
  useSplitViewSidebar,
} from "../components/ui";

afterEach(cleanup);

const escape = (init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
};

test("the newest layer is on top until it closes", () => {
  const menu = openLayer("menu");
  const popover = openLayer("popover");
  assert.equal(popover.isTop(), true);
  assert.equal(menu.isTop(), false);
  popover.close();
  assert.equal(popover.isTop(), false);
  assert.equal(menu.isTop(), true);
  popover.close();
  assert.equal(menu.isTop(), true, "closing twice leaves the other layers alone");
  menu.close();
  assert.equal(hasOpenLayer(), false);
});

test("anything but a panel covers a panel, whenever it opened, and panels never cover each other", () => {
  const sheet = openLayer("sheet");
  const tools = openLayer("panel");
  const botPanel = openLayer("panel");
  assert.equal(tools.isTop(), false, "the sheet opened first and still covers the panel");
  assert.equal(sheet.isTop(), true, "a panel never covers a sheet");
  sheet.close();
  assert.equal(tools.isTop(), true);
  assert.equal(botPanel.isTop(), true);
  const dialog = openLayer("modal", { name: "dialog" });
  assert.equal(tools.isTop(), false);
  assert.equal(hasOpenLayer((layer) => layer.name === "dialog"), true);
  dialog.close();
  tools.close();
  botPanel.close();
});

test("Escape goes to the uncovered layers, newest first, until one handles it", () => {
  const heard: string[] = [];
  const lower = openLayer("sheet", { onEscape: () => heard.push("lower") });
  const upper = openLayer("sheet", {
    onEscape: (event) => {
      heard.push("upper");
      event.preventDefault();
    },
  });
  escape();
  assert.deepEqual(heard, ["upper"]);
  upper.close();
  escape();
  assert.deepEqual(heard, ["upper", "lower"]);

  heard.length = 0;
  escape({ isComposing: true });
  escape({ keyCode: 229 });
  const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  document.body.dispatchEvent(handled);
  assert.deepEqual(heard, [], "composing and already handled Escapes reach no layer");

  lower.close();
  escape();
  assert.deepEqual(heard, [], "a closed layer stops listening");
});

function Layer({ open = true, kind, onEscape }: { open?: boolean; kind: LayerKind; onEscape(): void }) {
  useLayer(open, kind, { onEscape });
  return null;
}

test("useLayer joins while open and leaves when closed or unmounted, once even under StrictMode", () => {
  let heard = 0;
  // Panels never cover each other, so a second registration would hear the key too.
  const view = render(
    <React.StrictMode>
      <Layer kind="panel" onEscape={() => (heard += 1)} />
    </React.StrictMode>,
  );
  escape();
  assert.equal(heard, 1);
  view.rerender(
    <React.StrictMode>
      <Layer open={false} kind="panel" onEscape={() => (heard += 1)} />
    </React.StrictMode>,
  );
  assert.equal(hasOpenLayer(), false);
  view.rerender(
    <React.StrictMode>
      <Layer kind="panel" onEscape={() => (heard += 10)} />
    </React.StrictMode>,
  );
  escape();
  assert.equal(heard, 11, "the newest onEscape runs");
  view.unmount();
  assert.equal(hasOpenLayer(), false);
});

/** A custom sheet under a Radix dialog, both open. */
function Harness({ dismissDisabled = false }: { dismissDisabled?: boolean }) {
  const [dialogOpen, setDialogOpen] = React.useState(true);
  const [sheetOpen, setSheetOpen] = React.useState(true);
  useLayer(sheetOpen, "sheet", {
    onEscape: (event) => {
      event.preventDefault();
      setSheetOpen(false);
    },
  });
  return (
    <>
      <p>{sheetOpen ? "Sheet open" : "Sheet closed"}</p>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} title="Rename" dismissDisabled={dismissDisabled}>
        <input aria-label="Name" />
      </Dialog>
    </>
  );
}

test("a custom layer ignores Escape while a dialog is open and takes it once the dialog closes", async () => {
  render(<Harness />);
  screen.getByRole("textbox", { name: "Name" }).focus();
  act(() => void escape());
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  screen.getByText("Sheet open");
  act(() => void escape());
  screen.getByText("Sheet closed");
});

test("a dialog that refuses to close still keeps Escape from the layer under it", () => {
  render(<Harness dismissDisabled />);
  screen.getByRole("textbox", { name: "Name" }).focus();
  act(() => void escape());
  screen.getByRole("dialog");
  screen.getByText("Sheet open");
});

test("Escape that ends an input method's composition leaves a dialog open", async () => {
  render(<Harness />);
  screen.getByRole("textbox", { name: "Name" }).focus();
  act(() => void escape({ isComposing: true }));
  screen.getByRole("dialog");
  act(() => void escape());
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});

test("an uncontrolled menu is on the stack only while open", async () => {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Chat actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  assert.equal(hasOpenLayer(), false);
  const trigger = screen.getByRole("button", { name: "Chat actions" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("menuitem", { name: "Rename" });
  assert.equal(hasOpenLayer((layer) => layer.kind === "menu"), true);
  act(() => void escape());
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
  assert.equal(hasOpenLayer(), false);
});

test("a dialog covers a sheet whichever opened first, and a sheet still covers a panel", () => {
  const panel = openLayer("panel");
  const dialog = openLayer("modal");
  const sheet = openLayer("sheet");
  assert.equal(sheet.isTop(), false, "the sheet opened later but sits under the dialog");
  assert.equal(dialog.isTop(), true);
  assert.equal(panel.isTop(), false);
  dialog.close();
  assert.equal(sheet.isTop(), true);
  assert.equal(panel.isTop(), false);
  sheet.close();
  panel.close();
});

/** Opens the compact sidebar after the dialog, as a programmatic open would. */
function OpenSidebar() {
  const sidebar = useSplitViewSidebar();
  return (
    <button type="button" onClick={() => sidebar?.setCollapsed(false)}>
      Open sidebar
    </button>
  );
}

test("the compact sidebar leaves Tab to a dialog that opened before it", () => {
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
  // happy-dom does no layout; the sidebar only counts controls that are shown.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  try {
    const shortcuts = { overrides: undefined, effective: effectiveBindings(undefined), global: [] };
    installBotTestIpc({ "shortcut:get": () => shortcuts, "app:renderer-ready": () => null, "app:setMenuCommands": () => true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["shortcuts"], shortcuts);
    render(
      <QueryClientProvider client={client}>
        <CommandSystemProvider>
          <SplitView storageKey="layer-test" sidebar={<button type="button">New chat</button>}>
            <Dialog open onOpenChange={() => undefined} title="Rename">
              <input aria-label="First" />
              <input aria-label="Second" />
            </Dialog>
            <OpenSidebar />
          </SplitView>
        </CommandSystemProvider>
      </QueryClientProvider>,
    );
    const first = screen.getByRole("textbox", { name: "First" });
    first.focus();
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar", hidden: true }));
    assert.notEqual(document.querySelector('[data-compact-sidebar-open="true"]'), null);
    // Radix pulls focus back into the dialog, so a trapped Tab shows as a swallowed key.
    assert.equal(fireEvent.keyDown(first, { key: "Tab" }), true, "the sidebar left Tab to the dialog");
  } finally {
    if (offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
    else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
    if (width) Object.defineProperty(window, "innerWidth", width);
    else delete (window as { innerWidth?: number }).innerWidth;
  }
});

const kindOpen = (kind: LayerKind) => hasOpenLayer((layer) => layer.kind === kind);

test("a controlled menu hears each open change once and joins the stack while open", async () => {
  const changes: boolean[] = [];
  function Controlled() {
    const [open, setOpen] = React.useState(false);
    return (
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          changes.push(next);
          setOpen(next);
        }}
      >
        <DropdownMenuTrigger>Chat actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  render(<Controlled />);
  const trigger = screen.getByRole("button", { name: "Chat actions" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("menuitem", { name: "Rename" });
  assert.equal(kindOpen("menu"), true);
  act(() => void escape());
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
  assert.deepEqual(changes, [true, false]);
  assert.equal(hasOpenLayer(), false);
});

test("a Popover open by default joins the stack and leaves it when it closes", async () => {
  render(
    <Popover defaultOpen>
      <PopoverTrigger>Details</PopoverTrigger>
      <PopoverContent>Popover body</PopoverContent>
    </Popover>,
  );
  await screen.findByText("Popover body");
  assert.equal(kindOpen("popover"), true);
  act(() => void escape());
  await waitFor(() => assert.equal(screen.queryByText("Popover body"), null));
  assert.equal(hasOpenLayer(), false);
});

test("a menu unmounted while open leaves the stack", async () => {
  const view = render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Chat actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  await screen.findByRole("menuitem", { name: "Rename" });
  assert.equal(kindOpen("menu"), true);
  view.unmount();
  assert.equal(hasOpenLayer(), false);
});

test("a context menu joins the stack while open", async () => {
  render(
    <ContextMenu>
      <ContextMenuTrigger>Chat row</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Pin</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
  assert.equal(hasOpenLayer(), false);
  fireEvent.contextMenu(screen.getByText("Chat row"), { clientX: 10, clientY: 10 });
  await screen.findByRole("menuitem", { name: "Pin" });
  assert.equal(kindOpen("menu"), true);
  act(() => void escape());
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
  assert.equal(hasOpenLayer(), false);
});
