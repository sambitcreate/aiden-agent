import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { LinksSettings } from "./links-settings";
import { SettingsAnchorContext } from "./settings-page";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
/** The newest entry. Equivalent to `.at(-1)`, which the ES2021 lib lacks. */
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];

test("shows the saved preference and saves a new one", async () => {
  const calls = installBotTestIpc({
    "browser:link-preference": () => "external",
    "browser:set-link-preference": (value) => value,
  });
  render(<LinksSettings />);
  await flush();
  const trigger = screen.getByRole("combobox", { name: "Open links in" });
  assert.match(trigger.textContent ?? "", /System browser/);
  assert.ok(screen.getByText(/local dev servers always open in Aiden/i));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: "Ask each time" }));
  await flush();
  assert.deepEqual(last(calls), { channel: "browser:set-link-preference", args: ["ask"] });
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /Ask each time/);
});

test("a link-preference broadcast updates the shown choice without a reload", async () => {
  installBotTestIpc({
    "browser:link-preference": () => "ask",
    "browser:set-link-preference": (value) => value,
  });
  render(<LinksSettings />);
  await flush();
  emitBotTestNotification("browser:event", { type: "link-preference", linkOpening: "external" });
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /System browser/);
});

test("a failed save restores the previous choice", async () => {
  installBotTestIpc({
    "browser:link-preference": () => "browser",
    "browser:set-link-preference": () => {
      throw new Error("disk full");
    },
  });
  render(<LinksSettings />);
  await flush();
  fireEvent.click(screen.getByRole("combobox", { name: "Open links in" }));
  fireEvent.click(await screen.findByRole("option", { name: "System browser" }));
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /Aiden browser/);
});

test("embedded chat link control follows a newer broadcast while its first read is pending", async () => {
  let finish!: (value: string) => void;
  installBotTestIpc({ "browser:link-preference": () => new Promise<string>((resolve) => { finish = resolve; }) });
  render(<LinksSettings embedded />);
  emitBotTestNotification("browser:event", { type: "link-preference", linkOpening: "external" });
  await flush();
  finish("ask");
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Open chat links in" }).textContent ?? "", /System browser/u);
});

function recordScrolls(): { scrolls: ScrollIntoViewOptions[]; restore: () => void } {
  const scrolls: ScrollIntoViewOptions[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (options) {
    scrolls.push(options as ScrollIntoViewOptions);
  };
  return { scrolls, restore: () => { HTMLElement.prototype.scrollIntoView = original; } };
}

/** Frames that run only when the test advances time. */
function manualFrames() {
  let queue: { id: number; callback: FrameRequestCallback }[] = [];
  let nextId = 0;
  let now = 1_000;
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    queue.push({ id: ++nextId, callback });
    return nextId;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queue = queue.filter((frame) => frame.id !== id);
  };
  return {
    pending: () => queue.length,
    advance(ms: number) {
      now += ms;
      const due = queue;
      queue = [];
      for (const frame of due) frame.callback(now);
    },
    restore() {
      globalThis.requestAnimationFrame = request;
      globalThis.cancelAnimationFrame = cancel;
    },
  };
}

/** Settings' scrollport, where Chromium would center the Links row at `middle`. */
function scrollport(middle: number): { port: HTMLDivElement; restore: () => void } {
  const port = document.createElement("div");
  port.style.overflowY = "auto";
  document.body.append(port);
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function () {
    port.scrollTop = middle;
  };
  return { port, restore: () => { HTMLElement.prototype.scrollIntoView = original; } };
}

test("opening the links section glides the row to the middle, or jumps there under Reduce Motion", async () => {
  installBotTestIpc({ "browser:link-preference": () => "ask" });
  const frames = manualFrames();
  const { port, restore } = scrollport(600);
  const anchored = (
    <SettingsAnchorContext.Provider value={{ section: "links", request: 1 }}>
      <LinksSettings embedded />
    </SettingsAnchorContext.Provider>
  );
  try {
    render(anchored, { container: port });
    await flush();
    assert.equal(port.scrollTop, 0);
    for (let frame = 0; frame < 10 && frames.pending() > 0; frame += 1) frames.advance(60);
    assert.equal(port.scrollTop, 600);
    cleanup();

    port.scrollTop = 0;
    document.documentElement.dataset.reduceMotion = "true";
    render(anchored, { container: port });
    await flush();
    assert.equal(port.scrollTop, 600);
    assert.equal(frames.pending(), 0);
  } finally {
    delete document.documentElement.dataset.reduceMotion;
    frames.restore();
    restore();
    port.remove();
  }
});

test("leaving the links spot mid-glide stops the glide where it is", async () => {
  installBotTestIpc({ "browser:link-preference": () => "ask" });
  const frames = manualFrames();
  const { port, restore } = scrollport(600);
  const page = (anchor: boolean) => (
    <SettingsAnchorContext.Provider value={anchor ? { section: "links", request: 1 } : null}>
      <LinksSettings embedded />
    </SettingsAnchorContext.Provider>
  );
  try {
    const view = render(page(true), { container: port });
    await flush();
    frames.advance(16);
    frames.advance(100);
    assert.ok(port.scrollTop > 0 && port.scrollTop < 600, "still on its way");

    view.rerender(page(false));
    await flush();
    const left = port.scrollTop;
    frames.advance(60);
    frames.advance(500);
    assert.equal(port.scrollTop, left);
    assert.equal(frames.pending(), 0);
  } finally {
    frames.restore();
    restore();
    port.remove();
  }
});

test("asking for the links section again scrolls back to the row", async () => {
  installBotTestIpc({ "browser:link-preference": () => "ask" });
  const { scrolls, restore } = recordScrolls();
  const page = (request: number) => (
    <SettingsAnchorContext.Provider value={{ section: "links", request }}>
      <LinksSettings embedded />
    </SettingsAnchorContext.Provider>
  );
  try {
    const view = render(page(1));
    await flush();
    view.rerender(page(1));
    assert.equal(scrolls.length, 1);
    view.rerender(page(2));
    await flush();
    assert.equal(scrolls.length, 2);
  } finally {
    restore();
  }
});

test("opening Appearance itself leaves the page at the top", async () => {
  installBotTestIpc({ "browser:link-preference": () => "ask" });
  const { scrolls, restore } = recordScrolls();
  try {
    render(<LinksSettings embedded />);
    await flush();
    assert.equal(scrolls.length, 0);
  } finally {
    restore();
  }
});
