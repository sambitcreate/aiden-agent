// A live app frame on the canvas (design mode v2 Phase 3a, D16, S75): the
// iframe's security contract, mounting through main, the states over the last
// picture, main's notices, the page's untrusted bridge, and the focus guard
// that keeps a page's focus() loop from taking keys out of Aiden.

// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster } from "../../components/ui";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import { parseAppFrameName } from "../../shared/design-canvas/app-frame";
import type { DesignFrame } from "../../shared/design-canvas/schema";
import type { DesignAppsSnapshot, DesignAppStatus } from "../../shared/design-app";
import { resetDesignAppChipForTests } from "../design-app-chip";
import { designFrameSnapshots } from "../frame-snapshots";
import { AppFrame, type AppFrameProps, APP_FRAME_CAPTURE_SETTLE_MS } from "./app-node";
import { DesignNodeContext, type DesignNodeContextValue } from "./design-node-context";
import { FrameActions } from "./frame-actions";

const ORIGIN = "http://127.0.0.1:5173";
const restoreRect = window.HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  cleanup();
  window.HTMLElement.prototype.getBoundingClientRect = restoreRect;
});

function appFrame(overrides: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id: `app-${Math.random().toString(36).slice(2)}`,
    kind: "app",
    title: "Pricing",
    x: 0,
    y: 0,
    w: 640,
    h: 436,
    appRoot: ".",
    route: "/pricing",
    viewport: { width: 1280, height: 800 },
    scale: 0.5,
    pageId: "page-1",
    createdBy: "aiden",
    ...overrides,
  } as DesignFrame;
}

function app(overrides: Partial<DesignAppStatus> = {}): DesignAppStatus {
  return {
    workspaceId: "ws-1",
    appRoot: ".",
    source: "started",
    frameworkLabel: "Vite",
    phase: "running",
    since: 1,
    origin: ORIGIN,
    port: 5173,
    revision: 3,
    ...overrides,
  };
}

function snapshotOf(...apps: DesignAppStatus[]): DesignAppsSnapshot {
  return { workspaceId: "ws-1", target: "single", apps, candidates: [], chosen: [] };
}

type MountRequest = { frameId: string; mountToken: string };

function setup(
  options: {
    apps?: DesignAppStatus[];
    mount?: (request: MountRequest) => unknown;
    extra?: Record<string, (...args: unknown[]) => unknown>;
  } = {},
): { calls: BotTestIpcCall[]; mounts: () => MountRequest[] } {
  resetDesignAppChipForTests();
  const calls = installBotTestIpc({
    "designApp:status:get": () => snapshotOf(...(options.apps ?? [app()])),
    "designCanvas:appFrameMount": (_chatId, request) => (options.mount ?? (() => ({ origin: ORIGIN })))(request as MountRequest),
    "designCanvas:capture": () => ({ dataUrl: "data:image/png;base64,NEW" }),
    ...options.extra,
  });
  const mounts = () => calls.filter((call) => call.channel === "designCanvas:appFrameMount").map((call) => call.args[1] as MountRequest);
  return { calls, mounts };
}

const noop = () => undefined;

function Harness(props: Partial<AppFrameProps> & { frame: DesignFrame; designLive?: boolean; composer?: boolean }) {
  const { designLive = true, composer = false, ...rest } = props;
  return (
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true, designLive }}>
      {composer ? <textarea aria-label="Composer" /> : null}
      <AppFrame chatId="chat-1" live entered={false} onEnter={noop} onLeave={noop} onOpenInBrowser={noop} {...rest} />
      <Toaster />
    </AppCapabilitiesProvider>
  );
}

const iframes = () => Array.from(document.querySelectorAll("iframe"));
const tokens = (value: string | null, separator: RegExp) =>
  new Set(
    (value ?? "")
      .split(separator)
      .map((token) => token.trim())
      .filter(Boolean),
  );

/** happy-dom loads no pages, so each iframe gets a stand-in window to post from and to. */
function giveWindow(iframe: HTMLIFrameElement) {
  const posted: Array<{ data: unknown; origin: string }> = [];
  const guest = { postMessage: (data: unknown, origin: string) => posted.push({ data, origin }) } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => guest });
  return { guest, posted };
}

function post(source: unknown, data: unknown, origin = ORIGIN) {
  act(() => {
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source as Window, origin }));
  });
}

async function liveIframe(): Promise<HTMLIFrameElement> {
  await waitFor(() => assert.equal(iframes().length, 1));
  return iframes()[0]!;
}

function notify(event: Record<string, unknown>) {
  act(() => emitBotTestNotification("designCanvas:appFrame", event));
}

/**
 * Chromium lets a page's own focus() pull focus into an inert iframe (probe
 * 8). happy-dom honours `inert`, so the stand-in for the page's call lifts it
 * for the moment of the call.
 */
function pageTakesFocus(iframe: HTMLIFrameElement) {
  const inert = iframe.hasAttribute("inert");
  iframe.removeAttribute("inert");
  iframe.focus();
  if (inert) iframe.setAttribute("inert", "");
}

async function settleFocus() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── The iframe's contract ──

test("a live app frame frames main's origin plus the route, sandboxed without modals, popups, downloads or top navigation", async () => {
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} />);
  const iframe = await liveIframe();

  assert.deepEqual(tokens(iframe.getAttribute("sandbox"), /\s+/u), new Set(["allow-scripts", "allow-same-origin", "allow-forms"]));
  const allow = tokens(iframe.getAttribute("allow"), /;/u);
  for (const feature of [
    "camera",
    "microphone",
    "geolocation",
    "display-capture",
    "clipboard-read",
    "clipboard-write",
    "picture-in-picture",
    "fullscreen",
    "usb",
    "hid",
    "serial",
    "bluetooth",
    "payment",
    "autoplay",
  ]) {
    assert.ok(allow.has(`${feature} 'none'`), `${feature} is denied`);
  }
  assert.equal([...allow].every((entry) => entry.endsWith("'none'")), true, "the allow list grants nothing");
  assert.equal(iframe.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(iframe.getAttribute("src"), `${ORIGIN}/pricing`);
  assert.equal(iframe.getAttribute("data-app-frame-id"), frame.id);
  assert.equal(iframe.hasAttribute("data-frame-id"), false, "v1's comment listener never matches an app iframe");
  const name = parseAppFrameName(iframe.getAttribute("name") ?? "");
  assert.deepEqual(name, { frameId: frame.id, mountToken: mounts()[0]!.mountToken });
});

test("no iframe exists until main answers the mount, which names the frame and a fresh token, never a URL", async () => {
  let answer: (value: unknown) => void = noop;
  const frame = appFrame();
  const { calls, mounts } = setup({ mount: () => new Promise((resolve) => (answer = resolve)) });
  render(<Harness frame={frame} />);
  await waitFor(() => assert.equal(mounts().length, 1));
  assert.equal(iframes().length, 0, "nothing is framed before main records the placement");
  const call = calls.find((entry) => entry.channel === "designCanvas:appFrameMount")!;
  assert.equal(call.args[0], "chat-1");
  assert.deepEqual(Object.keys(call.args[1] as object).sort(), ["frameId", "mountToken"]);
  assert.equal((call.args[1] as MountRequest).frameId, frame.id);
  act(() => answer({ origin: ORIGIN }));
  await liveIframe();
});

test("an IPv6 origin isn't framed: the frame asks to restart the app on 127.0.0.1", async () => {
  setup({ apps: [app({ origin: "http://[::1]:5173" })], mount: () => ({ origin: "http://[::1]:5173" }) });
  render(<Harness frame={appFrame()} />);
  assert.ok(await screen.findByText(/This app runs on IPv6 localhost/u));
  assert.equal(iframes().length, 0);
});

test("a restart on another port mounts again with a new token and a new iframe", async () => {
  const { mounts } = setup();
  render(<Harness frame={appFrame()} />);
  const first = await liveIframe();
  act(() => emitBotTestNotification("designApp:status", snapshotOf(app({ origin: "http://127.0.0.1:5174", port: 5174, revision: 9 }))));
  await waitFor(() => assert.equal(mounts().length, 2));
  assert.notEqual(mounts()[1]!.mountToken, mounts()[0]!.mountToken);
  // The answer for the new mount is what main says now.
  await waitFor(() => assert.equal(iframes()[0] !== first, true, "a new iframe element"));
});

// ── Inert and the focus guard (S75) ──

test("the iframe is inert until entered, and an Esc from its own page leaves; one from another window doesn't", async () => {
  let left = 0;
  const frame = appFrame();
  setup();
  const { rerender } = render(<Harness frame={frame} onLeave={() => (left += 1)} />);
  const iframe = await liveIframe();
  assert.equal(iframe.hasAttribute("inert"), true);

  rerender(<Harness frame={frame} entered onLeave={() => (left += 1)} />);
  assert.equal(iframes()[0]!.hasAttribute("inert"), false);
  const { guest } = giveWindow(iframes()[0]!);
  post({ postMessage: noop }, { type: "aiden-app:escape" });
  assert.equal(left, 0, "another window's Esc changes nothing");
  post(guest, { type: "aiden-app:escape" });
  assert.equal(left, 1);

  rerender(<Harness frame={frame} entered={false} onLeave={() => (left += 1)} />);
  assert.equal(iframes()[0]!.hasAttribute("inert"), true, "leaving makes it inert again");
});

test("a page that pulls focus into a not-entered app frame gives it straight back to the composer", async () => {
  setup();
  render(<Harness frame={appFrame()} composer />);
  const iframe = await liveIframe();
  const composer = screen.getByRole("textbox", { name: "Composer" });
  composer.focus();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    pageTakesFocus(iframe);
    await settleFocus();
    assert.equal(document.activeElement === composer, true, `attempt ${attempt + 1}: the composer keeps focus`);
  }
});

test("in Chromium's order (the composer's focusout on the body, then the window's blur on the iframe) the composer gets focus back", async () => {
  setup();
  render(<Harness frame={appFrame()} composer />);
  const iframe = await liveIframe();
  const composer = screen.getByRole("textbox", { name: "Composer" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    composer.focus();
    // A cross-process frame's focus(): the composer loses focus to nothing first…
    composer.blur();
    await settleFocus();
    // …and the iframe becomes the active element only as the window blurs.
    pageTakesFocus(iframe);
    window.dispatchEvent(new window.FocusEvent("blur"));
    await settleFocus();
    assert.equal(document.activeElement === composer, true, `attempt ${attempt + 1}: the composer has focus back`);
  }
});

test("a window blur long after the composer lost focus doesn't send focus back to it", async () => {
  setup();
  render(<Harness frame={appFrame()} composer />);
  const iframe = await liveIframe();
  const composer = screen.getByRole("textbox", { name: "Composer" });
  composer.focus();
  composer.blur();
  await new Promise((resolve) => setTimeout(resolve, 300));
  pageTakesFocus(iframe);
  window.dispatchEvent(new window.FocusEvent("blur"));
  await settleFocus();
  assert.equal(document.activeElement === document.body, true, "the iframe is blurred; the composer the person left stays left");
});

test("with nothing of Aiden's focused, a page that takes focus is blurred back to the body", async () => {
  setup();
  render(<Harness frame={appFrame()} />);
  const iframe = await liveIframe();
  (document.activeElement as HTMLElement | null)?.blur();
  pageTakesFocus(iframe);
  // Chromium tells the parent window it lost focus to the child frame.
  window.dispatchEvent(new window.FocusEvent("blur"));
  await settleFocus();
  assert.equal(document.activeElement === document.body, true, "focus is back on the body");
});

test("an entered app frame keeps the focus the person gave it", async () => {
  const frame = appFrame();
  setup();
  const { rerender } = render(<Harness frame={frame} composer />);
  await liveIframe();
  rerender(<Harness frame={frame} composer entered />);
  const iframe = iframes()[0]!;
  screen.getByRole("textbox", { name: "Composer" }).focus();
  iframe.focus();
  await settleFocus();
  assert.equal(document.activeElement === iframe, true, "the entered frame keeps focus");
});

test("the focus guard goes away with the last app frame", async () => {
  setup();
  const first = appFrame();
  const second = appFrame();
  const { rerender, unmount } = render(
    <>
      <Harness frame={first} composer />
      <Harness frame={second} />
    </>,
  );
  await waitFor(() => assert.equal(iframes().length, 2));
  // One of two frames goes: the guard stays for the other.
  rerender(<Harness frame={first} composer />);
  const composer = screen.getByRole("textbox", { name: "Composer" });
  composer.focus();
  pageTakesFocus(iframes()[0]!);
  await settleFocus();
  assert.equal(document.activeElement === composer, true, "still guarded while a frame is on the canvas");

  unmount();
  // A bare app iframe after the last frame left: nothing moves focus back any more.
  const field = document.body.appendChild(document.createElement("textarea"));
  const stray = document.body.appendChild(document.createElement("iframe"));
  stray.setAttribute("data-app-frame-id", "gone");
  field.focus();
  stray.focus();
  await settleFocus();
  assert.equal(document.activeElement === stray, true, "nothing moves focus back any more");
  field.remove();
  stray.remove();
});

// ── States over the last picture (D16, S77) ──

test("each phase shows its sentence over the last picture, with only the button that phase offers", async () => {
  const cases: Array<{ status: DesignAppStatus; text: string | RegExp; button?: string }> = [
    { status: app({ phase: "stopped", origin: undefined, port: undefined }), text: "Not running", button: "Start app" },
    { status: app({ phase: "consent", origin: undefined }), text: "Waiting for you to allow the app to run" },
    { status: app({ phase: "installing", origin: undefined }), text: "Starting…" },
    { status: app({ phase: "starting", origin: undefined }), text: "Starting…" },
    { status: app({ phase: "crashed", origin: undefined, exitCode: 1 }), text: "The app's dev server stopped.", button: "Retry" },
    { status: app({ phase: "stopped", origin: undefined, problem: { problem: "exposed" } }), text: /listened beyond this computer/u },
    {
      status: app({ phase: "stopped", origin: undefined, source: "attached", url: "http://127.0.0.1:4321" }),
      text: "Not connected",
      button: "Connect",
    },
  ];
  for (const { status, text, button } of cases) {
    const frame = appFrame();
    designFrameSnapshots.set(frame.id, 0, "data:image/png;base64,SNAP");
    const { mounts } = setup({ apps: [status] });
    const { unmount } = render(<Harness frame={frame} />);
    assert.ok(await screen.findByText(text), `${status.phase}: ${String(text)}`);
    assert.equal(document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,SNAP", "over the last picture");
    const buttons = screen.queryAllByRole("button").map((entry) => entry.textContent);
    assert.deepEqual(buttons, button ? [button] : [], `${status.phase} offers ${button ?? "nothing"}`);
    assert.equal(mounts().length, 0, "nothing mounts while the app isn't running");
    assert.equal(iframes().length, 0);
    unmount();
  }
});

test("Start app and Retry ask main for this frame's app root, and show Starting… at once", async () => {
  const frame = appFrame({ appRoot: "apps/web" });
  const stopped = app({ appRoot: "apps/web", phase: "stopped", origin: undefined });
  let release: (value: unknown) => void = noop;
  const { calls } = setup({
    apps: [stopped],
    extra: { "designApp:start": () => new Promise((resolve) => (release = resolve)) },
  });
  const { unmount } = render(<Harness frame={frame} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start app" }));
  assert.ok(screen.getByText("Starting…"), "the instant rule: the frame changes before main answers");
  assert.deepEqual(calls.find((call) => call.channel === "designApp:start")?.args, ["chat-1", "apps/web"]);
  act(() => release({ ...stopped, phase: "starting", revision: 4 }));
  unmount();

  const crashed = app({ phase: "crashed", origin: undefined });
  const retry = setup({ apps: [crashed], extra: { "designApp:retry": () => ({ ...crashed, phase: "starting", revision: 4 }) } });
  render(<Harness frame={appFrame()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => assert.deepEqual(retry.calls.find((call) => call.channel === "designApp:retry")?.args, ["chat-1", "."]));
});

test("too many live frames is a label over the picture, with no button and no iframe", async () => {
  setup({ mount: () => ({ error: "too-many-frames" }) });
  render(<Harness frame={appFrame()} />);
  assert.ok(await screen.findByText("Too many live frames"));
  assert.equal(screen.queryAllByRole("button").length, 0);
  assert.equal(iframes().length, 0);
});

test("a running app keeps the last picture showing until its page has loaded", async () => {
  const frame = appFrame();
  designFrameSnapshots.set(frame.id, 0, "data:image/png;base64,SNAP");
  setup();
  render(<Harness frame={frame} />);
  const iframe = await liveIframe();
  assert.equal(document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,SNAP");
  fireEvent.load(iframe);
  assert.equal(document.querySelector("img"), null, "the page replaces the picture once it has loaded");
});

test("with live apps off, an app frame says so over its last picture and never mounts", async () => {
  const frame = appFrame();
  designFrameSnapshots.set(frame.id, 0, "data:image/png;base64,SNAP");
  const { mounts } = setup();
  render(<Harness frame={frame} designLive={false} />);
  assert.ok(screen.getByText("Live apps are off"));
  assert.equal(document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,SNAP");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(mounts().length, 0);
  assert.equal(iframes().length, 0);
});

test("a frame outside the six live ones shows its picture and doesn't mount", async () => {
  const { mounts } = setup();
  render(<Harness frame={appFrame()} live={false} />);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(mounts().length, 0);
  assert.equal(iframes().length, 0);
  assert.ok(screen.getByRole("img", { name: "Pricing" }), "the skeleton names the frame");
});

test("a frame whose app root isn't in the workspace says so", async () => {
  setup({ apps: [app({ appRoot: "apps/other" })] });
  render(<Harness frame={appFrame()} />);
  assert.ok(await screen.findByText("This app isn't in this workspace"));
  assert.equal(iframes().length, 0);
});

// ── Main's notices ──

test("the blocked label counts main's totals for this mount only and lists the hosts escaped", async () => {
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} />);
  await liveIframe();
  const mountToken = mounts()[0]!.mountToken;
  notify({ kind: "blocked", frameId: frame.id, mountToken, count: 1, hosts: ["example.com"] });
  notify({ kind: "blocked", frameId: frame.id, mountToken, count: 3, hosts: ["example.com", "evil‮test"] });
  notify({ kind: "blocked", frameId: frame.id, mountToken: "x".repeat(32), count: 50, hosts: ["other.test"] });
  const label = await screen.findByRole("button", { name: "3 blocked" });
  fireEvent.click(label);
  const list = await screen.findByRole("list", { name: "Blocked hosts" });
  assert.deepEqual(
    within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
    ["example.com", "evil\\u{202E}test"],
  );
  assert.ok(screen.getByText("Design mode only lets apps reach localhost for now."));
});

test("a full host list says others may be missing, and suppressed dialogs are listed by kind", async () => {
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} />);
  await liveIframe();
  const mountToken = mounts()[0]!.mountToken;
  const hosts = Array.from({ length: 20 }, (_, index) => `host-${index}.test`);
  notify({ kind: "blocked", frameId: frame.id, mountToken, count: 40, hosts });
  notify({ kind: "dialog-suppressed", frameId: frame.id, mountToken, dialog: "alert" });
  notify({ kind: "dialog-suppressed", frameId: frame.id, mountToken, dialog: "print" });
  fireEvent.click(await screen.findByRole("button", { name: "40 blocked" }));
  assert.ok(await screen.findByText("Other hosts may not be listed."));
  assert.ok(screen.getByText("Dialogs are turned off on the canvas: alert, print"));
});

test("refused links within a second make one toast with the latest, and Open in browser opens it", async () => {
  const frame = appFrame();
  const opened: string[] = [];
  const { mounts } = setup();
  render(<Harness frame={frame} onOpenInBrowser={(url) => opened.push(url)} />);
  await liveIframe();
  const mountToken = mounts()[0]!.mountToken;
  notify({ kind: "navigation-refused", frameId: frame.id, mountToken, url: "https://first.example/" });
  for (let index = 2; index <= 5; index += 1) {
    notify({ kind: "navigation-refused", frameId: frame.id, mountToken, url: `https://site-${index}.example/` });
  }
  await waitFor(() => assert.ok(screen.getByText("site-5.example is outside the app")), { timeout: 2500 });
  assert.equal(screen.queryAllByText(/is outside the app/u).length, 1, "one toast");
  fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
  assert.deepEqual(opened, ["https://site-5.example/"]);
});

/** A clock the test moves by hand (the frame's restore bound is monotonic time). */
function manualClock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

test("when main says the frame landed on a blocked page, it goes back to the page's last in-app path", async () => {
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} entered />);
  const iframe = await liveIframe();
  const start = iframe.getAttribute("src");
  const mountToken = mounts()[0]!.mountToken;
  // Before the page reports a path, it goes back to the frame's route.
  notify({ kind: "navigation-restore", frameId: frame.id, mountToken });
  assert.equal(iframes()[0]!.src, start);
  const { guest } = giveWindow(iframes()[0]!);
  post(guest, { type: "aiden-app:route", path: "/pricing/annual" });
  notify({ kind: "navigation-restore", frameId: frame.id, mountToken: "z".repeat(16) });
  assert.equal(iframes()[0]!.src, start, "another mount's notice changes nothing");
  notify({ kind: "navigation-restore", frameId: frame.id, mountToken });
  assert.equal(iframes()[0]!.src, `${new URL(start!).origin}/pricing/annual`);
});

test("a frame nobody has entered is put back once; its next way out stops it, however long after, until Reload", async () => {
  const clock = manualClock();
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} now={clock.now} />);
  const iframe = await liveIframe();
  const origin = new URL(iframe.getAttribute("src")!).origin;
  const restore = () => notify({ kind: "navigation-restore", frameId: frame.id, mountToken: mounts()[0]!.mountToken });

  restore();
  assert.equal(iframes()[0]!.src, `${origin}/pricing`);
  iframes()[0]!.src = `${origin}/untouched`;
  clock.advance(60_000);
  restore();
  assert.equal(iframes()[0]!.src, `${origin}/untouched`, "an inert frame can't be clicked: a second way out is the page's own");
  assert.ok(screen.getByText("This page leads outside the app."));

  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  assert.equal(iframes()[0]!.src, `${origin}/pricing`);
  assert.equal(screen.queryByText("This page leads outside the app.")?.textContent ?? null, null);
  restore();
  assert.equal(screen.queryByText("This page leads outside the app.")?.textContent ?? null, null, "Reload gives the frame its restore back");
  restore();
  assert.ok(screen.getByText("This page leads outside the app."));
});

test("an entered frame gets three restores; after a path, the next goes to the route whatever the page says; a fourth leaves the frame and stops", async () => {
  const clock = manualClock();
  let left = 0;
  let entered = 0;
  const frame = appFrame();
  const { mounts } = setup();
  const props = { frame, now: clock.now, onLeave: () => (left += 1), onEnter: () => (entered += 1) };
  const { rerender } = render(<Harness {...props} />);
  const iframe = await liveIframe();
  rerender(<Harness {...props} entered />);
  assert.equal(iframes()[0]!.hasAttribute("inert"), false);
  const origin = new URL(iframe.getAttribute("src")!).origin;
  const { guest } = giveWindow(iframe);
  const restore = () => notify({ kind: "navigation-restore", frameId: frame.id, mountToken: mounts()[0]!.mountToken });
  post(guest, { type: "aiden-app:route", path: "/sso" });

  restore();
  assert.equal(iframes()[0]!.src, `${origin}/sso`, "first, the page it was on");
  // The page says it came up at /sso before leading out again: that changes nothing.
  post(guest, { type: "aiden-app:ready" });
  post(guest, { type: "aiden-app:route", path: "/sso" });
  clock.advance(2_000);
  restore();
  assert.equal(iframes()[0]!.src, `${origin}/pricing`, "then the frame's route");
  clock.advance(2_000);
  restore();
  assert.equal(iframes()[0]!.src, `${origin}/pricing`);
  assert.equal(left, 0);
  iframes()[0]!.src = `${origin}/untouched`;
  clock.advance(2_000);
  restore();
  assert.equal(iframes()[0]!.src, `${origin}/untouched`, "no fourth reload");
  assert.ok(screen.getByText("This page leads outside the app."));
  await waitFor(() => assert.ok(left >= 1, "the frame is left"));
  assert.equal(iframes()[0]!.hasAttribute("inert"), true, "and goes inert behind the card");
  fireEvent.doubleClick(screen.getByText("This page leads outside the app."));
  assert.equal(entered, 0, "a stuck frame can't be entered");
});

test("an entered frame that stays up a while between ways out gets its restores back", async () => {
  const clock = manualClock();
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} entered now={clock.now} />);
  const iframe = await liveIframe();
  const origin = new URL(iframe.getAttribute("src")!).origin;
  for (let index = 0; index < 6; index += 1) {
    iframes()[0]!.src = `${origin}/elsewhere`;
    clock.advance(20_000);
    notify({ kind: "navigation-restore", frameId: frame.id, mountToken: mounts()[0]!.mountToken });
    assert.equal(iframes()[0]!.src, `${origin}/pricing`, `restore ${index + 1}`);
  }
  assert.equal(screen.queryByText("This page leads outside the app.")?.textContent ?? null, null);
});

test("Reload clears the stuck state at once: a way out in the same moment is put back", async () => {
  const clock = manualClock();
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} now={clock.now} />);
  const iframe = await liveIframe();
  const origin = new URL(iframe.getAttribute("src")!).origin;
  const restoreEvent = { kind: "navigation-restore", frameId: frame.id, mountToken: mounts()[0]!.mountToken };
  notify(restoreEvent);
  notify(restoreEvent);
  const reload = screen.getByRole("button", { name: "Reload" });
  act(() => {
    reload.click();
    iframes()[0]!.src = `${origin}/untouched`;
    emitBotTestNotification("designCanvas:appFrame", restoreEvent);
  });
  assert.equal(iframes()[0]!.src, `${origin}/pricing`);
});

// ── The page's bridge: untrusted and bounded ──

test("the in-app path comes only from this frame's own page, and an error label opens the escaped message", async () => {
  setup();
  render(<Harness frame={appFrame()} />);
  const { guest } = giveWindow(await liveIframe());
  post({ postMessage: noop }, { type: "aiden-app:route", path: "/elsewhere" });
  assert.equal(screen.queryByText("/elsewhere"), null);
  post(guest, { type: "aiden-app:route", path: "/elsewhere" }, "http://127.0.0.1:9999");
  assert.equal(screen.queryByText("/elsewhere"), null, "a message from another origin is dropped");
  post(guest, { type: "aiden-app:route", path: "/pricing/annual" });
  assert.ok(screen.getByText("/pricing/annual"));

  post(guest, { type: "aiden-app:error", kind: "error", message: "Boom ‮ here" });
  const label = screen.getByRole("button", { name: "Error" });
  label.focus();
  assert.equal(document.activeElement === label, true, "the label is a button the keyboard reaches");
  fireEvent.click(label);
  assert.ok(await screen.findByText("Boom \\u{202E} here"));
});

test("a flood of bridge messages is cut to 60 a second", async () => {
  setup();
  render(<Harness frame={appFrame()} />);
  const { guest } = giveWindow(await liveIframe());
  act(() => {
    for (let index = 1; index <= 200; index += 1) {
      window.dispatchEvent(
        new window.MessageEvent("message", { data: { type: "aiden-app:route", path: `/p/${index}` }, source: guest, origin: ORIGIN }),
      );
    }
  });
  assert.ok(screen.getByText("/p/60"), "the 60th message is the last one read");
});

test("hot updates in a burst take one picture", async () => {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, width: 640, height: 400, right: 640, bottom: 400, toJSON: () => ({}) } as DOMRect;
  };
  const { calls } = setup();
  render(<Harness frame={appFrame()} />);
  const iframe = await liveIframe();
  const { guest } = giveWindow(iframe);
  fireEvent.load(iframe);
  for (let index = 0; index < 10; index += 1) post(guest, { type: "aiden-app:hmr" });
  await act(async () => new Promise((resolve) => setTimeout(resolve, APP_FRAME_CAPTURE_SETTLE_MS + 150)));
  assert.equal(calls.filter((call) => call.channel === "designCanvas:capture").length, 1);
});

test("the Dark switch reaches this frame's page only, on its own origin", async () => {
  const frame = appFrame();
  setup();
  const { rerender } = render(<Harness frame={frame} />);
  const iframe = await liveIframe();
  const mine = giveWindow(iframe);
  fireEvent.load(iframe);
  rerender(<Harness frame={{ ...frame, colorScheme: "dark" }} />);
  assert.deepEqual(mine.posted, [{ data: { type: "aiden-app:set-scheme", dark: true }, origin: ORIGIN }]);
});

// ── Leaving: a stopped app, a frame that leaves the live set, a new mount (review-p3a-2) ──

const captures = (calls: BotTestIpcCall[]) => calls.filter((call) => call.channel === "designCanvas:capture").length;
const stopped = () => app({ phase: "stopped", origin: undefined, port: undefined, revision: 9 });
function onCanvasRect() {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, width: 640, height: 400, right: 640, bottom: 400, toJSON: () => ({}) } as DOMRect;
  };
}

test("an app that stopped while live doesn't come back as an iframe when the frame then leaves the live set", async () => {
  onCanvasRect();
  const frame = appFrame();
  const { mounts } = setup();
  const { rerender } = render(<Harness frame={frame} />);
  fireEvent.load(await liveIframe());
  act(() => emitBotTestNotification("designApp:status", snapshotOf(stopped())));
  await screen.findByText("Not running");
  assert.equal(iframes().length, 0);
  rerender(<Harness frame={frame} live={false} />);
  assert.equal(iframes().length, 0, "no iframe for a used token on a dead origin");
  assert.equal(mounts().length, 1);
});

test("a picture that was due when the app stopped isn't taken of the card that replaced the page", async () => {
  onCanvasRect();
  const { calls } = setup();
  render(<Harness frame={appFrame()} />);
  fireEvent.load(await liveIframe());
  act(() => emitBotTestNotification("designApp:status", snapshotOf(stopped())));
  await screen.findByText("Not running");
  await act(async () => new Promise((resolve) => setTimeout(resolve, APP_FRAME_CAPTURE_SETTLE_MS + 150)));
  assert.equal(captures(calls), 0);
});

test("a new mount's blocked label doesn't list the dialogs an earlier mount suppressed", async () => {
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} />);
  await liveIframe();
  notify({ kind: "dialog-suppressed", frameId: frame.id, mountToken: mounts()[0]!.mountToken, dialog: "alert" });
  assert.ok(await screen.findByRole("button", { name: "Dialogs off" }));
  act(() => emitBotTestNotification("designApp:status", snapshotOf(app({ origin: "http://127.0.0.1:5174", port: 5174, revision: 9 }))));
  await waitFor(() => assert.equal(mounts().length, 2));
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Dialogs off" }) === null, true));
  notify({ kind: "blocked", frameId: frame.id, mountToken: mounts()[1]!.mountToken, count: 1, hosts: ["example.com"] });
  fireEvent.click(await screen.findByRole("button", { name: "1 blocked" }));
  await screen.findByRole("list", { name: "Blocked hosts" });
  assert.equal(screen.queryByText(/Dialogs are turned off/u)?.textContent ?? null, null);
});

test("double-clicking the blocked or error label opens it without entering the frame", async () => {
  const frame = appFrame();
  let entered = 0;
  const { mounts } = setup();
  render(<Harness frame={frame} onEnter={() => (entered += 1)} />);
  const { guest } = giveWindow(await liveIframe());
  notify({ kind: "blocked", frameId: frame.id, mountToken: mounts()[0]!.mountToken, count: 1, hosts: ["example.com"] });
  post(guest, { type: "aiden-app:error", kind: "error", message: "Boom" });
  fireEvent.doubleClick(await screen.findByRole("button", { name: "1 blocked" }));
  fireEvent.doubleClick(screen.getByRole("button", { name: "Error" }));
  assert.equal(entered, 0);
});

test("a stopped app frame can't be entered by double-click", async () => {
  let entered = 0;
  setup({ apps: [stopped()] });
  render(<Harness frame={appFrame()} onEnter={() => (entered += 1)} />);
  fireEvent.doubleClick(await screen.findByText("Not running"));
  assert.equal(entered, 0);
});

test("the Dark switch pressed before the page has loaded reaches it once it has", async () => {
  const frame = appFrame();
  setup();
  const { rerender } = render(<Harness frame={frame} />);
  const iframe = await liveIframe();
  const mine = giveWindow(iframe);
  post(mine.guest, { type: "aiden-app:ready" });
  rerender(<Harness frame={{ ...frame, colorScheme: "dark" }} />);
  assert.deepEqual(mine.posted, [], "nothing goes to a page that hasn't loaded");
  fireEvent.load(iframe);
  assert.deepEqual(mine.posted, [{ data: { type: "aiden-app:set-scheme", dark: true }, origin: ORIGIN }]);
});

test("an app frame draws the layout guide set on it", async () => {
  setup();
  render(<Harness frame={appFrame({ guide: "columns-12" })} />);
  await liveIframe();
  const guide = document.querySelector("[data-design-guide]");
  assert.equal(guide?.getAttribute("data-design-guide"), "columns-12");
  assert.equal(guide?.children.length, 12);
});

test("with live apps off, an app frame doesn't hold the focus guard: a page focus elsewhere is left alone", async () => {
  const frame = appFrame();
  setup();
  render(<Harness frame={frame} designLive={false} composer />);
  screen.getByText("Live apps are off");
  // A stand-in app iframe from elsewhere (the guard acts on any not-entered app iframe).
  const stray = document.createElement("iframe");
  stray.setAttribute("data-app-frame-id", "app-elsewhere");
  document.body.append(stray);
  try {
    screen.getByRole("textbox", { name: "Composer" }).focus();
    stray.focus();
    await settleFocus();
    assert.equal(document.activeElement === stray, true, "no guard answered");
  } finally {
    stray.remove();
  }
});

test("an entered frame whose app restarts is left, and the new page mounts inert", async () => {
  let left = 0;
  const frame = appFrame();
  const { mounts } = setup();
  render(<Harness frame={frame} entered onLeave={() => (left += 1)} />);
  const first = await liveIframe();
  assert.equal(first.hasAttribute("inert"), false);
  act(() => emitBotTestNotification("designApp:status", snapshotOf(app({ origin: "http://127.0.0.1:5174", port: 5174, revision: 9 }))));
  await waitFor(() => assert.equal(mounts().length, 2));
  await waitFor(() => assert.equal(iframes().length === 1 && iframes()[0] !== first, true));
  assert.equal(iframes()[0]!.hasAttribute("inert"), true, "the new page isn't entered");
  assert.ok(left >= 1, "the canvas is told to leave");
});

test("a frame entered while its app isn't running is left at once", async () => {
  let left = 0;
  setup({ apps: [stopped()] });
  render(<Harness frame={appFrame()} entered onLeave={() => (left += 1)} />);
  await screen.findByText("Not running");
  await waitFor(() => assert.ok(left >= 1));
});

// ── Frame actions ──

function nodeContext(update: DesignNodeContextValue["update"]): DesignNodeContextValue {
  return {
    chatId: "chat-1",
    grant: null,
    live: new Set(),
    entered: null,
    versionOf: () => 0,
    frameVersionOf: () => 0,
    autoFocusId: null,
    enter: noop,
    leave: noop,
    openInBrowser: noop,
    markMissing: noop,
    remove: noop,
    update,
    openFullWindow: () => assert.fail("app frames have no full window"),
    download: noop,
    comment: noop,
    moveEnd: noop,
    editing: null,
    edit: noop,
    autoFocusDone: noop,
    pageEditing: null,
    onPageEdit: noop,
    pageEditCommand: noop,
    pageEditFinish: noop,
    pageEditComment: noop,
    renaming: null,
    rename: noop,
  };
}

test("an app frame's actions are the Dark switch and Download as PNG or PDF, with no full window", async () => {
  setup();
  const patches: unknown[] = [];
  const frame = appFrame();
  render(
    <DesignNodeContext.Provider value={nodeContext((_id, patch) => patches.push(patch))}>
      <FrameActions frame={frame} />
    </DesignNodeContext.Provider>,
  );
  assert.equal(screen.queryByRole("button", { name: /full window/u }), null);
  fireEvent.click(screen.getByRole("button", { name: "Show Pricing dark" }));
  assert.deepEqual(patches, [{ colorScheme: "dark" }]);
  const download = screen.getByRole("button", { name: "Download Pricing" });
  fireEvent.pointerDown(download, { button: 0, ctrlKey: false, pointerType: "mouse" });
  const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  assert.deepEqual(items, ["PNG image", "PDF"]);
  assert.equal(screen.queryByText("PDF paper"), null, "paper and layout are a page's");
});

// ── 3b: the variant label (S85) ──

test("3b: a variant's label shows after the title in the frame's header", async () => {
  setup();
  render(<Harness frame={appFrame({ title: "Pricing v2", label: "Calm" })} />);
  assert.ok(screen.getByText("Pricing v2"));
  assert.ok(screen.getByText("Calm"));
});
