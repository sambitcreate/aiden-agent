// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { Toaster } from "../components/ui";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { isMacPlatform } from "../lib/ghostty-terminal/host-platform";
import { useComposerTypeFocus } from "../lib/use-composer-type-focus";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../shared/design-canvas/schema";
import { DesignCanvasRegion } from "./design-canvas-region";
import { designFrameSnapshots } from "./frame-snapshots";
import { designCommentTray, type DesignCommentSend } from "./comment-tray-store";
import { useCanvasFocusRequests } from "./canvas-focus-requests";
import { DESIGN_CANVAS_SAVE_DELAY_MS } from "./use-design-canvas";
import { DESIGN_VIEW_REPORT_DELAY_MS } from "./use-design-view";

// The canvas imports React Flow's CSS, which Node cannot load; tests get an empty module.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,export%20default%20%7B%7D", shortCircuit: true };
    return next(specifier, context);
  },
});

const GRANT = "b".repeat(52);
const SAVE_WAIT = { timeout: 3000 };
const restoreRect = window.HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  cleanup();
  window.HTMLElement.prototype.getBoundingClientRect = restoreRect;
});

function canvasWith(...frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), revision: 1, frames };
}

function setup(
  doc: DesignCanvas,
  extra: Record<string, (...args: unknown[]) => unknown> = {},
): { calls: BotTestIpcCall[]; saved: () => DesignCanvas | undefined } {
  let revision = doc.revision;
  const calls = installBotTestIpc({
    "designCanvas:get": () => doc,
    "designCanvas:save": () => ({ ok: true, revision: (revision += 1) }),
    "designCanvas:grant": () => ({ grant: GRANT }),
    "designCanvas:watch": () => undefined,
    "designCanvas:capture": () => ({ error: "unavailable" }),
    "designCanvas:view:get": () => null,
    "designCanvas:view": () => undefined,
    ...extra,
  });
  const saved = () => {
    const saves = calls.filter((call) => call.channel === "designCanvas:save");
    return saves[saves.length - 1]?.args[1] as DesignCanvas | undefined;
  };
  return { calls, saved };
}

/** Every element measures as the 1000 x 800 canvas, so "the view" has a known centre. */
function measureCanvasAt1000x800() {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON: () => ({}) } as DOMRect;
  };
}

async function mount(options: { designLive?: boolean } = {}) {
  const tree = (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DesignCanvasRegion chatId="chat-1" workspaceId="workspace-1" width={1000} placement="split" hidden={false} />
    </QueryClientProvider>
  );
  render(
    options.designLive === undefined ? (
      tree
    ) : (
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true, designLive: options.designLive }}>{tree}</AppCapabilitiesProvider>
    ),
  );
  // The landmark shows while the canvas loads; wait until the loaded canvas replaces the skeleton.
  await waitFor(() => assert.equal(screen.queryByRole("status", { name: "Loading canvas" }) === null, true), SAVE_WAIT);
  const region = screen.getByRole("region", { name: "Design canvas" });
  // Let the grant and the first live-set pass land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return region;
}

async function chooseAdd(item: string) {
  const trigger = screen.getByRole("button", { name: "Add" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

const commandKey = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };

test("an empty canvas invites a design or a note", async () => {
  setup(canvasWith());
  await mount();
  assert.ok(screen.getByText("Ask Aiden to design something, or add a note."));
});

async function choosePageItem(item: string, role: "menuitem" | "menuitemradio" = "menuitem") {
  const trigger = screen.getByRole("button", { name: /^Page: / });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole(role, { name: item }));
}

test("the Note button places a note in the middle of the view and puts the cursor in it", async () => {
  measureCanvasAt1000x800();
  const { saved } = setup(canvasWith());
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Note" }));

  const field = await screen.findByRole("textbox", { name: "Note text" });
  assert.equal(document.activeElement === field, true, "the cursor is in the new note");
  await waitFor(() => assert.equal(saved()?.frames.length, 1), SAVE_WAIT);
  const note = saved()!.frames[0]!;
  assert.equal(note.kind, "note");
  assert.equal(note.createdBy, "person");
  // Centred: the box's middle is the middle of the 1000 x 800 view at zoom 1.
  assert.equal(note.x + note.w / 2, 500);
  assert.equal(note.y + note.h / 2, 400);
});

test("Add → Group adds an empty group called Group", async () => {
  const { saved } = setup(canvasWith());
  await mount();
  await chooseAdd("Group");
  assert.ok(await screen.findByRole("group", { name: "Group" }));
  await waitFor(() => assert.equal(saved()?.frames[0]?.kind, "group"), SAVE_WAIT);
  assert.equal(saved()!.frames[0]!.title, "Group");
});

test("Add → File… asks for a workspace page and frames the one chosen", async () => {
  const { calls, saved } = setup(canvasWith(), {
    "designCanvas:pickFile": () => ({ path: "design/hero.html" }),
  });
  await mount();
  await chooseAdd("File…");
  await waitFor(() => assert.equal(saved()?.frames.length, 1), SAVE_WAIT);
  assert.deepEqual(
    calls.find((call) => call.channel === "designCanvas:pickFile")?.args,
    ["chat-1", "file"],
  );
  const frame = saved()!.frames[0]!;
  assert.equal(frame.kind, "file");
  assert.equal(frame.path, "design/hero.html");
  assert.equal(frame.title, "hero.html");
});

test("cancelling the file picker adds nothing", async () => {
  const { calls } = setup(canvasWith(), { "designCanvas:pickFile": () => ({ cancelled: true }) });
  await mount();
  await chooseAdd("File…");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  assert.equal(calls.some((call) => call.channel === "designCanvas:save"), false);
});

test("Delete removes the selected frame and Command-Z brings it back", async () => {
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 0, y: 0, w: 240, h: 160, text: "hello", pageId: "page-1", createdBy: "person" };
  setup(canvasWith(sticky));
  const region = await mount();
  fireEvent.click(screen.getByRole("group", { name: "Sticky" }));
  region.focus();
  fireEvent.keyDown(region, { key: "Delete", code: "Delete" });
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Sticky" }) === null, true));

  fireEvent.keyDown(region, { key: "z", code: "KeyZ", ...commandKey });
  assert.ok(await screen.findByRole("group", { name: "Sticky" }));
});

/** The chat's composer beside the canvas, taking stray typing the way the chat pane does. */
function ChatComposer() {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  useComposerTypeFocus(ref);
  return <textarea aria-label="Message" ref={ref} />;
}

test("canvas keys with a printable character stay with the canvas instead of typing into the chat", async () => {
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 0, y: 0, w: 240, h: 160, text: "hello", pageId: "page-1", createdBy: "person" };
  setup(canvasWith(sticky));
  render(<ChatComposer />);
  const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  // happy-dom lays nothing out; the composer counts as on screen, as it is in the app.
  composer.getClientRects = () => [new DOMRect(0, 0, 400, 40)] as unknown as DOMRectList;
  const region = await mount();
  const frame = screen.getByRole("group", { name: "Sticky" }).closest<HTMLElement>(".react-flow__node")!;
  fireEvent.click(frame);
  frame.focus();

  fireEvent.keyDown(frame, { key: "h", code: "KeyH" });
  fireEvent.keyDown(frame, { key: "@", code: "Digit2", shiftKey: true });

  assert.equal(region.getAttribute("data-tool"), "hand", "H picked the hand tool");
  assert.equal(composer.value, "");
  assert.notEqual(document.activeElement, composer);
});

test("Enter on a selected page enters it, so the keyboard reaches what a double-click does", async () => {
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 640, h: 436, path: "design/hero.html", designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 700, y: 0, w: 240, h: 160, text: "hello", pageId: "page-1", createdBy: "person" };
  setup(canvasWith(hero, sticky));
  const region = await mount();
  const entered = () => document.querySelector("iframe")?.parentElement?.classList.contains("nodrag") === true;

  fireEvent.click(screen.getByRole("group", { name: "Sticky" }));
  region.focus();
  fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
  assert.equal(entered(), false, "a note is not a page to enter");

  fireEvent.click(screen.getByRole("group", { name: "Hero" }));
  region.focus();
  fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
  await waitFor(() => assert.equal(entered(), true));
  assert.equal(document.querySelector("iframe")!.getAttribute("tabindex"), "0", "Tab now reaches the page");
});

test("a change the app cannot save says so instead of failing silently", async () => {
  setup(canvasWith(), {
    "designCanvas:save": () => {
      throw new Error("chat is gone");
    },
  });
  render(<Toaster />);
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Note" }));
  assert.ok(await screen.findByText("The canvas couldn't save your latest changes.", {}, SAVE_WAIT));
});

test("Escape leaves an entered frame without leaving design mode", async () => {
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 640, h: 436, path: "design/hero.html", designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const { calls } = setup(canvasWith(hero));
  const region = await mount();
  fireEvent.doubleClick(screen.getByRole("group", { name: "Hero" }));
  const iframe = await waitFor(() => {
    const element = document.querySelector("iframe");
    assert.ok(element);
    return element;
  });
  assert.equal(iframe.parentElement!.classList.contains("nodrag"), true, "entered: the page takes the pointer");

  region.focus();
  fireEvent.keyDown(region, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    const element = document.querySelector("iframe");
    assert.equal(element === null || !element.parentElement!.classList.contains("nodrag"), true);
  });
  assert.equal(calls.some((call) => call.channel === "chats:setDesignMode"), false);
  assert.ok(screen.getByRole("region", { name: "Design canvas" }), "the canvas is still open");
});

test("the canvas watches its pages and reloads one when its file changes", async () => {
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 640, h: 436, path: "design/hero.html", designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const pic: DesignFrame = { id: "i1", kind: "image", title: "Logo", x: 700, y: 0, w: 200, h: 200, path: "assets/logo.png", pageId: "page-1", createdBy: "person" };
  const { calls } = setup(canvasWith(hero, pic));
  await mount();
  await waitFor(() =>
    assert.deepEqual(calls.filter((call) => call.channel === "designCanvas:watch").pop()?.args, [
      "chat-1",
      ["design/hero.html", "assets/logo.png"],
    ]),
  );
  fireEvent.doubleClick(screen.getByRole("group", { name: "Hero" }));
  const src = () => document.querySelector("iframe")?.getAttribute("src");
  await waitFor(() => assert.equal(src(), `aiden-design://${GRANT}/design/hero.html`));

  act(() => emitBotTestNotification("designCanvas:filesChanged", { chatId: "chat-2", paths: ["design/hero.html"] }));
  assert.equal(src(), `aiden-design://${GRANT}/design/hero.html`, "another chat's change is not ours");
  act(() => emitBotTestNotification("designCanvas:filesChanged", { chatId: "chat-1", paths: ["design/hero.html"] }));
  await waitFor(() => assert.equal(src(), `aiden-design://${GRANT}/design/hero.html?v=1`));
  assert.equal(
    screen.getByRole("img", { name: "Logo" }).getAttribute("src"),
    `aiden-design://${GRANT}/assets/logo.png`,
    "an unchanged image keeps its address",
  );
});

test("a text edit written to a file shown twice reloads only the other frame", async () => {
  // Two frames of one file, as ⌘D or Duplicate page leaves them.
  measureCanvasAt1000x800();
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 300, h: 300, path: "design/hero.html", designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const copy: DesignFrame = { ...hero, id: "f2", title: "Hero copy", x: 400 };
  const { calls } = setup(canvasWith(hero, copy), { "designCanvas:editText": () => ({ ok: true }) });
  await mount();
  fireEvent.doubleClick(screen.getByRole("group", { name: "Hero" }));
  const frame = (id: string) => document.querySelector<HTMLIFrameElement>(`iframe[data-frame-id="${id}"]`);
  await waitFor(() => {
    assert.equal(frame("f1")?.getAttribute("src"), `aiden-design://${GRANT}/design/hero.html`);
    assert.equal(frame("f2")?.getAttribute("src"), `aiden-design://${GRANT}/design/hero.html`);
  });

  // happy-dom loads no pages, so the edited frame gets a stand-in window to post from.
  const edited = frame("f1")!;
  const guest = { postMessage: () => undefined } as unknown as Window;
  Object.defineProperty(edited, "contentWindow", { configurable: true, get: () => guest });
  act(() => {
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: guest,
        data: {
          type: "aiden-design:edit-end",
          cancelled: false,
          plain: true,
          changes: [{ before: "Ship faster", after: "Ship sooner" }],
          beforeHtml: "<h1>Ship faster</h1>",
          afterHtml: "<h1>Ship sooner</h1>",
          element: null,
        },
      }),
    );
  });
  await waitFor(() => assert.equal(frame("f2")?.getAttribute("src"), `aiden-design://${GRANT}/design/hero.html?v=1`), SAVE_WAIT);
  assert.deepEqual(calls.find((call) => call.channel === "designCanvas:editText")?.args.slice(0, 2), ["chat-1", "f1"]);
  assert.equal(frame("f1"), edited, "the frame being edited is not replaced");
  assert.equal(edited.getAttribute("src"), `aiden-design://${GRANT}/design/hero.html`, "and keeps the page it shows");

  // A later change of the file reloads both frames.
  act(() => emitBotTestNotification("designCanvas:filesChanged", { chatId: "chat-1", paths: ["design/hero.html"] }));
  await waitFor(() => {
    assert.equal(frame("f1")?.getAttribute("src"), `aiden-design://${GRANT}/design/hero.html?v=2`);
    assert.equal(frame("f2")?.getAttribute("src"), `aiden-design://${GRANT}/design/hero.html?v=2`);
  });
});

test("a page edited in place does not show its picture from before the edit once it stops being live", async () => {
  measureCanvasAt1000x800();
  // A small page and six larger ones: only six frames run a real page, so the
  // small one shows its snapshot unless it is entered.
  const edited: DesignFrame = { id: "kept-1", kind: "file", title: "Hero", x: 0, y: 600, w: 100, h: 100, path: "design/hero.html", designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const others = Array.from({ length: 6 }, (_, index): DesignFrame => ({
    ...edited,
    id: `other-${index}`,
    title: `Other ${index}`,
    path: `design/other-${index}.html`,
    x: (index % 3) * 320,
    y: Math.floor(index / 3) * 260,
    w: 300,
    h: 240,
  }));
  const before = "data:image/png;base64,QkVGT1JF";
  // Taken when the page last left the live set, before the edit.
  designFrameSnapshots.set("kept-1", 0, before);
  const { calls } = setup(canvasWith(edited, ...others), { "designCanvas:editText": () => ({ ok: true }) });
  const region = await mount();
  const picture = () => screen.getByRole("group", { name: "Hero" }).querySelector("img")?.getAttribute("src") ?? null;
  await waitFor(() => assert.equal(picture(), before));

  fireEvent.doubleClick(screen.getByRole("group", { name: "Hero" }));
  const frame = await waitFor(() => {
    const element = document.querySelector<HTMLIFrameElement>('iframe[data-frame-id="kept-1"]');
    assert.ok(element);
    return element;
  });
  const guest = { postMessage: () => undefined } as unknown as Window;
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => guest });
  act(() => {
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: guest,
        data: {
          type: "aiden-design:edit-end",
          cancelled: false,
          plain: true,
          changes: [{ before: "Ship faster", after: "Ship sooner" }],
          beforeHtml: "<h1>Ship faster</h1>",
          afterHtml: "<h1>Ship sooner</h1>",
          element: null,
        },
      }),
    );
  });
  await waitFor(() => assert.equal(calls.some((call) => call.channel === "designCanvas:editText"), true), SAVE_WAIT);
  // The rest of the write is promise callbacks, all run before the next task.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Leaving the page and clearing the selection drops it from the live set.
  region.focus();
  fireEvent.keyDown(region, { key: "Escape", code: "Escape" });
  fireEvent.keyDown(region, { key: "Escape", code: "Escape" });
  // Compared as a boolean: a failed strict assert on the element itself diffs
  // happy-dom's whole inspected iframe against null, which takes long enough
  // that waitFor's interval and timeout never get to run.
  await waitFor(() => assert.equal(document.querySelector('iframe[data-frame-id="kept-1"]') === null, true, "the page left the live set"), SAVE_WAIT);
  // Its capture as it left came back empty, so it has no picture of the edited page yet.
  const hero = screen.getByRole("group", { name: "Hero" });
  assert.equal(picture(), null, "the picture from before the edit is gone");
  assert.ok(within(hero).getByRole("img", { name: "Hero" }), "the frame shows its skeleton instead");

  // Live again, it runs the page, which shows the edit.
  fireEvent.doubleClick(hero);
  await waitFor(() => assert.equal(document.querySelector('iframe[data-frame-id="kept-1"]') === null, false));
});

test("a visual Aiden draws again under the same title replaces the one in its frame", async () => {
  const chart: DesignFrame = { id: "a1", kind: "artifact", title: "Chart", x: 0, y: 0, w: 640, h: 480, mediaId: "m1", pageId: "page-1", createdBy: "aiden" };
  let doc = canvasWith(chart);
  const { calls } = setup(doc, {
    "designCanvas:get": () => doc,
    "chats:htmlArtifactSrcdoc": (input) => {
      const { mediaId } = input as { mediaId: string };
      return { title: "Chart", src: `aiden-genui://preview/${mediaId}` };
    },
  });
  await mount();
  fireEvent.doubleClick(screen.getByRole("group", { name: "Chart" }));
  const src = () => document.querySelector("iframe")?.getAttribute("src");
  await waitFor(() => assert.equal(src(), "aiden-genui://preview/m1"), SAVE_WAIT);

  // Aiden's next reply swaps the frame's media; main saves and announces it.
  doc = { ...doc, revision: 2, frames: [{ ...chart, mediaId: "m2" }] };
  act(() => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-1", revision: 2 }));
  await waitFor(() => assert.equal(src(), "aiden-genui://preview/m2"), SAVE_WAIT);
  assert.deepEqual(
    calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").map((call) => (call.args[0] as { mediaId: string }).mediaId),
    ["m1", "m2"],
  );
});

test("a visual another chat of the workspace made loads through that chat", async () => {
  const chart: DesignFrame = { id: "a1", kind: "artifact", title: "Chart", x: 0, y: 0, w: 640, h: 480, mediaId: "m1", chatId: "chat-a", pageId: "page-1", createdBy: "aiden" };
  const { calls } = setup(canvasWith(chart), {
    "chats:htmlArtifactSrcdoc": (input) => ({ title: "Chart", src: `aiden-genui://preview/${(input as { mediaId: string }).mediaId}` }),
  });
  await mount();
  fireEvent.doubleClick(screen.getByRole("group", { name: "Chart" }));
  await waitFor(() => assert.equal(document.querySelector("iframe")?.getAttribute("src"), "aiden-genui://preview/m1"), SAVE_WAIT);
  assert.deepEqual(
    calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").map((call) => (call.args[0] as { chatId: string }).chatId),
    ["chat-a"],
  );
});

test("a visual whose chat no longer has it says so and can be removed", async () => {
  const chart: DesignFrame = { id: "a1", kind: "artifact", title: "Chart", x: 0, y: 0, w: 640, h: 480, mediaId: "m1", chatId: "chat-gone", pageId: "page-1", createdBy: "aiden" };
  const { calls } = setup(canvasWith(chart), {
    "chats:htmlArtifactSrcdoc": () => undefined,
  });
  await mount();
  fireEvent.doubleClick(screen.getByRole("group", { name: "Chart" }));
  await waitFor(() => assert.ok(screen.getByText("Visual no longer available")), SAVE_WAIT);
  fireEvent.click(screen.getByRole("button", { name: "Remove frame" }));
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Chart" }), null), SAVE_WAIT);
  assert.equal(calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").length, 1, "it does not keep asking");
});

test("Aiden's snapshot request is answered with a picture of the canvas region, and only for this chat", async () => {
  measureCanvasAt1000x800();
  const { calls } = setup(canvasWith(), {
    "designCanvas:capture": () => ({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    "designCanvas:snapshotAnswer": () => true,
  });
  await mount();
  act(() => emitBotTestNotification("designCanvas:snapshot", { requestId: "s0", chatId: "chat-2" }));
  act(() => emitBotTestNotification("designCanvas:snapshot", { requestId: "s1", chatId: "chat-1" }));
  await waitFor(() =>
    assert.deepEqual(
      calls.filter((call) => call.channel === "designCanvas:snapshotAnswer").map((call) => call.args),
      [["s1", "data:image/png;base64,iVBORw0KGgo="]],
    ),
  );
  assert.deepEqual(calls.find((call) => call.channel === "designCanvas:capture")?.args, [{ x: 0, y: 0, width: 1000, height: 800 }]);
});

const sticky = (id: string, title: string, pageId = "page-1"): DesignFrame => ({
  id, kind: "note", title, x: 0, y: 0, w: 240, h: 160, text: "", pageId, createdBy: "person",
});

function twoPageCanvas(): DesignCanvas {
  return {
    ...canvasWith(sticky("n1", "On home"), sticky("n2", "On pricing", "p2")),
    pages: [
      { id: "page-1", name: "Home" },
      { id: "p2", name: "Pricing" },
    ],
  };
}

const viewReports = (calls: BotTestIpcCall[]) =>
  calls
    .filter((call) => call.channel === "designCanvas:view")
    .map((call) => call.args[1] as { view?: { pageId: string }; focusId?: number; workspaceId?: string });
const lastViewReport = (calls: BotTestIpcCall[]) => viewReports(calls)[viewReports(calls).length - 1];

test("the canvas shows one page at a time; switching pages moves only this chat's view, saves nothing and is no undo step", async () => {
  const { calls } = setup(twoPageCanvas());
  const region = await mount();
  assert.ok(screen.getByRole("group", { name: "On home" }));
  assert.equal(screen.queryByRole("group", { name: "On pricing" }), null);
  assert.ok(screen.getByRole("button", { name: "Page: Home" }));

  await choosePageItem("Pricing", "menuitemradio");
  assert.ok(await screen.findByRole("group", { name: "On pricing" }));
  assert.equal(screen.queryByRole("group", { name: "On home" }), null);
  assert.ok(screen.getByRole("button", { name: "Page: Pricing" }));
  // Main hears the chat's page; the shared canvas is not saved.
  await waitFor(() => assert.equal(lastViewReport(calls)?.view?.pageId, "p2"), SAVE_WAIT);
  assert.equal(lastViewReport(calls)?.workspaceId, "workspace-1");
  region.focus();
  fireEvent.keyDown(region, { key: "z", code: "KeyZ", ...commandKey });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DESIGN_CANVAS_SAVE_DELAY_MS + 100));
  });
  // A canvas an earlier test closed may still flush its own edits here; none of this canvas's are saved.
  const savesOfThisCanvas = calls.filter(
    (call) => call.channel === "designCanvas:save" && (call.args[1] as DesignCanvas).pages.some((page) => page.id === "p2"),
  );
  assert.equal(savesOfThisCanvas.length, 0, "nothing was saved");
  assert.ok(screen.getByRole("button", { name: "Page: Pricing" }), "undo does not take the page switch back");
});

test("the canvas opens on the chat's kept page, and on the first page when that page no longer exists", async () => {
  setup(twoPageCanvas(), {
    "designCanvas:view:get": () => ({ pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} }),
  });
  await mount();
  assert.ok(screen.getByRole("button", { name: "Page: Pricing" }));
  cleanup();

  setup(twoPageCanvas(), {
    "designCanvas:view:get": () => ({ pageId: "deleted", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} }),
  });
  await mount();
  assert.ok(screen.getByRole("button", { name: "Page: Home" }));
  assert.ok(screen.getByRole("group", { name: "On home" }));
});

test("Aiden's focus on frames of another page shows that page; a counted focus naming no page finds its frames' page", async () => {
  const { calls } = setup(twoPageCanvas());
  await mount();
  act(() => emitBotTestNotification("designCanvas:focus", { chatId: "chat-1", pageId: "p2", frameIds: ["n2"], focusId: 2 }));
  assert.ok(await screen.findByRole("button", { name: "Page: Pricing" }));
  await waitFor(() => assert.equal(lastViewReport(calls)?.focusId, 2, "the report says the canvas has seen Aiden's page change"), SAVE_WAIT);

  act(() => emitBotTestNotification("designCanvas:focus", { chatId: "chat-1", frameIds: ["n1"], focusId: 3 }));
  assert.ok(await screen.findByRole("button", { name: "Page: Home" }));
  assert.ok(await screen.findByRole("group", { name: "On home" }));
});

test("a fit main did not count never takes the canvas back to a page a later page change left", async () => {
  const { calls } = setup(twoPageCanvas());
  await mount();
  // Aiden shows Pricing; then a fit for frames placed earlier on Home arrives late.
  act(() => emitBotTestNotification("designCanvas:focus", { chatId: "chat-1", pageId: "p2", frameIds: ["n2"], focusId: 2 }));
  assert.ok(await screen.findByRole("button", { name: "Page: Pricing" }));
  act(() => emitBotTestNotification("designCanvas:focus", { chatId: "chat-1", pageId: "page-1", frameIds: ["n1"] }));
  // A late fit that names only its frames is held to the page on screen too.
  act(() => emitBotTestNotification("designCanvas:focus", { chatId: "chat-1", frameIds: ["n1"] }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DESIGN_VIEW_REPORT_DELAY_MS + 100));
  });
  assert.ok(screen.getByRole("button", { name: "Page: Pricing" }), "the canvas stays on Pricing");
  // Main hears Pricing with Aiden's change, never Home.
  await waitFor(() => assert.equal(lastViewReport(calls)?.focusId, 2), SAVE_WAIT);
  assert.equal(lastViewReport(calls)?.view?.pageId, "p2");
  assert.equal(viewReports(calls).some((report) => report.view?.pageId === "page-1" && report.focusId === 2), false);
});

test("Aiden's page change applies even when the person just moved the canvas and its frames are not fitted", async () => {
  const { calls } = setup(twoPageCanvas());
  const region = await mount();
  // The person is working on the canvas, so Aiden does not take the view away by fitting.
  fireEvent.pointerDown(region);
  act(() => emitBotTestNotification("designCanvas:focus", { chatId: "chat-1", pageId: "p2", frameIds: ["n2"], focusId: 5 }));
  assert.ok(await screen.findByRole("button", { name: "Page: Pricing" }));
  await waitFor(() => assert.equal(lastViewReport(calls)?.focusId, 5), SAVE_WAIT);
});

test("a page change Aiden sent before the canvas loaded still shows its page, even once too old to fit its frames", async () => {
  const { calls } = setup(twoPageCanvas());
  // The chat area keeps focus requests while the canvas is still loading.
  function ChatArea() {
    useCanvasFocusRequests(true);
    return null;
  }
  render(<ChatArea />);
  const now = Date.now;
  Date.now = () => now() - 60_000;
  try {
    act(() => emitBotTestNotification("designCanvas:focus", { chatId: "chat-1", pageId: "p2", frameIds: ["n2"], focusId: 7 }));
  } finally {
    Date.now = now;
  }
  await mount();
  assert.ok(await screen.findByRole("button", { name: "Page: Pricing" }));
  await waitFor(() => assert.equal(lastViewReport(calls)?.focusId, 7), SAVE_WAIT);
  assert.equal(lastViewReport(calls)?.view?.pageId, "p2");
});

test("each chat of the workspace keeps its own page: A shows Pricing, B opens on Home, and A comes back to Pricing", async () => {
  const kept = new Map<string, { pageId: string; viewport: { x: number; y: number; zoom: number } }>();
  setup(twoPageCanvas(), {
    "designCanvas:view": (chatId, report) => {
      const { view } = report as { view?: { pageId: string; viewport: { x: number; y: number; zoom: number } } };
      if (view) kept.set(chatId as string, view);
    },
    "designCanvas:view:get": (chatId) => {
      const view = kept.get(chatId as string);
      return view ? { ...view, focusId: 0, viewports: { [view.pageId]: view.viewport } } : null;
    },
  });
  const region = (chatId: string) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DesignCanvasRegion chatId={chatId} workspaceId="workspace-1" width={1000} placement="split" hidden={false} />
    </QueryClientProvider>
  );
  const shown = render(region("chat-a"));
  assert.ok(await screen.findByRole("button", { name: "Page: Home" }));
  await choosePageItem("Pricing", "menuitemradio");
  assert.ok(await screen.findByRole("group", { name: "On pricing" }));

  // Switching chats sends A's last change before B's canvas reads its own view.
  shown.rerender(region("chat-b"));
  await waitFor(() => assert.equal(kept.get("chat-a")?.pageId, "p2"), SAVE_WAIT);
  assert.ok(await screen.findByRole("group", { name: "On home" }), "B opens on the first page");

  shown.rerender(region("chat-a"));
  assert.ok(await screen.findByRole("group", { name: "On pricing" }), "A is back on its page");
  assert.ok(screen.getByRole("button", { name: "Page: Pricing" }));
});

test("when another chat deletes the page on screen, the canvas goes back to the page it showed before", async () => {
  let doc = twoPageCanvas();
  setup(doc, { "designCanvas:get": () => doc });
  await mount();
  await choosePageItem("Pricing", "menuitemradio");
  assert.ok(await screen.findByRole("group", { name: "On pricing" }));

  doc = { ...doc, revision: doc.revision + 1, pages: doc.pages.filter((page) => page.id !== "p2"), frames: doc.frames.filter((frame) => frame.pageId !== "p2") };
  act(() => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-2", revision: doc.revision }));
  assert.ok(await screen.findByRole("group", { name: "On home" }, SAVE_WAIT));
  assert.ok(screen.getByRole("button", { name: "Page: Home" }));
});

test("when another chat deletes the page on screen, the canvas shows this chat's claim", async () => {
  const base = twoPageCanvas();
  let doc: DesignCanvas = {
    ...base,
    pages: [...base.pages, { id: "p3", name: "Ideas" }],
    frames: [...base.frames, sticky("n3", "On ideas", "p3")],
    chatPages: { "chat-1": "p3" },
  };
  setup(doc, { "designCanvas:get": () => doc });
  await mount();
  assert.ok(screen.getByRole("button", { name: "Page: Ideas" }), "with no kept view, the canvas opens on the claim");
  await choosePageItem("Pricing", "menuitemradio");
  assert.ok(await screen.findByRole("group", { name: "On pricing" }));

  doc = { ...doc, revision: doc.revision + 1, pages: doc.pages.filter((page) => page.id !== "p2"), frames: doc.frames.filter((frame) => frame.pageId !== "p2") };
  act(() => emitBotTestNotification("designCanvas:updated", { workspaceId: "workspace-1", chatId: "chat-2", revision: doc.revision }));
  assert.ok(await screen.findByRole("group", { name: "On ideas" }, SAVE_WAIT));
  assert.ok(screen.getByRole("button", { name: "Page: Ideas" }));
});

test("the page picker marks this chat's page and counts other chats on theirs", async () => {
  const doc: DesignCanvas = {
    ...canvasWith(),
    pages: [
      { id: "page-1", name: "Home" },
      { id: "p2", name: "Pricing" },
      { id: "p3", name: "Ideas" },
      { id: "p4", name: "Shared" },
      { id: "p5", name: "Empty" },
    ],
    chatPages: { "chat-1": "p4", "chat-2": "page-1", "chat-3": "p2", "chat-4": "p2", "chat-5": "p4", "chat-6": "p4" },
  };
  setup(doc);
  await mount();
  const trigger = screen.getByRole("button", { name: /^Page: / });
  assert.equal(trigger.getAttribute("aria-label"), "Page: Shared", "the trigger names only the page");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  await screen.findByRole("menuitemradio", { name: /^Home/u });
  assert.deepEqual(
    screen.getAllByRole("menuitemradio").map((row) => row.getAttribute("aria-label") ?? row.textContent),
    ["Home, 1 chat", "Pricing, 2 chats", "Ideas", "Shared, This chat · 2 more", "Empty"],
  );
  for (const name of ["Home, 1 chat", "Pricing, 2 chats", "Ideas", "Shared, This chat · 2 more"]) {
    assert.ok(screen.getByRole("menuitemradio", { name }), name);
  }
  assert.equal(screen.queryByText(/chat-\d/u), null, "no other chat is named");
});

test("the page picker reads This chat on a page only this chat uses", async () => {
  setup({ ...twoPageCanvas(), chatPages: { "chat-1": "p2" } });
  await mount();
  await choosePageItem("Pricing, This chat", "menuitemradio");
  assert.ok(await screen.findByRole("button", { name: "Page: Pricing" }), "choosing the marked row still shows the page");
});

test("a new page starts empty and is shown; deleting it can be undone from the toast", async () => {
  const { saved } = setup(canvasWith(sticky("n1", "On home")));
  render(<Toaster />);
  await mount();
  await choosePageItem("New page");
  assert.ok(await screen.findByRole("button", { name: "Page: Page 2" }));
  assert.equal(screen.queryByRole("group", { name: "On home" }), null);
  await waitFor(() => assert.deepEqual(saved()?.pages.map((page) => page.name), ["Page 1", "Page 2"]), SAVE_WAIT);

  await choosePageItem("Page 1", "menuitemradio");
  assert.ok(await screen.findByRole("group", { name: "On home" }));
  await choosePageItem("Delete page");
  assert.ok(await screen.findByRole("button", { name: "Page: Page 2" }), "the page after it is shown");
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  assert.ok(await screen.findByRole("group", { name: "On home" }), "the page and its note are back");
  assert.ok(screen.getByRole("button", { name: "Page: Page 1" }));
});

test("undoing a new page goes back to the page it was added from, not the first", async () => {
  setup(twoPageCanvas());
  const region = await mount();
  await choosePageItem("Pricing", "menuitemradio");
  assert.ok(await screen.findByRole("group", { name: "On pricing" }));
  await choosePageItem("New page");
  assert.ok(await screen.findByRole("button", { name: "Page: Page 3" }));
  region.focus();
  fireEvent.keyDown(region, { key: "z", code: "KeyZ", ...commandKey });
  assert.ok(await screen.findByRole("button", { name: "Page: Pricing" }));
  assert.ok(screen.getByRole("group", { name: "On pricing" }));
});

test("Rename page… names the page on screen", async () => {
  const { saved } = setup(canvasWith());
  await mount();
  await choosePageItem("Rename page…");
  const field = await screen.findByRole("textbox", { name: "Page name" });
  fireEvent.change(field, { target: { value: "  Checkout  " } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  assert.ok(await screen.findByRole("button", { name: "Page: Checkout" }));
  await waitFor(() => assert.equal(saved()?.pages[0]?.name, "Checkout"), SAVE_WAIT);
});

test("double-clicking a frame's title renames it; Escape keeps the old name and F2 starts again", async () => {
  const { saved } = setup(canvasWith(sticky("n1", "Sticky")));
  const region = await mount();
  fireEvent.doubleClick(screen.getByText("Sticky"));
  let field = await screen.findByRole("textbox", { name: "Frame name" });
  fireEvent.change(field, { target: { value: "Ideas" } });
  fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
  assert.ok(await screen.findByRole("group", { name: "Sticky" }), "Escape keeps the old name");

  fireEvent.click(screen.getByRole("group", { name: "Sticky" }));
  region.focus();
  fireEvent.keyDown(region, { key: "F2", code: "F2" });
  field = await screen.findByRole("textbox", { name: "Frame name" });
  fireEvent.change(field, { target: { value: "Ideas" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
  assert.ok(await screen.findByRole("group", { name: "Ideas" }));
  await waitFor(() => assert.equal(saved()?.frames[0]?.title, "Ideas"), SAVE_WAIT);

  region.focus();
  fireEvent.keyDown(region, { key: "z", code: "KeyZ", ...commandKey });
  assert.ok(await screen.findByRole("group", { name: "Sticky" }), "the rename is one undo step");
});

test("the comment tool drops a pin on the canvas, and a saved comment waits in the tray for Aiden", async () => {
  measureCanvasAt1000x800();
  const { saved } = setup(canvasWith());
  const region = await mount();
  region.focus();
  fireEvent.keyDown(region, { key: "c", code: "KeyC" });
  assert.equal(screen.getByRole("button", { name: "Comment" }).getAttribute("aria-pressed"), "true", "C turns on the comment tool");

  fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 300, clientY: 200 });
  const box = await screen.findByRole("dialog", { name: "New comment" });
  assert.ok(box.textContent?.includes("Canvas"), "the box says what the comment is attached to");
  const field = screen.getByRole("textbox", { name: "Comment" });
  assert.equal(document.activeElement, field);
  assert.equal((screen.getByRole("checkbox", { name: "Send to Aiden" }) as HTMLElement).getAttribute("aria-checked"), "true");
  fireEvent.change(field, { target: { value: "Add a footer here" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter" });

  await waitFor(() => assert.equal(saved()?.comments.length, 1), SAVE_WAIT);
  const comment = saved()!.comments[0]!;
  assert.deepEqual([comment.x, comment.y, comment.note, comment.queued, comment.frameId], [300, 200, "Add a footer here", true, undefined]);
  assert.ok(await screen.findByRole("button", { name: "Comment 1 on Canvas" }));

  const tray = designCommentTray("chat-1");
  assert.deepEqual(tray?.comments.map((entry) => [entry.label, entry.note]), [["Canvas", "Add a footer here"]]);
  assert.match(tray!.block(), /"note": "Add a footer here"/u);

  let send: DesignCommentSend | null | undefined;
  await act(async () => {
    send = await tray!.markSent([comment.id]);
  });
  // Saved before the message goes, not after the edit debounce, so Aiden's turn finds the comment sent.
  assert.equal(saved()?.comments[0]?.state, "sent", "saved by the time markSent resolves");
  assert.equal(designCommentTray("chat-1"), null, "a sent comment leaves the tray");
  assert.ok(await screen.findByRole("button", { name: "Comment 1 on Canvas, sent to Aiden" }));

  // The send then fails: the comment waits in the tray again.
  act(() => send!.undo());
  assert.deepEqual(designCommentTray("chat-1")?.comments.map((entry) => entry.note), ["Add a footer here"]);
  await waitFor(() => assert.deepEqual([saved()?.comments[0]?.state, saved()?.comments[0]?.queued], ["open", true]), {
    timeout: DESIGN_CANVAS_SAVE_DELAY_MS / 2,
  });
  assert.ok(await screen.findByRole("button", { name: "Comment 1 on Canvas" }));
});

test("when the canvas can't save a comment as sent, the comment stays in the tray and no send goes ahead", async () => {
  measureCanvasAt1000x800();
  let revision = 1;
  let refuse = false;
  const { saved } = setup(canvasWith(), {
    "designCanvas:save": () => (refuse ? { ok: false, reason: "invalid", issues: ["too big"] } : { ok: true, revision: (revision += 1) }),
  });
  const region = await mount();
  region.focus();
  fireEvent.keyDown(region, { key: "c", code: "KeyC" });
  fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 300, clientY: 200 });
  await screen.findByRole("dialog", { name: "New comment" });
  const field = screen.getByRole("textbox", { name: "Comment" });
  fireEvent.change(field, { target: { value: "Add a footer here" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
  await waitFor(() => assert.equal(saved()?.comments.length, 1), SAVE_WAIT);
  const comment = saved()!.comments[0]!;

  refuse = true;
  let send: DesignCommentSend | null | undefined;
  await act(async () => {
    send = await designCommentTray("chat-1")!.markSent([comment.id]);
  });
  assert.equal(send, null, "the composer is told not to send");
  assert.deepEqual(
    designCommentTray("chat-1")?.comments.map((entry) => entry.note),
    ["Add a footer here"],
    "the comment waits in the tray for the next try",
  );
  assert.ok(await screen.findByRole("button", { name: "Comment 1 on Canvas" }), "and is not shown as sent");
});

test("a comment on a frame keeps its spot on the frame; with Send to Aiden off it stays a comment", async () => {
  measureCanvasAt1000x800();
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 100, y: 100, w: 240, h: 160, text: "hello", pageId: "page-1", createdBy: "person" };
  const { saved } = setup(canvasWith(sticky));
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  fireEvent.click(screen.getByRole("group", { name: "Sticky" }).closest(".react-flow__node")!, { clientX: 140, clientY: 150 });
  await screen.findByRole("dialog", { name: "New comment" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Send to Aiden" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Shorter" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => assert.equal(saved()?.comments.length, 1), SAVE_WAIT);
  const comment = saved()!.comments[0]!;
  assert.deepEqual([comment.frameId, comment.x, comment.y, comment.queued], ["n1", 40, 50, undefined]);
  assert.equal(designCommentTray("chat-1"), null);

  // Opening it again shows the note; Escape closes the box, a second Escape leaves the tool.
  fireEvent.click(await screen.findByRole("button", { name: "Comment 1 on Sticky" }));
  const field = await screen.findByRole("textbox", { name: "Comment" });
  assert.equal((field as HTMLTextAreaElement).value, "Shorter");
  fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});

test("removing a frame removes its comments, and undo brings both back", async () => {
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 0, y: 0, w: 240, h: 160, text: "hello", pageId: "page-1", createdBy: "person" };
  const doc = canvasWith(sticky);
  doc.comments = [{ id: "c1", pageId: "page-1", frameId: "n1", x: 10, y: 10, note: "Bigger", state: "open", anchorState: "anchored", createdAt: "2026-11-05T10:00:00.000Z" }];
  setup(doc);
  const region = await mount();
  assert.ok(screen.getByRole("button", { name: "Comment 1 on Sticky" }));
  fireEvent.click(screen.getByRole("group", { name: "Sticky" }));
  region.focus();
  fireEvent.keyDown(region, { key: "Delete", code: "Delete" });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Comment 1 on Sticky" }), null));
  fireEvent.keyDown(region, { key: "z", code: "KeyZ", ...commandKey });
  assert.ok(await screen.findByRole("button", { name: "Comment 1 on Sticky" }));
});

test("All comments lists comments by state, and choosing one shows its page and opens it", async () => {
  measureCanvasAt1000x800();
  const doc = canvasWith();
  doc.pages = [...doc.pages, { id: "p2", name: "Pricing" }];
  const at = "2026-11-05T10:00:00.000Z";
  doc.comments = [
    { id: "c1", pageId: "page-1", x: 10, y: 10, note: "Warmer colours", state: "open", anchorState: "anchored", createdAt: at },
    { id: "c2", pageId: "p2", x: 40, y: 40, note: "Show yearly prices", state: "open", anchorState: "anchored", createdAt: "2026-11-05T11:00:00.000Z", reply: { text: "Should yearly be the default?", at } },
    { id: "c3", pageId: "page-1", x: 0, y: 0, note: "Done already", state: "resolved", anchorState: "anchored", createdAt: at, resolvedAt: at },
  ];
  setup(doc);
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "All comments, 2 open" }));
  const panel = await screen.findByRole("dialog", { name: "All comments" });
  assert.ok(panel.textContent?.includes("Warmer colours"));
  assert.ok(panel.textContent?.includes("Pricing · Canvas"), "with several pages each comment names its page");
  assert.equal(panel.textContent?.includes("Done already"), false);
  fireEvent.click(screen.getByRole("radio", { name: "Resolved" }));
  assert.ok(panel.textContent?.includes("Done already"));
  fireEvent.click(screen.getByRole("radio", { name: "Open" }));

  fireEvent.click(screen.getByRole("button", { name: /Show yearly prices/u }));
  assert.ok(await screen.findByRole("button", { name: "Page: Pricing" }));
  const box = await screen.findByRole("dialog", { name: "Comment" });
  assert.equal((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value, "Show yearly prices");
  assert.ok(within(box).getByRole("region", { name: "Aiden's reply" }).textContent?.includes("Should yearly be the default?"), "Aiden's reply shows under the note");
});

test("the pen in the comment box draws marks over a frame, saved as fractions of it", async () => {
  measureCanvasAt1000x800();
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 100, y: 100, w: 200, h: 100, text: "hello", pageId: "page-1", createdBy: "person" };
  const { saved } = setup(canvasWith(sticky));
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  fireEvent.click(screen.getByRole("group", { name: "Sticky" }).closest(".react-flow__node")!, { clientX: 120, clientY: 120 });
  await screen.findByRole("dialog", { name: "New comment" });
  fireEvent.click(screen.getByRole("button", { name: "Draw marks" }));
  const surface = document.querySelector("[data-design-draw]")!;
  fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 200, clientY: 150 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: 200 });
  fireEvent.pointerUp(surface, { pointerId: 1 });
  assert.ok(screen.getByRole("button", { name: "Clear marks" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Circle this" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => assert.equal(saved()?.comments.length, 1), SAVE_WAIT);
  assert.deepEqual(saved()!.comments[0]!.marks, [{ points: [[0, 0], [0.5, 0.5], [1, 1]] }]);
  assert.equal(document.querySelector("[data-design-draw]"), null, "saving puts the pen away");
});

test("the side panel opens again on the tab it was left on, Tweaks included", async () => {
  setup(canvasWith());
  window.localStorage.setItem("aiden.design.sidePanel", JSON.stringify({ open: true, tab: "tweaks" }));
  try {
    await mount();
    const tweaks = screen.getByRole("radio", { name: "Tweaks" });
    assert.equal(tweaks.getAttribute("aria-checked"), "true");
    assert.ok(screen.getByText("Select a page or an artifact to change how it looks."));
  } finally {
    window.localStorage.removeItem("aiden.design.sidePanel");
  }
});

test("while the canvas can't be saved, the Code tab says so instead of reading an older copy of the page", async () => {
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 640, h: 436, path: "design/hero.html", designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const { calls } = setup(canvasWith(hero), {
    "designCanvas:save": () => {
      throw new Error("chat is gone");
    },
    "designCanvas:source": () => ({ text: "<h1>Hero</h1>", truncated: false }),
  });
  render(<Toaster />);
  window.localStorage.setItem("aiden.design.sidePanel", JSON.stringify({ open: true, tab: "code" }));
  try {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    assert.ok(await screen.findByText("The canvas couldn't save your latest changes.", {}, SAVE_WAIT));

    fireEvent.click(screen.getByRole("group", { name: "Hero" }));
    assert.ok(await screen.findByText("The canvas couldn't be saved, so the code can't be shown yet.", {}, SAVE_WAIT));
    assert.equal(calls.some((call) => call.channel === "designCanvas:source"), false);
  } finally {
    window.localStorage.removeItem("aiden.design.sidePanel");
  }
});

// ── 3c: live app frames' edges and corners (S89) ──

const APP_SNAPSHOT = {
  workspaceId: "workspace-1",
  target: "single",
  apps: [{ workspaceId: "workspace-1", appRoot: ".", source: "started", frameworkLabel: "Vite", phase: "stopped", since: 1, revision: 1 }],
  candidates: [],
  chosen: [],
};

function liveAppFrame(overrides: Partial<DesignFrame> = {}): DesignFrame {
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
    viewport: { width: 1280, height: 800 },
    scale: 0.5,
    ...overrides,
  };
}

async function mountLiveApp(doc: DesignCanvas, extra: Record<string, (...args: unknown[]) => unknown> = {}) {
  const ipc = setup(doc, { "designApp:status:get": () => APP_SNAPSHOT, ...extra });
  const region = await mount({ designLive: true });
  return { ...ipc, region };
}

const mouse = (type: string, target: EventTarget, at: { x: number; y: number } = { x: 10, y: 10 }) =>
  act(() => {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, view: window, clientX: at.x, clientY: at.y }));
  });
const ruler = () => document.querySelector<HTMLElement>(".design-viewport-ruler");
const nextTask = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

async function selectedAppControls() {
  fireEvent.click(screen.getByRole("group", { name: "Pricing" }));
  await waitFor(() => assert.ok(document.querySelector(".react-flow__resize-control.line.right")));
  return (position: string) => document.querySelector<HTMLElement>(`.react-flow__resize-control.${position}`)!;
}

test("3c: a press on a resize control without a drag leaves no resize mode", async () => {
  await mountLiveApp(canvasWith(liveAppFrame()));
  const control = await selectedAppControls();
  mouse("mousedown", control("line.right"));
  assert.equal(ruler()?.dataset.side, "right", "the readout shows while the control is held");
  mouse("mouseup", window);
  // xyflow sends nothing for a press that never moved; the canvas clears the mode a task later.
  await nextTask();
  assert.equal(ruler(), null);
});

test("3c: a real drag clears its mode on the final change, not on a timer", async () => {
  const { saved } = await mountLiveApp(canvasWith(liveAppFrame()));
  const control = await selectedAppControls();
  mouse("mousedown", control("line.right"), { x: 640, y: 200 });
  mouse("mousemove", window, { x: 600, y: 200 });
  mouse("mouseup", window, { x: 600, y: 200 });
  assert.equal(ruler(), null, "cleared before any timer ran");
  await waitFor(() => {
    const app = saved()?.frames.find((frame) => frame.id === "app-1");
    assert.ok(app);
    assert.equal(app.scale, 0.5, "an edge keeps the scale");
    assert.notEqual(app.viewport?.width, 1280, "and changes the viewport");
  }, SAVE_WAIT);
});

test("3c: a new resize started before the timer fires keeps its mode", async () => {
  await mountLiveApp(canvasWith(liveAppFrame()));
  const control = await selectedAppControls();
  mouse("mousedown", control("line.right"));
  mouse("mouseup", window);
  mouse("mousedown", control("line.left"));
  await nextTask();
  assert.equal(ruler()?.dataset.side, "left", "the first press's timer leaves the second resize alone");
  mouse("mouseup", window);
  await nextTask();
  assert.equal(ruler(), null);
});

// ── 3c: the device menu (S92) ──

async function chooseDevice(name: RegExp | string) {
  const trigger = screen.getByRole("button", { name: /^Viewport/u });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

test("3c: choosing iPad sets 768 × 1024, keeps the scale, and ⌘Z puts it back", async () => {
  const { saved, region } = await mountLiveApp(canvasWith(liveAppFrame()));
  await chooseDevice(/iPad/u);
  await waitFor(() => {
    const app = saved()?.frames.find((frame) => frame.id === "app-1");
    assert.deepEqual(app?.viewport, { width: 768, height: 1024 });
    assert.equal(app?.scale, 0.5);
    assert.deepEqual({ w: app?.w, h: app?.h }, { w: 384, h: 548 });
  }, SAVE_WAIT);
  region.focus();
  fireEvent.keyDown(region, { key: "z", code: "KeyZ", ...commandKey });
  await waitFor(() => assert.deepEqual(saved()?.frames.find((frame) => frame.id === "app-1")?.viewport, { width: 1280, height: 800 }), SAVE_WAIT);
});

test("3c: a grouped frame changed to Desktop still fits its group", async () => {
  const group: DesignFrame = { id: "g", kind: "group", title: "Set", pageId: "page-1", x: -32, y: -48, w: 704, h: 516, createdBy: "person" };
  const { saved } = await mountLiveApp(canvasWith(group, liveAppFrame({ groupId: "g" })));
  await chooseDevice(/Desktop/u);
  await waitFor(() => {
    const doc = saved();
    const app = doc?.frames.find((frame) => frame.id === "app-1");
    const box = doc?.frames.find((frame) => frame.id === "g");
    assert.deepEqual(app?.viewport, { width: 1440, height: 900 });
    assert.ok(app && box);
    assert.ok(box.x <= app.x && app.x + app.w <= box.x + box.w, "the group holds the wider frame");
    assert.ok(box.y <= app.y && app.y + app.h <= box.y + box.h, "and the taller one");
  }, SAVE_WAIT);
});
