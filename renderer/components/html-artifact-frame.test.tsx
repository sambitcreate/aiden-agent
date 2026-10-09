import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import { HtmlArtifactFrame, type GuestPromptHandler } from "./html-artifact-frame";
import {
  GENERATIVE_UI_RESIZE_MESSAGE,
  GENERATIVE_UI_PROMPT_MESSAGE,
  GENERATIVE_UI_THEME_MESSAGE,
  MAX_INLINE_VISUAL_HEIGHT,
} from "../shared/generative-ui-bridge";

const PREVIEW = `aiden-genui://preview/${"f".repeat(64)}`;
let mediaCounter = 0;
let calls: BotTestIpcCall[] = [];

function artifact(title = "Revenue") {
  mediaCounter += 1;
  return {
    version: 1 as const,
    kind: "html" as const,
    id: `html-${mediaCounter}`,
    title,
    mimeType: "text/html" as const,
    size: 10,
    mediaId: `media-${mediaCounter}`,
  };
}

beforeEach(() => {
  calls = installBotTestIpc({
    "chats:htmlArtifactSrcdoc": () => ({ title: "Revenue", src: PREVIEW }),
  });
  document.documentElement.classList.remove("dark");
});
afterEach(() => cleanup());

interface FakeGuest {
  sent: unknown[];
  postMessage: (data: unknown) => void;
}

/** happy-dom does not load iframe pages; give each frame a stand-in guest window. */
function attachGuest(iframe: HTMLIFrameElement): FakeGuest {
  const guest: FakeGuest = { sent: [], postMessage: (data) => guest.sent.push(data) };
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => guest });
  return guest;
}

async function waitForFrame(container: HTMLElement): Promise<HTMLIFrameElement> {
  const iframe = await waitFor(() => {
    const element = container.querySelector("iframe");
    assert.ok(element);
    return element as HTMLIFrameElement;
  });
  // The frame mounts from an async preview fetch outside act(); flush its
  // passive effects (message listener, theme subscription) before posting.
  await act(async () => {});
  return iframe;
}

async function mountedFrame(onGuestPrompt?: GuestPromptHandler) {
  const view = render(<HtmlArtifactFrame chatId="chat-1" artifact={artifact()} onGuestPrompt={onGuestPrompt} />);
  const iframe = await waitForFrame(view.container);
  const guest = attachGuest(iframe);
  return { view, iframe, guest };
}

function postFrom(source: unknown, data: unknown) {
  const MessageEventCtor = (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  act(() => {
    window.dispatchEvent(new MessageEventCtor("message", { data, source: source as Window }));
  });
}

test("inline visual renders without card chrome and keeps an accessible title", () => {
  const html = renderToStaticMarkup(<HtmlArtifactFrame chatId="c1" artifact={artifact("Revenue")} />);
  assert.match(html, /data-inline-visual="media-\d+"/u);
  assert.match(html, /aria-label="Revenue"/u);
  assert.match(html, /aria-label="Expand Revenue"/u);
  assert.match(html, /aria-label="Export Revenue"/u);
  assert.doesNotMatch(html, /<header/u);
});

test("the preview loads in a unique-origin frame and asks main for the full token kit", async () => {
  const { iframe } = await mountedFrame();
  assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
  assert.equal(iframe.getAttribute("src"), PREVIEW);
  assert.equal(iframe.hasAttribute("srcdoc"), false);
  const request = calls.find((call) => call.channel === "chats:htmlArtifactSrcdoc");
  const theme = (request?.args[0] as { theme?: { vars?: unknown } } | undefined)?.theme;
  assert.equal(typeof theme?.vars, "object");
});

test("inline visual height follows its own guest within bounds", async () => {
  const { view, guest } = await mountedFrame();
  const box = () => view.container.querySelector<HTMLElement>("[data-inline-visual-frame]")!;
  postFrom(guest, { type: GENERATIVE_UI_RESIZE_MESSAGE, height: 900 });
  assert.equal(box().style.height, "900px");
  postFrom(guest, { type: GENERATIVE_UI_RESIZE_MESSAGE, height: 5000 });
  assert.equal(box().style.height, `${MAX_INLINE_VISUAL_HEIGHT}px`);
  postFrom(window, { type: GENERATIVE_UI_RESIZE_MESSAGE, height: 300 });
  postFrom(null, { type: GENERATIVE_UI_RESIZE_MESSAGE, height: 300 });
  assert.equal(box().style.height, `${MAX_INLINE_VISUAL_HEIGHT}px`);
});

test("a frame whose guest window is gone ignores sourceless messages", async () => {
  const view = render(<HtmlArtifactFrame chatId="chat-1" artifact={artifact()} />);
  const iframe = await waitForFrame(view.container);
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => null });
  const box = view.container.querySelector<HTMLElement>("[data-inline-visual-frame]")!;
  const before = box.style.height;
  postFrom(null, { type: GENERATIVE_UI_RESIZE_MESSAGE, height: 777 });
  assert.equal(box.style.height, before);
});

test("theme update reaches a mounted frame without changing src", async () => {
  const { iframe, guest } = await mountedFrame();
  const sent = guest.sent;
  act(() => {
    document.documentElement.classList.add("dark");
  });
  await waitFor(() => {
    const themeMessage = sent.find(
      (data) => (data as { type?: string }).type === GENERATIVE_UI_THEME_MESSAGE,
    ) as { colorScheme?: string; vars?: unknown } | undefined;
    assert.equal(themeMessage?.colorScheme, "dark");
    assert.equal(typeof themeMessage?.vars, "object");
  });
  assert.equal(iframe.getAttribute("src"), PREVIEW);
});

test("guest prompts report focus and consume one fresh focus entry", async () => {
  const prompts: Array<[string, boolean, boolean]> = [];
  const { iframe, guest } = await mountedFrame((text, focus) =>
    prompts.push([text, focus.frameFocused, focus.freshActivation]));
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "Unfocused" });
  postFrom(window, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "spoofed" });

  // A click into the frame moves focus to it and blurs the parent window.
  act(() => {
    iframe.focus();
    window.dispatchEvent(new Event("blur"));
  });
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "First" });
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "Timer" });
  assert.deepEqual(prompts, [
    ["Unfocused", false, false],
    ["First", true, true],
    ["Timer", true, false],
  ]);
});

/** happy-dom lacks the Popover API; Chromium top-layer behavior is covered in tests/generative-ui. */
function stubPopoverApi(): () => void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown> & {
    matches: (selector: string) => boolean;
  };
  const originalMatches = proto.matches;
  const open = new WeakSet<object>();
  proto.showPopover = function showPopover(this: HTMLElement) {
    open.add(this);
  };
  proto.hidePopover = function hidePopover(this: HTMLElement) {
    open.delete(this);
  };
  proto.matches = function matches(this: HTMLElement, selector: string) {
    if (selector === ":popover-open") return open.has(this);
    return originalMatches.call(this, selector);
  };
  return () => {
    delete proto.showPopover;
    delete proto.hidePopover;
    proto.matches = originalMatches;
  };
}

test("Expand promotes the same frame to a modal dialog and Close returns to the inline region", async (t) => {
  t.after(stubPopoverApi());
  const { view, iframe } = await mountedFrame();
  act(() => {
    screen.getByRole("button", { name: /^Expand / }).click();
  });
  const dialog = await waitFor(() => screen.getByRole("dialog"));
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(view.container.querySelectorAll("iframe").length, 1);
  assert.equal(view.container.querySelector("iframe"), iframe);
  act(() => {
    screen.getByRole("button", { name: /^Close / }).click();
  });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.ok(screen.getByRole("region"));
  assert.equal(view.container.querySelector("iframe"), iframe);
});

test("a remount at stream handoff reuses the cached preview and height", async () => {
  const visual = artifact();
  const first = render(<HtmlArtifactFrame chatId="chat-1" artifact={visual} />);
  const guest = attachGuest(await waitForFrame(first.container));
  postFrom(guest, { type: GENERATIVE_UI_RESIZE_MESSAGE, height: 420 });
  first.unmount();
  const fetchesBefore = calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").length;
  const second = render(<HtmlArtifactFrame chatId="chat-1" artifact={visual} />);
  const remounted = second.container.querySelector("iframe");
  assert.equal(remounted?.getAttribute("src"), PREVIEW);
  assert.equal(
    second.container.querySelector<HTMLElement>("[data-inline-visual-frame]")!.style.height,
    "420px",
  );
  assert.equal(
    calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").length,
    fetchesBefore,
  );
  assert.ok(screen.getByRole("region", { name: visual.title }));
});
