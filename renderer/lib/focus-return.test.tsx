import "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { returnFocus } from "./focus-return";
import { AlertDialog, Dialog, TooltipProvider } from "../components/ui";
import { Tooltip } from "../components/ui-primitives";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function button(label: string, setup?: (element: HTMLButtonElement) => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  setup?.(element);
  document.body.append(element);
  return element;
}

test("returnFocus skips removed, hidden, inert, aria-hidden and disabled candidates and lands on the first usable one", () => {
  const removed = button("Removed");
  removed.remove();
  const hiddenAttribute = button("Hidden", (element) => (element.hidden = true));
  const undisplayed = document.createElement("div");
  undisplayed.style.display = "none";
  const insideUndisplayed = document.createElement("button");
  undisplayed.append(insideUndisplayed);
  document.body.append(undisplayed);
  const inertPanel = document.createElement("div");
  inertPanel.setAttribute("inert", "");
  const insideInert = document.createElement("button");
  inertPanel.append(insideInert);
  document.body.append(inertPanel);
  const ariaHidden = document.createElement("div");
  ariaHidden.setAttribute("aria-hidden", "true");
  const insideAriaHidden = document.createElement("button");
  ariaHidden.append(insideAriaHidden);
  document.body.append(ariaHidden);
  const disabled = button("Disabled", (element) => (element.disabled = true));
  const target = button("Target");
  const later = button("Later");

  const landed = returnFocus(
    [
      null,
      removed,
      hiddenAttribute,
      insideUndisplayed,
      insideInert,
      insideAriaHidden,
      disabled,
      () => target,
      later,
    ],
    {
      region: null,
    },
  );

  assert.equal(landed, target);
  assert.equal(document.activeElement, target);
});

test("a candidate that does not take focus gives the next one its turn", () => {
  const refuses = button("Refuses");
  refuses.focus = () => undefined;
  const next = button("Next");
  assert.equal(returnFocus([refuses, next], { region: null }), next);
  assert.equal(document.activeElement, next);
});

function messageBox(): HTMLTextAreaElement {
  const composer = document.createElement("div");
  composer.setAttribute("data-focus-region", "composer");
  const draft = document.createElement("textarea");
  draft.setAttribute("data-focus-region-entry", "");
  composer.append(draft);
  document.body.append(composer);
  return draft;
}

test("the fallbacks never take focus the app already moved somewhere on purpose", () => {
  const draft = messageBox();
  const gone = button("Gone");
  gone.remove();
  const search = button("Search");
  search.focus();
  assert.equal(returnFocus([gone]), null);
  assert.equal(document.activeElement, search, "focus stays on what the app chose");

  // Focus still inside the surface that is closing is lost, though.
  const tray = document.createElement("div");
  const row = document.createElement("button");
  tray.append(row);
  document.body.append(tray);
  row.focus();
  assert.equal(returnFocus([gone], { closing: tray }), draft);
});

test("with every candidate gone, focus falls back to the message box, then the app root", () => {
  const composer = document.createElement("div");
  composer.setAttribute("data-focus-region", "composer");
  const draft = document.createElement("textarea");
  draft.setAttribute("data-focus-region-entry", "");
  composer.append(draft);
  const root = document.createElement("div");
  root.setAttribute("data-app-focus-root", "");
  root.tabIndex = -1;
  document.body.append(composer, root);
  const gone = button("Gone");
  gone.remove();

  assert.equal(returnFocus([gone]), draft);
  composer.remove();
  assert.equal(returnFocus([gone]), root);
  root.remove();
  const before = button("Before");
  before.focus();
  assert.equal(returnFocus([gone]), null, "nothing would take focus");
  assert.equal(document.activeElement, before, "focus stays where it was");
});

test("a tooltip opens when its trigger is focused, but not when focus is put back on it", async () => {
  render(
    <TooltipProvider>
      <Tooltip content="Open terminal">
        <button type="button">Terminal</button>
      </Tooltip>
      <button type="button">Elsewhere</button>
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Terminal" });
  act(() => trigger.focus());
  await waitFor(() =>
    assert.notEqual(screen.queryByRole("tooltip"), null, "keyboard focus shows the hint"),
  );
  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  await waitFor(() => assert.equal(screen.queryByRole("tooltip"), null));

  act(() => void returnFocus([trigger], { region: null }));
  assert.equal(document.activeElement, trigger);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole("tooltip"), null, "restored focus leaves the hint closed");
});

function DialogWithVanishingOpener() {
  const [open, setOpen] = React.useState(false);
  const [rowShown, setRowShown] = React.useState(true);
  return (
    <>
      <div data-focus-region="composer">
        <textarea aria-label="Message" data-focus-region-entry />
      </div>
      {rowShown ? (
        <button type="button" onClick={() => setOpen(true)}>
          Delete chat
        </button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delete chat"
        confirmLabel="Delete"
        onConfirm={() => setRowShown(false)}
      >
        <p>The chat goes away.</p>
      </Dialog>
    </>
  );
}

test("a Dialog whose opener was removed while open returns focus to the message box, not the page", async () => {
  render(<DialogWithVanishingOpener />);
  const opener = screen.getByRole("button", { name: "Delete chat" });
  act(() => opener.focus());
  fireEvent.click(opener);
  await waitFor(() => assert.notEqual(screen.queryByRole("dialog"), null));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Delete chat" }), null));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  await waitFor(() =>
    assert.equal(document.activeElement, screen.getByRole("textbox", { name: "Message" })),
  );
});

/**
 * Stands in for the stylesheet: open dialog parts play an entrance animation
 * and closed ones an exit animation, the way `aiden-dialog-in`/`-out` and
 * `aiden-overlay-in`/`-out` do in the app.
 */
function withDialogAnimations(): () => void {
  const owner = globalThis as { getComputedStyle: typeof window.getComputedStyle };
  const realGlobal = owner.getComputedStyle;
  const realWindow = window.getComputedStyle;
  const animated = ((element: Element) => {
    const style = realWindow.call(window, element);
    // A live declaration, like the browser's: it follows later state changes.
    const animationName = () => {
      const state = element.getAttribute("data-state");
      return state === "open" ? "aiden-in" : state === "closed" ? "aiden-out" : "none";
    };
    return new Proxy(style, {
      get: (target, key) => (key === "animationName" ? animationName() : Reflect.get(target, key)),
    });
  }) as typeof window.getComputedStyle;
  owner.getComputedStyle = animated;
  window.getComputedStyle = animated;
  // Radix matches animation names through CSS.escape, which happy-dom lacks.
  const holder = globalThis as { CSS?: { escape(value: string): string } };
  const realCss = holder.CSS;
  holder.CSS ??= { escape: (value: string) => value };
  return () => {
    owner.getComputedStyle = realGlobal;
    window.getComputedStyle = realWindow;
    holder.CSS = realCss;
  };
}

function finishExitAnimations(): void {
  for (const part of document.querySelectorAll(
    '[data-slot="dialog-content"], [data-slot="dialog-overlay"]',
  )) {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: "aiden-out" });
    part.dispatchEvent(event);
  }
}

for (const [kind, Shown] of [
  [
    "Dialog",
    ({ open }: { open: boolean }) => (
      <Dialog
        open={open}
        onOpenChange={() => undefined}
        title="Rename chat"
        description="Pick a name."
      />
    ),
  ],
  [
    "AlertDialog",
    ({ open }: { open: boolean }) => (
      <AlertDialog open={open} onOpenChange={() => undefined} title="Rename chat" />
    ),
  ],
] as const) {
  test(`a closing ${kind} stays on screen until its exit animation ends`, async () => {
    const restore = withDialogAnimations();
    try {
      const view = render(<Shown open />);
      assert.notEqual(screen.queryByRole(kind === "Dialog" ? "dialog" : "alertdialog"), null);
      await act(async () => view.rerender(<Shown open={false} />));
      const closing = document.querySelector('[data-slot="dialog-content"]');
      assert.ok(closing, "the dialog is still mounted while it animates out");
      assert.equal(closing.getAttribute("data-state"), "closed");
      assert.equal(
        document.querySelector('[data-slot="dialog-overlay"]')?.getAttribute("data-state"),
        "closed",
      );
      await act(async () => finishExitAnimations());
      assert.equal(document.querySelector('[data-slot="dialog-content"]'), null);
      assert.equal(document.querySelector('[data-slot="dialog-overlay"]'), null);
    } finally {
      restore();
    }
  });
}
