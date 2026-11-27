// A live app frame's header menus (design mode v2 Phase 3c): the device menu
// and Custom… (S92).

// Installs happy-dom and the fake IPC bridge; must stay the first import.
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesignFrame } from "../shared/design-canvas/schema";
import { AppDeviceMenu, AppMoreMenu, type AppViewSize, type AppViewportSize } from "./app-frame-menus";

afterEach(cleanup);

function appFrame(overrides: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id: "app-1",
    kind: "app",
    title: "Pricing",
    pageId: "page-1",
    x: 0,
    y: 0,
    w: 640,
    h: 436,
    createdBy: "aiden",
    appRoot: ".",
    route: "/pricing",
    viewport: { width: 1180, height: 800 },
    scale: 0.5,
    ...overrides,
  };
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

test("the button names the matching device, or the size", () => {
  const view = render(<AppDeviceMenu frame={appFrame()} onViewport={() => undefined} />);
  const button = screen.getByRole("button", { name: "Viewport, 1180 by 800" });
  assert.equal(button.textContent, "1180 × 800");
  view.rerender(<AppDeviceMenu frame={appFrame({ viewport: { width: 768, height: 1024 } })} onViewport={() => undefined} />);
  const ipad = screen.getByRole("button", { name: "Viewport, iPad, 768 by 1024" });
  assert.equal(ipad.textContent, "iPad");
});

test("choosing a device asks for its size, and the matching one is checked", async () => {
  const chosen: AppViewportSize[] = [];
  render(<AppDeviceMenu frame={appFrame({ viewport: { width: 390, height: 844 } })} onViewport={(size) => chosen.push(size)} />);
  openMenu(screen.getByRole("button", { name: /^Viewport/u }));
  const items = await screen.findAllByRole("menuitemradio");
  assert.deepEqual(
    items.map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    [
      ["iPhone390 × 844", "true"],
      ["iPad768 × 1024", "false"],
      ["Laptop1280 × 800", "false"],
      ["Desktop1440 × 900", "false"],
    ],
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: /iPad/u }));
  assert.deepEqual(chosen, [{ width: 768, height: 1024 }]);
});

test("Custom… opens with focus in Width, applies whole numbers in range and refuses others", async () => {
  const chosen: AppViewportSize[] = [];
  render(<AppDeviceMenu frame={appFrame()} onViewport={(size) => chosen.push(size)} />);
  openMenu(screen.getByRole("button", { name: /^Viewport/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Custom…" }));
  const dialog = await screen.findByRole("dialog", { name: "Custom viewport" });
  const width = screen.getByRole("textbox", { name: "Width" }) as HTMLInputElement;
  const height = screen.getByRole("textbox", { name: "Height" }) as HTMLInputElement;
  await waitFor(() => assert.equal(document.activeElement, width));
  assert.equal(width.value, "1180");
  assert.equal(height.value, "800");
  const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;

  for (const typed of ["150", "4001", "12.5", "abc", ""]) {
    fireEvent.change(width, { target: { value: typed } });
    assert.equal(apply.disabled, true, typed);
  }
  fireEvent.change(width, { target: { value: "150" } });
  assert.ok(screen.getByText("200–4000"));
  assert.equal(width.getAttribute("aria-invalid"), "true");

  fireEvent.change(width, { target: { value: "500" } });
  fireEvent.change(height, { target: { value: "900" } });
  assert.equal(apply.disabled, false);
  fireEvent.click(apply);
  assert.deepEqual(chosen, [{ width: 500, height: 900 }]);
  await waitFor(() => assert.equal(dialog.isConnected, false));
});

test("closing Custom returns focus to the device button", async () => {
  render(<AppDeviceMenu frame={appFrame()} onViewport={() => assert.fail("Cancel changes nothing")} />);
  const button = screen.getByRole("button", { name: /^Viewport/u });
  openMenu(button);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Custom…" }));
  await screen.findByRole("dialog", { name: "Custom viewport" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog") === null, true));
  await waitFor(() => assert.equal(document.activeElement, button));

  // Escape does the same.
  openMenu(button);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Custom…" }));
  const width = await screen.findByRole("textbox", { name: "Width" });
  act(() => {
    fireEvent.keyDown(width, { key: "Escape", code: "Escape" });
  });
  await waitFor(() => assert.equal(screen.queryByRole("dialog") === null, true));
  await waitFor(() => assert.equal(document.activeElement, button));
});

test("a narrow frame's device button is an icon with its name, and a locked frame's is off", () => {
  const view = render(<AppDeviceMenu frame={appFrame()} compact onViewport={() => undefined} />);
  const button = screen.getByRole("button", { name: "Viewport, 1180 by 800" });
  assert.equal(button.textContent, "");
  view.rerender(<AppDeviceMenu frame={appFrame({ locked: true })} onViewport={() => undefined} />);
  assert.equal((screen.getByRole("button", { name: /^Viewport/u }) as HTMLButtonElement).disabled, true);
});

// ── More (S93, S96, S98) ──

function moreMenu(frame = appFrame()) {
  const calls: Array<string | AppViewSize> = [];
  render(
    <AppMoreMenu
      frame={frame}
      onAddView={(size) => calls.push(size)}
      onDuplicate={() => calls.push("duplicate")}
      onTrash={() => calls.push("trash")}
      onRemove={() => calls.push("remove")}
    />,
  );
  return { calls, button: screen.getByRole("button", { name: "More actions for Pricing" }) };
}

test("More lists the four actions, and Add view at width offers the devices and Custom…", async () => {
  const { calls, button } = moreMenu();
  openMenu(button);
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(
    items.map((item) => item.textContent?.replace(/⌘D|⌫|Ctrl\+D|Backspace/gu, "").trim()),
    ["Add view at width", "Duplicate page as variant", "Move page file to Trash…", "Remove from canvas"],
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /Duplicate page as variant/u }));
  assert.deepEqual(calls, ["duplicate"]);

  openMenu(button);
  const sub = await screen.findByRole("menuitem", { name: "Add view at width" });
  fireEvent.keyDown(sub, { key: "ArrowRight", code: "ArrowRight" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /iPad/u }));
  assert.deepEqual(calls, ["duplicate", { device: "tablet" }]);
});

test("Add view at width ▸ Custom… adds a view of a typed size", async () => {
  const { calls, button } = moreMenu();
  openMenu(button);
  const sub = await screen.findByRole("menuitem", { name: "Add view at width" });
  fireEvent.keyDown(sub, { key: "ArrowRight", code: "ArrowRight" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Custom…" }));
  await screen.findByRole("dialog", { name: "Add view at width" });
  fireEvent.change(screen.getByRole("textbox", { name: "Width" }), { target: { value: "500" } });
  fireEvent.click(screen.getByRole("button", { name: "Add view" }));
  assert.deepEqual(calls, [{ width: 500, height: 800 }]);
});

test("Move page file to Trash asks first, with focus on Cancel", async () => {
  const { calls, button } = moreMenu();
  openMenu(button);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move page file to Trash…" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Move page file to Trash" });
  assert.match(dialog.textContent ?? "", /\/pricing/u, "it names the page");
  assert.match(dialog.textContent ?? "", /You can undo this/u);
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await waitFor(() => assert.equal(document.activeElement, cancel));
  fireEvent.click(cancel);
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog") === null, true));
  await waitFor(() => assert.equal(document.activeElement, button));
  assert.deepEqual(calls, [], "Cancel calls nothing");

  openMenu(button);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move page file to Trash…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Move to Trash" }));
  assert.deepEqual(calls, ["trash"]);
});

test("a locked frame's More actions are off", async () => {
  const { button } = moreMenu(appFrame({ locked: true }));
  openMenu(button);
  const items = await screen.findAllByRole("menuitem");
  assert.ok(items.every((item) => item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")));
});
