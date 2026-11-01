// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesignFrame } from "../../shared/design-canvas/schema";
import { designFrameSnapshots } from "../frame-snapshots";
import { FileFrame } from "./file-node";

const GRANT = "a".repeat(52);
const noop = () => undefined;

afterEach(() => {
  cleanup();
  mock.timers.reset();
});

function page(overrides: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id: `page-${Math.random().toString(36).slice(2)}`,
    kind: "file",
    title: "Hero page",
    x: 0,
    y: 0,
    w: 640,
    h: 436,
    path: "design/hero page.html",
    designWidth: 1280,
    createdBy: "aiden",
    ...overrides,
  };
}

function frameProps(frame: DesignFrame, overrides: Partial<Parameters<typeof FileFrame>[0]> = {}) {
  return {
    frame,
    grant: GRANT,
    live: true,
    entered: false,
    version: 0,
    onEnter: noop,
    onMissing: noop,
    onRemove: noop,
    ...overrides,
  };
}

/** happy-dom loads no pages, so each iframe gets a stand-in window to post from. */
function giveWindow(iframe: HTMLIFrameElement) {
  const guest = { postMessage: noop } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => guest });
  return guest;
}

function post(source: unknown, data: unknown) {
  act(() => {
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source as Window }));
  });
}

const iframes = () => Array.from(document.querySelectorAll("iframe"));

test("a frame that is not live shows its snapshot, or a skeleton naming it, and never an iframe", () => {
  installBotTestIpc({});
  const withPicture = page();
  designFrameSnapshots.set(withPicture.id, 0, "data:image/png;base64,SNAP");
  const { unmount } = render(<FileFrame {...frameProps(withPicture, { live: false })} />);
  const picture = document.querySelector("img");
  assert.equal(picture?.getAttribute("src"), "data:image/png;base64,SNAP");
  assert.equal(iframes().length, 0);
  unmount();

  render(<FileFrame {...frameProps(page({ title: "Pricing" }), { live: false })} />);
  assert.equal(document.querySelector("img") === null, true, "no picture was ever taken");
  assert.equal(iframes().length, 0);
  assert.ok(screen.getByRole("img", { name: "Pricing" }), "the skeleton names the frame");
});

test("a live frame runs one sandboxed iframe of the page, scaled from its design width", () => {
  installBotTestIpc({});
  render(<FileFrame {...frameProps(page())} />);
  const [iframe, ...rest] = iframes();
  assert.equal(rest.length, 0);
  assert.equal(iframe?.getAttribute("sandbox"), "allow-scripts", "never allow-same-origin");
  assert.equal(iframe?.getAttribute("src"), `aiden-design://${GRANT}/design/hero%20page.html`);
  assert.equal(iframe?.style.width, "1280px");
  // The 640 px wide box shows the 1280 px page at half size.
  assert.equal(iframe?.style.transform, "scale(0.5)");
});

test("a live frame without a grant shows its skeleton instead of loading anything", () => {
  installBotTestIpc({});
  render(<FileFrame {...frameProps(page(), { grant: null })} />);
  assert.equal(iframes().length, 0);
});

test("until it is entered the page takes no pointer input, and a double-click enters it", () => {
  installBotTestIpc({});
  const entered: string[] = [];
  const frame = page();
  const { rerender } = render(<FileFrame {...frameProps(frame, { onEnter: () => entered.push(frame.id) })} />);
  const wrapper = iframes()[0]!.parentElement!;
  assert.equal(wrapper.style.pointerEvents, "none");
  assert.equal(wrapper.classList.contains("nodrag"), false, "dragging the frame moves it");

  fireEvent.doubleClick(screen.getByRole("group", { name: "Hero page" }));
  assert.deepEqual(entered, [frame.id]);

  rerender(<FileFrame {...frameProps(frame, { entered: true })} />);
  const enteredWrapper = iframes()[0]!.parentElement!;
  assert.notEqual(enteredWrapper.style.pointerEvents, "none");
  assert.equal(enteredWrapper.classList.contains("nodrag"), true, "pointer drags go to the page");
  assert.equal(enteredWrapper.classList.contains("nowheel"), true, "the wheel scrolls the page");
});

test("only the frame's own page can report its height", () => {
  installBotTestIpc({});
  render(<FileFrame {...frameProps(page())} />);
  const iframe = iframes()[0]!;
  giveWindow(iframe);
  const stranger = { postMessage: noop };

  post(stranger, { type: "aiden-design:ready", docHeight: 900 });
  post(null, { type: "aiden-design:ready", docHeight: 900 });
  assert.equal(screen.queryByText("1280 × 900") === null, true);
  assert.ok(screen.getByText("1280"), "before the page reports, only the design width shows");

  post(iframe.contentWindow, { type: "aiden-design:ready", docHeight: 2400 });
  assert.ok(screen.getByText("1280 × 2400"));
  post(iframe.contentWindow, { type: "aiden-design:resize", docHeight: 2600.4 });
  assert.ok(screen.getByText("1280 × 2600"));
});

test("a page that never answers after loading is shown as missing, with a way to remove the frame", () => {
  installBotTestIpc({});
  mock.timers.enable({ apis: ["setTimeout"] });
  const missing: string[] = [];
  const removed: string[] = [];
  const frame = page();
  render(
    <FileFrame
      {...frameProps(frame, { onMissing: () => missing.push(frame.id), onRemove: () => removed.push(frame.id) })}
    />,
  );
  const iframe = iframes()[0]!;
  giveWindow(iframe);
  // The scheme answers 404 as plain text: the page loads, but no bridge reports in.
  fireEvent.load(iframe);
  act(() => mock.timers.tick(1999));
  assert.equal(screen.queryByText("File not found") === null, true, "still waiting for the page");
  act(() => mock.timers.tick(1));
  assert.ok(screen.getByText("File not found"));
  assert.deepEqual(missing, [frame.id]);
  assert.equal(iframes().length, 0);

  fireEvent.click(screen.getByRole("button", { name: "Remove frame" }));
  assert.deepEqual(removed, [frame.id]);
});

test("a page that reports in after loading is not missing", () => {
  installBotTestIpc({});
  mock.timers.enable({ apis: ["setTimeout"] });
  render(<FileFrame {...frameProps(page())} />);
  const iframe = iframes()[0]!;
  giveWindow(iframe);
  fireEvent.load(iframe);
  post(iframe.contentWindow, { type: "aiden-design:ready", docHeight: 800 });
  act(() => mock.timers.tick(5000));
  assert.equal(screen.queryByText("File not found") === null, true);
  assert.equal(iframes().length, 1);
});

test("a newer version of the file reloads the frame in place, and clears a missing state", () => {
  installBotTestIpc({});
  mock.timers.enable({ apis: ["setTimeout"] });
  const frame = page({ path: "design/hero.html" });
  const { rerender } = render(<FileFrame {...frameProps(frame, { version: 0 })} />);
  giveWindow(iframes()[0]!);
  fireEvent.load(iframes()[0]!);
  act(() => mock.timers.tick(2000));
  assert.equal(iframes().length, 0);

  rerender(<FileFrame {...frameProps(frame, { version: 3 })} />);
  assert.equal(screen.queryByText("File not found") === null, true);
  assert.equal(iframes()[0]?.getAttribute("src"), `aiden-design://${GRANT}/design/hero.html?v=3`);
});

test("a frame leaving the live set keeps its iframe until its snapshot is taken", async () => {
  const frame = page();
  let answer!: (value: { dataUrl: string }) => void;
  const calls = installBotTestIpc({
    "designCanvas:capture": () => new Promise((resolve) => (answer = resolve)),
  });
  const rect = { x: 10, y: 20, width: 640, height: 436, top: 20, left: 10, right: 650, bottom: 456 };
  const restore = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { ...rect, toJSON: noop } as DOMRect;
  };
  try {
    const { rerender } = render(<FileFrame {...frameProps(frame)} />);
    rerender(<FileFrame {...frameProps(frame, { live: false })} />);
    assert.equal(iframes().length, 1, "the page stays on screen while it is captured");
    assert.equal(calls.filter((call) => call.channel === "designCanvas:capture").length, 1);

    await act(async () => answer({ dataUrl: "data:image/png;base64,LEFT" }));
    assert.equal(iframes().length, 0);
    assert.equal(document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,LEFT");
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = restore;
  }
});
