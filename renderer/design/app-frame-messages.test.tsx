// Live app frames on the whole canvas (design mode v2 Phase 3a, D16, S75):
// entering and leaving, presenting, the Comment tool's frame-level pin, and
// the v1 page listeners, which must never take an app page's messages as a
// workspace page's.

// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../shared/design-canvas/schema";
import type { DesignAppsSnapshot } from "../shared/design-app";
import { DesignCanvasRegion } from "./design-canvas-region";
import { resetDesignAppChipForTests } from "./design-app-chip";

// The canvas imports React Flow's CSS, which Node cannot load; tests get an empty module.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,export%20default%20%7B%7D", shortCircuit: true };
    return next(specifier, context);
  },
});

const ORIGIN = "http://127.0.0.1:5173";
const WAIT = { timeout: 3000 };
const restoreRect = window.HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  cleanup();
  window.HTMLElement.prototype.getBoundingClientRect = restoreRect;
});

const appFrame: DesignFrame = {
  id: "a1",
  kind: "app",
  title: "Pricing app",
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
};
const page: DesignFrame = {
  id: "f1",
  kind: "file",
  title: "Hero",
  x: 700,
  y: 0,
  w: 640,
  h: 436,
  path: "design/hero.html",
  designWidth: 1280,
  pageId: "page-1",
  createdBy: "aiden",
};

const running: DesignAppsSnapshot = {
  workspaceId: "workspace-1",
  target: "single",
  apps: [
    { workspaceId: "workspace-1", appRoot: ".", source: "started", frameworkLabel: "Vite", phase: "running", since: 1, origin: ORIGIN, port: 5173, revision: 2 },
  ],
  candidates: [],
  chosen: [],
};

function setup(doc: DesignCanvas): { calls: BotTestIpcCall[]; saved: () => DesignCanvas | undefined } {
  resetDesignAppChipForTests();
  let revision = doc.revision;
  const calls = installBotTestIpc({
    "designCanvas:get": () => doc,
    "designCanvas:save": () => ({ ok: true, revision: (revision += 1) }),
    "designCanvas:grant": () => ({ grant: "b".repeat(52) }),
    "designCanvas:watch": () => undefined,
    "designCanvas:capture": () => ({ error: "unavailable" }),
    "designCanvas:view:get": () => null,
    "designCanvas:view": () => undefined,
    "designCanvas:appFrameMount": () => ({ origin: ORIGIN }),
    "designApp:status:get": () => running,
  });
  const saved = () => {
    const saves = calls.filter((call) => call.channel === "designCanvas:save");
    return saves[saves.length - 1]?.args[1] as DesignCanvas | undefined;
  };
  return { calls, saved };
}

function measureCanvasAt1000x800() {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON: () => ({}) } as DOMRect;
  };
}

async function mount() {
  // Frames go live only inside a measured view.
  measureCanvasAt1000x800();
  render(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true, designLive: true }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DesignCanvasRegion chatId="chat-1" workspaceId="workspace-1" width={1000} placement="split" hidden={false} />
      </QueryClientProvider>
    </AppCapabilitiesProvider>,
  );
  await waitFor(() => assert.equal(screen.queryByRole("status", { name: "Loading canvas" }) === null, true), WAIT);
  const region = screen.getByRole("region", { name: "Design canvas" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return region;
}

const appIframe = () => document.querySelector<HTMLIFrameElement>("iframe[data-app-frame-id]");
async function liveAppIframe() {
  return waitFor(() => {
    const element = appIframe();
    assert.ok(element, "the app frame is live");
    return element;
  }, WAIT);
}

/** happy-dom loads no pages; the stand-in window records what is posted to it. */
function giveWindow(iframe: HTMLIFrameElement) {
  const posted: unknown[] = [];
  const guest = { postMessage: (data: unknown) => posted.push(data) } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => guest });
  return { guest, posted };
}

test("double-click or Enter enters an app frame; the page's Esc or the canvas's leaves it inert, with keys back on the canvas", async () => {
  setup({ ...emptyDesignCanvas(), revision: 1, frames: [appFrame] });
  const region = await mount();
  const iframe = await liveAppIframe();
  assert.equal(iframe.hasAttribute("inert"), true);

  fireEvent.doubleClick(screen.getByRole("group", { name: "Pricing app" }));
  await waitFor(() => assert.equal(appIframe()!.hasAttribute("inert"), false));
  // Esc inside the entered page reaches the canvas through the bridge.
  const { guest } = giveWindow(appIframe()!);
  act(() => window.dispatchEvent(new window.MessageEvent("message", { data: { type: "aiden-app:escape" }, source: guest, origin: ORIGIN })));
  await waitFor(() => assert.equal(appIframe()!.hasAttribute("inert"), true));
  assert.equal(document.activeElement === region, true, "the next key goes to the canvas");

  fireEvent.click(screen.getByRole("group", { name: "Pricing app" }));
  region.focus();
  fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
  await waitFor(() => assert.equal(appIframe()!.hasAttribute("inert"), false));
  fireEvent.keyDown(region, { key: "Escape", code: "Escape" });
  await waitFor(() => assert.equal(appIframe()!.hasAttribute("inert"), true));
});

test("while presenting, an app frame stays inert and the arrows still step the presentation", async () => {
  const note: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 0, y: 600, w: 240, h: 160, text: "hi", pageId: "page-1", createdBy: "person" };
  setup({ ...emptyDesignCanvas(), revision: 1, frames: [appFrame, note] });
  const region = await mount();
  await liveAppIframe();
  fireEvent.click(screen.getByRole("button", { name: "Present this page" }));
  const bar = await screen.findByRole("toolbar", { name: "Presentation" });
  assert.equal(appIframe()?.hasAttribute("inert") ?? true, true, "presenting doesn't enter the app");
  assert.ok(bar.textContent?.includes("1 of 2"));
  region.focus();
  fireEvent.keyDown(region, { key: "ArrowRight", code: "ArrowRight" });
  await waitFor(() => assert.ok(screen.getByRole("toolbar", { name: "Presentation" }).textContent?.includes("2 of 2")));
});

test("the Comment tool pins a comment to an app frame with no element anchor", async () => {
  const { saved } = setup({ ...emptyDesignCanvas(), revision: 1, frames: [appFrame] });
  await mount();
  await liveAppIframe();
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  fireEvent.click(screen.getByRole("group", { name: "Pricing app" }).closest(".react-flow__node")!, { clientX: 140, clientY: 150 });
  await screen.findByRole("dialog", { name: "New comment" });
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Bigger price" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Send to Aiden" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(saved()?.comments.length, 1), WAIT);
  const comment = saved()!.comments[0]!;
  assert.equal(comment.frameId, "a1");
  assert.equal(comment.anchor, undefined, "a frame-level pin: Phase 4 anchors elements on app frames");
});

test("a v1 page message from an app frame's window is never taken as a workspace page's", async () => {
  const anchored = {
    commentId: "c1",
    selector: "h1",
    text: "Hero",
    tag: "h1",
    rect: { x: 0, y: 0, w: 100, h: 40 },
    point: [10, 10] as [number, number],
  };
  const doc: DesignCanvas = {
    ...emptyDesignCanvas(),
    revision: 1,
    frames: [appFrame, page],
    comments: [
      { id: "c1", pageId: "page-1", frameId: "f1", x: 10, y: 10, note: "Hero", state: "open", anchorState: "anchored", createdAt: "2026-11-27T10:00:00.000Z", anchor: anchored },
    ],
  };
  setup(doc);
  await mount();
  const app = giveWindow(await liveAppIframe());
  const pageIframe = await waitFor(() => {
    const element = document.querySelector<HTMLIFrameElement>("iframe[data-frame-id]");
    assert.ok(element);
    return element;
  }, WAIT);
  const file = giveWindow(pageIframe);

  // A page that reports in is asked where its comments' elements are now.
  act(() => window.dispatchEvent(new window.MessageEvent("message", { data: { type: "aiden-design:ready", docHeight: 800 }, source: app.guest, origin: ORIGIN })));
  assert.deepEqual(app.posted, [], "the app page is not asked to locate anything");
  assert.deepEqual(file.posted, []);

  act(() => window.dispatchEvent(new window.MessageEvent("message", { data: { type: "aiden-design:ready", docHeight: 800 }, source: file.guest })));
  await waitFor(() =>
    assert.ok(
      file.posted.some((message) => (message as { type?: string }).type === "aiden-design:locate"),
      "the workspace page is (the control)",
    ),
  );
  assert.equal(
    app.posted.some((message) => String((message as { type?: string }).type).startsWith("aiden-design:")),
    false,
  );
});

test("an app frame entered while presenting is left when the presentation steps on, and the canvas's click leaves it too", async () => {
  const note: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 0, y: 600, w: 240, h: 160, text: "hi", pageId: "page-1", createdBy: "person" };
  setup({ ...emptyDesignCanvas(), revision: 1, frames: [appFrame, note] });
  const region = await mount();
  await liveAppIframe();
  fireEvent.click(screen.getByRole("button", { name: "Present this page" }));
  await screen.findByRole("toolbar", { name: "Presentation" });
  fireEvent.doubleClick(screen.getByRole("group", { name: "Pricing app" }));
  await waitFor(() => assert.equal(appIframe()?.hasAttribute("inert"), false), WAIT);
  region.focus();
  fireEvent.keyDown(region, { key: "ArrowRight", code: "ArrowRight" });
  await waitFor(() => assert.ok(screen.getByRole("toolbar", { name: "Presentation" }).textContent?.includes("2 of 2")));
  fireEvent.keyDown(region, { key: "ArrowLeft", code: "ArrowLeft" });
  await waitFor(() => assert.ok(screen.getByRole("toolbar", { name: "Presentation" }).textContent?.includes("1 of 2")));
  await liveAppIframe();
  assert.equal(appIframe()!.hasAttribute("inert"), true, "back on the slide, the app isn't entered");

  fireEvent.doubleClick(screen.getByRole("group", { name: "Pricing app" }));
  await waitFor(() => assert.equal(appIframe()?.hasAttribute("inert"), false), WAIT);
  const pane = document.querySelector<HTMLElement>(".react-flow__pane");
  assert.ok(pane, "the canvas pane");
  fireEvent.click(pane);
  await waitFor(() => assert.equal(appIframe()?.hasAttribute("inert"), true), WAIT);
});

test("when the app restarts under an entered frame, the frame is left without taking focus from where the person is typing", async () => {
  setup({ ...emptyDesignCanvas(), revision: 1, frames: [appFrame] });
  await mount();
  const first = await liveAppIframe();
  fireEvent.doubleClick(screen.getByRole("group", { name: "Pricing app" }));
  await waitFor(() => assert.equal(appIframe()!.hasAttribute("inert"), false), WAIT);
  const composer = document.createElement("textarea");
  document.body.append(composer);
  try {
    composer.focus();
    const moved = { ...running, apps: running.apps.map((app) => ({ ...app, origin: "http://127.0.0.1:5174", port: 5174, revision: 9 })) };
    act(() => emitBotTestNotification("designApp:status", moved));
    await waitFor(() => assert.equal(appIframe() !== null && appIframe() !== first, true), WAIT);
    await waitFor(() => assert.equal(appIframe()!.hasAttribute("inert"), true), WAIT);
    assert.equal(document.activeElement === composer, true, "the composer keeps focus");
  } finally {
    composer.remove();
  }
});
