// A live app frame's header menus (design mode v2 Phase 3c): the device menu
// and Custom… (S92).

// Installs happy-dom and the fake IPC bridge; must stay the first import.
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesignFrame } from "../shared/design-canvas/schema";
import { AppDeviceMenu, type AppViewportSize } from "./app-frame-menus";

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
