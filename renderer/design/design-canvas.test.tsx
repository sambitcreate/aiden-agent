// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { Toaster } from "../components/ui";
import { isMacPlatform } from "../lib/ghostty-terminal/host-platform";
import { useComposerTypeFocus } from "../lib/use-composer-type-focus";
import { emptyDesignCanvas, type DesignCanvasV1, type DesignFrame } from "../shared/design-canvas/schema";
import { DesignCanvasRegion } from "./design-canvas-region";

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

function canvasWith(...frames: DesignFrame[]): DesignCanvasV1 {
  return { ...emptyDesignCanvas(), revision: 1, frames };
}

function setup(
  doc: DesignCanvasV1,
  extra: Record<string, (...args: unknown[]) => unknown> = {},
): { calls: BotTestIpcCall[]; saved: () => DesignCanvasV1 | undefined } {
  let revision = doc.revision;
  const calls = installBotTestIpc({
    "designCanvas:get": () => doc,
    "designCanvas:save": () => ({ ok: true, revision: (revision += 1) }),
    "designCanvas:grant": () => ({ grant: GRANT }),
    "designCanvas:watch": () => undefined,
    "designCanvas:capture": () => ({ error: "unavailable" }),
    ...extra,
  });
  const saved = () => {
    const saves = calls.filter((call) => call.channel === "designCanvas:save");
    return saves[saves.length - 1]?.args[1] as DesignCanvasV1 | undefined;
  };
  return { calls, saved };
}

/** Every element measures as the 1000 x 800 canvas, so "the view" has a known centre. */
function measureCanvasAt1000x800() {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON: () => ({}) } as DOMRect;
  };
}

async function mount() {
  render(<DesignCanvasRegion chatId="chat-1" width={1000} placement="split" hidden={false} />);
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

test("Add → Note places a note in the middle of the view and puts the cursor in it", async () => {
  measureCanvasAt1000x800();
  const { saved } = setup(canvasWith());
  await mount();
  await chooseAdd("Note");

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
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 0, y: 0, w: 240, h: 160, text: "hello", createdBy: "person" };
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
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 0, y: 0, w: 240, h: 160, text: "hello", createdBy: "person" };
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
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 640, h: 436, path: "design/hero.html", designWidth: 1280, createdBy: "aiden" };
  const sticky: DesignFrame = { id: "n1", kind: "note", title: "Sticky", x: 700, y: 0, w: 240, h: 160, text: "hello", createdBy: "person" };
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
  await chooseAdd("Note");
  assert.ok(await screen.findByText("The canvas couldn't save your latest changes.", {}, SAVE_WAIT));
});

test("Escape leaves an entered frame without leaving design mode", async () => {
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 640, h: 436, path: "design/hero.html", designWidth: 1280, createdBy: "aiden" };
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
  const hero: DesignFrame = { id: "f1", kind: "file", title: "Hero", x: 0, y: 0, w: 640, h: 436, path: "design/hero.html", designWidth: 1280, createdBy: "aiden" };
  const pic: DesignFrame = { id: "i1", kind: "image", title: "Logo", x: 700, y: 0, w: 200, h: 200, path: "assets/logo.png", createdBy: "person" };
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

test("a visual Aiden draws again under the same title replaces the one in its frame", async () => {
  const chart: DesignFrame = { id: "a1", kind: "artifact", title: "Chart", x: 0, y: 0, w: 640, h: 480, mediaId: "m1", createdBy: "aiden" };
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
  act(() => emitBotTestNotification("designCanvas:updated", { chatId: "chat-1", revision: 2 }));
  await waitFor(() => assert.equal(src(), "aiden-genui://preview/m2"), SAVE_WAIT);
  assert.deepEqual(
    calls.filter((call) => call.channel === "chats:htmlArtifactSrcdoc").map((call) => (call.args[0] as { mediaId: string }).mediaId),
    ["m1", "m2"],
  );
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
