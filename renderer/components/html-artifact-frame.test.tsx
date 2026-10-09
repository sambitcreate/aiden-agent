import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import {
  HtmlArtifactDraftFrame,
  HtmlArtifactFrame,
  primeInlineVisualPreview,
  rememberDraftHeight,
  type GuestPromptHandler,
} from "./html-artifact-frame";
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

test("a draft visual shows its streaming preview without expand or export actions", () => {
  const src = `aiden-genui://preview/${"d".repeat(64)}`;
  const view = render(<HtmlArtifactDraftFrame src={src} title="Revenue" />);
  const iframe = view.container.querySelector("iframe");
  assert.equal(iframe?.getAttribute("src"), src);
  assert.equal(iframe?.getAttribute("sandbox"), "allow-scripts");
  assert.ok(view.container.querySelector("[data-inline-visual-draft]"));
  assert.equal(screen.queryByRole("button", { name: /Expand|Export/u }), null);
  assert.ok(screen.getByText(/Revenue/u));
});

test("inline visual renders without card chrome and keeps an accessible title", () => {
  const html = renderToStaticMarkup(<HtmlArtifactFrame chatId="c1" artifact={artifact("Revenue")} />);
  assert.match(html, /data-inline-visual="media-\d+"/u);
  assert.match(html, /aria-label="Expand Revenue"/u);
  assert.match(html, /aria-label="Export Revenue"/u);
  assert.doesNotMatch(html, /<header/u);
});

test("the inline visual is a named figure whose actions sit below the content, never over it", () => {
  const view = render(<HtmlArtifactFrame chatId="c1" artifact={artifact("Revenue")} />);
  const figure = screen.getByRole("figure", { name: "Revenue" });
  const frame = figure.querySelector("[data-inline-visual-frame]");
  const caption = figure.querySelector("[data-inline-visual-caption]");
  assert.ok(frame && caption);
  // The caption follows the content box in flow instead of overlaying it.
  assert.equal(frame.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(frame.contains(caption), false);
  assert.ok(within(caption as HTMLElement).getByRole("button", { name: "Expand Revenue" }));
  view.unmount();
});

test("keyboard focus inside the guest is reflected on the visual so a ring can show", async () => {
  const { view, iframe } = await mountedFrame();
  const box = () => view.container.querySelector<HTMLElement>("[data-inline-visual-frame]")!;
  assert.equal(box().hasAttribute("data-guest-focused"), false);
  act(() => {
    iframe.focus();
    window.dispatchEvent(new Event("blur"));
  });
  assert.equal(box().hasAttribute("data-guest-focused"), true);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  assert.equal(box().hasAttribute("data-guest-focused"), false);
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

test("a guest announcing ready receives the current theme before its document finishes loading", async () => {
  const { guest } = await mountedFrame();
  postFrom(guest, { type: "aiden:generative-ui:ready" });
  const themeMessage = guest.sent.find(
    (data) => (data as { type?: string }).type === GENERATIVE_UI_THEME_MESSAGE,
  ) as { vars?: unknown } | undefined;
  assert.equal(typeof themeMessage?.vars, "object");
});

function setParentActivation(isActive: boolean): void {
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive, hasBeenActive: isActive } });
}

test("guest prompts count as gestured only with activation the parent page did not cause", async (t) => {
  t.after(() => setParentActivation(false));
  setParentActivation(false);
  const prompts: Array<{ text: string; focused: boolean; activated: boolean; entry: number }> = [];
  const { iframe, guest } = await mountedFrame((text, focus) =>
    prompts.push({ text, focused: focus.frameFocused, activated: focus.userActivated, entry: focus.focusEntry }));
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "Unfocused" });
  postFrom(window, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "spoofed" });

  // The guest focuses itself from a timer: focus moves in, but no gesture.
  const enterFrame = () => act(() => {
    iframe.focus();
    window.dispatchEvent(new Event("blur"));
  });
  enterFrame();
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "Scripted" });
  // The user clicks inside the frame: the parent gains transient activation.
  setParentActivation(true);
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "Clicked" });
  // Typing in the composer also activates the parent; that must not count.
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "AfterTyping" });

  assert.deepEqual(prompts.map(({ text, focused, activated }) => [text, focused, activated]), [
    ["Unfocused", false, false],
    ["Scripted", true, false],
    ["Clicked", true, true],
    ["AfterTyping", true, false],
  ]);
  const firstEntry = prompts[1]!.entry;
  assert.equal(prompts[2]!.entry, firstEntry);
  act(() => window.dispatchEvent(new Event("focus")));
  enterFrame();
  postFrom(guest, { type: GENERATIVE_UI_PROMPT_MESSAGE, text: "Reentered" });
  assert.notEqual(prompts[prompts.length - 1]!.entry, firstEntry);
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
  assert.ok(screen.getByRole("figure", { name: "Revenue" }));
  assert.equal(view.container.querySelector("iframe"), iframe);
});

test("a presented visual replaces its draft at the draft's height with a ready preview", () => {
  const visual = artifact();
  const src = `aiden-genui://preview/${"e".repeat(64)}`;
  rememberDraftHeight("call-7", 333);
  primeInlineVisualPreview("chat-1", visual, src);
  const fetchesBefore = calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").length;
  const view = render(<HtmlArtifactFrame chatId="chat-1" artifact={visual} placementCallId="call-7" />);
  // No loading placeholder and no round trip: the iframe is there on first render.
  assert.equal(view.container.querySelector("iframe")?.getAttribute("src"), src);
  assert.equal(view.container.querySelector<HTMLElement>("[data-inline-visual-frame]")!.style.height, "333px");
  assert.equal(calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").length, fetchesBefore);
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
  assert.ok(screen.getByRole("figure", { name: visual.title }));
});
