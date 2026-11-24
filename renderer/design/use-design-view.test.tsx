// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, render } from "@testing-library/react";
import { emptyDesignCanvas, type DesignCanvas } from "../shared/design-canvas/schema";
import { DesignPaneContext, type DesignPane } from "./design-pane";
import { DESIGN_VIEW_REPORT_DELAY_MS, useDesignView, type DesignViewHandle } from "./use-design-view";

type Kept = {
  pageId: string;
  viewport: { x: number; y: number; zoom: number };
  focusId: number;
  viewports: Record<string, { x: number; y: number; zoom: number }>;
};

const doc: DesignCanvas = {
  ...emptyDesignCanvas(),
  pages: [
    { id: "page-1", name: "Page 1" },
    { id: "p2", name: "Pricing" },
    { id: "p3", name: "Ideas" },
  ],
};

let calls: BotTestIpcCall[];
let kept: Kept | null;
let view: DesignViewHandle;

function Probe({ workspaceId = "ws-1", chatId = "chat-1", canvas = doc }: { workspaceId?: string; chatId?: string; canvas?: DesignCanvas }) {
  view = useDesignView(workspaceId, chatId, canvas);
  return null;
}

const reports = () => calls.filter((call) => call.channel === "designCanvas:view").map((call) => call.args);
const lastReport = () => reports()[reports().length - 1];
async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => {});
}
async function tick(ms: number) {
  await act(async () => {
    mock.timers.tick(ms);
  });
  await settle();
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  kept = null;
  calls = installBotTestIpc({
    "designCanvas:view:get": () => structuredClone(kept),
    "designCanvas:view": () => undefined,
  });
});

afterEach(() => {
  cleanup();
  mock.timers.reset();
});

test("the canvas opens on the chat's kept page where it was left, and reports that it is open", async () => {
  kept = { pageId: "p2", viewport: { x: 40, y: 0, zoom: 2 }, focusId: 3, viewports: { p2: { x: 40, y: 0, zoom: 2 } } };
  render(<Probe />);
  await settle();
  assert.equal(view.loaded, true);
  assert.equal(view.pageId, "p2");
  assert.deepEqual(view.viewport, { x: 40, y: 0, zoom: 2 });
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.deepEqual(reports(), [
    ["chat-1", { workspaceId: "ws-1", view: { pageId: "p2", viewport: { x: 40, y: 0, zoom: 2 } }, focusId: 3, visible: true }],
  ]);
});

test("shows the first page at the fresh viewport when the kept page no longer exists, or main keeps none", async () => {
  kept = { pageId: "deleted", viewport: { x: 40, y: 0, zoom: 2 }, focusId: 0, viewports: { deleted: { x: 40, y: 0, zoom: 2 } } };
  const first = render(<Probe />);
  await settle();
  assert.equal(view.pageId, "page-1");
  assert.deepEqual(view.viewport, { x: 0, y: 0, zoom: 1 });
  first.unmount();

  kept = null;
  render(<Probe chatId="chat-2" />);
  await settle();
  assert.equal(view.loaded, true);
  assert.equal(view.pageId, "page-1");
});

test("page switches, pans and size changes are reported once, 250 ms after the last, and never save the canvas", async () => {
  kept = { pageId: "page-1", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: { p3: { x: -300, y: 10, zoom: 0.5 } } };
  render(<Probe />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  const opened = reports().length;

  await act(async () => view.moved({ x: 5, y: 5, zoom: 1 }));
  await act(async () => view.showPage("p3"));
  // A page opens where the chat last looked at it.
  assert.deepEqual(view.viewport, { x: -300, y: 10, zoom: 0.5 });
  await act(async () => view.moved({ x: -320, y: 10, zoom: 0.5 }));
  await act(async () => view.setSize({ w: 900, h: 600 }));
  await tick(DESIGN_VIEW_REPORT_DELAY_MS - 1);
  assert.equal(reports().length, opened, "still inside the debounce");
  await tick(1);
  assert.deepEqual(reports().slice(opened), [
    ["chat-1", { workspaceId: "ws-1", view: { pageId: "p3", viewport: { x: -320, y: 10, zoom: 0.5 }, size: { w: 900, h: 600 } }, focusId: 0, visible: true }],
  ]);
  // Back on the first page, the earlier pan is still where it was.
  await act(async () => view.showPage("page-1"));
  assert.deepEqual(view.viewport, { x: 5, y: 5, zoom: 1 });
  assert.equal(calls.filter((call) => call.channel === "designCanvas:save").length, 0, "a view change is not a document change");
});

test("leaving within 250 ms sends the last change first, then says the canvas closed", async () => {
  kept = { pageId: "page-1", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} };
  const mounted = render(<Probe />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  const opened = reports().length;
  await act(async () => view.showPage("p2"));
  mounted.unmount();
  await settle();
  assert.deepEqual(reports().slice(opened), [
    ["chat-1", { workspaceId: "ws-1", view: { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 } }, focusId: 0, visible: true }],
    ["chat-1", { mounted: false }],
  ]);
});

test("Aiden's page change is applied and its focusId echoed; an older one is ignored", async () => {
  kept = { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 3, viewports: {} };
  render(<Probe />);
  await settle();
  await act(async () => view.applyFocus({ pageId: "p3", focusId: 4 }));
  assert.equal(view.pageId, "p3");
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.deepEqual(lastReport(), ["chat-1", { workspaceId: "ws-1", view: { pageId: "p3", viewport: { x: 0, y: 0, zoom: 1 } }, focusId: 4, visible: true }]);

  await act(async () => view.applyFocus({ pageId: "p2", focusId: 2 }));
  assert.equal(view.pageId, "p3", "a page change older than one already seen is ignored");
  // A placement's focus names the page it landed on without a new focusId.
  await act(async () => view.applyFocus({ pageId: "page-1" }));
  assert.equal(view.pageId, "page-1");
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.equal((lastReport()?.[1] as { focusId: number }).focusId, 4);
});

test("when the page on screen goes (an added page undone), the chat goes back to the page it showed before, not the first", async () => {
  kept = { pageId: "p2", viewport: { x: 40, y: 0, zoom: 2 }, focusId: 0, viewports: { p2: { x: 40, y: 0, zoom: 2 } } };
  const added: DesignCanvas = { ...doc, pages: [...doc.pages, { id: "new", name: "Page 4" }] };
  const shown = render(<Probe canvas={added} />);
  await settle();
  await act(async () => view.showPage("p3"));
  await act(async () => view.showPage("new"));
  assert.equal(view.pageId, "new");

  // Undo takes the new page away; the person is back on the page they added it from.
  shown.rerender(<Probe canvas={doc} />);
  assert.equal(view.pageId, "p3");
  // With that page gone too, the one before it.
  shown.rerender(<Probe canvas={{ ...doc, pages: doc.pages.filter((page) => page.id !== "p3") }} />);
  assert.equal(view.pageId, "p2");
  assert.deepEqual(view.viewport, { x: 40, y: 0, zoom: 2 }, "where it was left");
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.equal((lastReport()?.[1] as { view: { pageId: string } }).view.pageId, "p2");
});

test("when the view's page is gone, the canvas shows the claim before an earlier page", async () => {
  kept = { pageId: "page-1", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} };
  const claimed: DesignCanvas = { ...doc, chatPages: { "chat-1": "p3" } };
  const shown = render(<Probe canvas={claimed} />);
  await settle();
  await act(async () => view.showPage("p2"));
  assert.equal(view.pageId, "p2");
  // Another chat deletes p2; page-1 was shown earlier, but the chat's own page comes first.
  shown.rerender(<Probe canvas={{ ...claimed, pages: claimed.pages.filter((page) => page.id !== "p2") }} />);
  assert.equal(view.pageId, "p3");
});

test("a canvas with no kept view opens on the claim", async () => {
  kept = null;
  render(<Probe canvas={{ ...doc, chatPages: { "chat-1": "p3", "chat-2": "p2" } }} />);
  await settle();
  assert.equal(view.pageId, "p3");
});

test("a fallback page is reported to main", async () => {
  kept = { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} };
  const claimed: DesignCanvas = { ...doc, chatPages: { "chat-1": "p3" } };
  const shown = render(<Probe canvas={claimed} />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  const opened = reports().length;
  shown.rerender(<Probe canvas={{ ...claimed, pages: claimed.pages.filter((page) => page.id !== "p2") }} />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.deepEqual(reports().slice(opened), [
    ["chat-1", { workspaceId: "ws-1", view: { pageId: "p3", viewport: { x: 0, y: 0, zoom: 1 } }, focusId: 0, visible: true }],
  ]);
});

test("when the view's page comes back after a fallback was reported, main hears the page on screen again", async () => {
  kept = { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} };
  const claimed: DesignCanvas = { ...doc, chatPages: { "chat-1": "p3" } };
  const shown = render(<Probe canvas={claimed} />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  shown.rerender(<Probe canvas={{ ...claimed, pages: claimed.pages.filter((page) => page.id !== "p2") }} />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.equal((lastReport()?.[1] as { view: { pageId: string } }).view.pageId, "p3");
  // An undo elsewhere brings p2 back.
  shown.rerender(<Probe canvas={claimed} />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.equal(view.pageId, "p2");
  assert.equal((lastReport()?.[1] as { view: { pageId: string } }).view.pageId, "p2");
});


function StackedProbe({ pane }: { pane: DesignPane }) {
  return (
    <DesignPaneContext.Provider value={{ stacked: true, pane, setPane: () => {} }}>
      <Probe />
    </DesignPaneContext.Provider>
  );
}

const visibleOf = (report: unknown[] | undefined) => (report?.[1] as { visible?: boolean } | undefined)?.visible;

test("the stacked layout reports visible false when the Chat pane is shown and true when the Canvas pane is", async () => {
  kept = { pageId: "page-1", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} };
  const shown = render(<StackedProbe pane="chat" />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.equal(visibleOf(lastReport()), false);
  const before = reports().length;
  shown.rerender(<StackedProbe pane="canvas" />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.equal(reports().length, before + 1, "the pane switch alone is reported");
  assert.equal(visibleOf(lastReport()), true);
  shown.rerender(<StackedProbe pane="chat" />);
  await settle();
  await tick(DESIGN_VIEW_REPORT_DELAY_MS);
  assert.equal(visibleOf(lastReport()), false);
});

test("a hidden document reports visible false, and becoming visible reports true", async () => {
  let state: DocumentVisibilityState = "hidden";
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  try {
    kept = { pageId: "page-1", viewport: { x: 0, y: 0, zoom: 1 }, focusId: 0, viewports: {} };
    render(<Probe />);
    await settle();
    await tick(DESIGN_VIEW_REPORT_DELAY_MS);
    assert.equal(visibleOf(lastReport()), false);
    state = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    await tick(DESIGN_VIEW_REPORT_DELAY_MS);
    assert.equal(visibleOf(lastReport()), true);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});
