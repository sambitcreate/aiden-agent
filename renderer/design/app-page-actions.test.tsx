// The person's page actions on a live app frame (design mode v2 Phase 3c,
// S96): the Trash's Undo toast waits for the canvas, and says ⌘Z instead
// when the canvas never shows the Trash.

// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { Toaster } from "../components/ui";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../shared/design-canvas/schema";
import { firstVariantPath, TRASH_UNDO_WAIT_MS, useAppPageActions } from "./app-page-actions";

afterEach(cleanup);

const app: DesignFrame = {
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
};

const settle = () =>
  act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });

test("a Trash whose revision never reaches the canvas shows a toast without Undo after 5 s", async (t) => {
  installBotTestIpc({
    "designCanvas:appPageTrash": () => ({ trashed: "src/routes/pricing.tsx", route: "/pricing", removed: ["app-1"], revision: 9 }),
  });
  render(<Toaster />);
  const doc: DesignCanvas = { ...emptyDesignCanvas(), revision: 1, frames: [app] };
  const undone: number[] = [];
  const { result } = renderHook(() =>
    useAppPageActions({
      chatId: "chat-1",
      doc,
      latestDoc: { current: doc },
      flush: async () => true,
      undo: () => undone.push(1),
      queueOnFrame: () => true,
      focusCanvas: () => undefined,
    }),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  act(() => result.current.trashAppPage("app-1"));
  await settle();
  t.mock.timers.tick(TRASH_UNDO_WAIT_MS - 1);
  await settle();
  assert.equal(screen.queryByText(/Moved src\/routes\/pricing\.tsx to the Trash/u), null, "nothing before the wait is over");
  t.mock.timers.tick(1);
  await settle();
  t.mock.timers.reset();
  assert.ok(await screen.findByText(/Moved src\/routes\/pricing\.tsx to the Trash\. Press (⌘Z|Ctrl\+Z) to undo\./u));
  assert.equal(screen.queryByRole("button", { name: "Undo" }), null, "no Undo that might undo another step");
  assert.deepEqual(undone, []);
});

/** The hook over a canvas the test moves on, as the Trash's revision comes back. */
function trashHarness() {
  installBotTestIpc({
    "designCanvas:appPageTrash": () => ({ trashed: "src/routes/pricing.tsx", route: "/pricing", removed: ["app-1"], revision: 9 }),
  });
  render(<Toaster />);
  const latestDoc: { current: DesignCanvas } = { current: { ...emptyDesignCanvas(), revision: 8, frames: [app] } };
  const undone: number[] = [];
  const hook = renderHook(({ doc }: { doc: DesignCanvas }) =>
    useAppPageActions({ chatId: "chat-1", doc, latestDoc, flush: async () => true, undo: () => undone.push(1), queueOnFrame: () => true, focusCanvas: () => undefined }),
  { initialProps: { doc: latestDoc.current } });
  const show = (doc: DesignCanvas) => {
    latestDoc.current = doc;
    hook.rerender({ doc });
  };
  return { ...hook, show, undone, latestDoc };
}

test("the Trash's Undo undoes it while the canvas still shows the Trash step", async () => {
  const { result, show, undone } = trashHarness();
  act(() => result.current.trashAppPage("app-1"));
  await settle();
  show({ ...emptyDesignCanvas(), revision: 9, frames: [] });
  await settle();
  const button = await screen.findByRole("button", { name: "Undo" });
  act(() => button.click());
  assert.deepEqual(undone, [1]);
});

test("a Trash the canvas first shows inside a later revision gets no Undo", async () => {
  const { result, show, undone } = trashHarness();
  act(() => result.current.trashAppPage("app-1"));
  await settle();
  // Another chat's save landed first: the canvas takes in 8 to 10, so the Trash is no step of its own.
  show({ ...emptyDesignCanvas(), revision: 10, frames: [] });
  await settle();
  assert.ok(await screen.findByText(/Moved src\/routes\/pricing\.tsx to the Trash\. Press (⌘Z|Ctrl\+Z) to undo\./u));
  assert.equal(screen.queryByRole("button", { name: "Undo" }), null);
  assert.deepEqual(undone, []);
});

test("the toast's Undo undoes nothing once the canvas has moved on", async () => {
  const { result, show, undone } = trashHarness();
  act(() => result.current.trashAppPage("app-1"));
  await settle();
  show({ ...emptyDesignCanvas(), revision: 9, frames: [] });
  await settle();
  const button = await screen.findByRole("button", { name: "Undo" });
  // The person's own edit since: ⌘Z would take that first.
  show({ ...emptyDesignCanvas(), revision: 9, frames: [{ ...app, id: "note", kind: "note", text: "x" }] });
  act(() => button.click());
  assert.deepEqual(undone, []);
  assert.ok(await screen.findByText(/The canvas changed since the Trash\. Press (⌘Z|Ctrl\+Z) to undo it\./u));
});

test("two pages trashed one after the other each get their toast once the canvas shows them", async () => {
  const about: DesignFrame = { ...app, id: "app-2", title: "About", route: "/about" };
  const replies = [
    { trashed: "src/routes/pricing.tsx", route: "/pricing", removed: ["app-1"], revision: 9 },
    { trashed: "src/routes/about.tsx", route: "/about", removed: ["app-2"], revision: 10 },
  ];
  installBotTestIpc({ "designCanvas:appPageTrash": () => replies.shift() });
  render(<Toaster />);
  const latestDoc: { current: DesignCanvas } = { current: { ...emptyDesignCanvas(), revision: 8, frames: [app, about] } };
  const undone: number[] = [];
  const { result, rerender } = renderHook(({ doc }: { doc: DesignCanvas }) =>
    useAppPageActions({ chatId: "chat-1", doc, latestDoc, flush: async () => true, undo: () => undone.push(1), queueOnFrame: () => true, focusCanvas: () => undefined }),
  { initialProps: { doc: latestDoc.current } });
  const show = (doc: DesignCanvas) => {
    latestDoc.current = doc;
    rerender({ doc });
  };
  // The second Trash lands while the first still waits for its revision.
  act(() => result.current.trashAppPage("app-1"));
  await settle();
  act(() => result.current.trashAppPage("app-2"));
  await settle();
  show({ ...emptyDesignCanvas(), revision: 9, frames: [about] });
  await settle();
  assert.ok(await screen.findByText("Moved src/routes/pricing.tsx to the Trash."), "the first Trash's toast");
  show({ ...emptyDesignCanvas(), revision: 10, frames: [] });
  await settle();
  assert.ok(await screen.findByText("Moved src/routes/about.tsx to the Trash."), "and the second's");
});

test("Ask Aiden's copy note names the page's first variant", () => {
  assert.equal(firstVariantPath("/pricing?plan=pro"), "/pricing-v2");
  assert.equal(firstVariantPath("/pricing-v3/"), "/pricing-v2");
  assert.equal(firstVariantPath("/"), "/index-v2");
  assert.equal(firstVariantPath("/blog/hello#top"), "/blog/hello-v2");
});

const renderCopyActions = () => {
  render(<Toaster />);
  const doc: DesignCanvas = { ...emptyDesignCanvas(), revision: 1, frames: [app] };
  return renderHook(() =>
    useAppPageActions({
      chatId: "chat-1",
      doc,
      latestDoc: { current: doc },
      flush: async () => true,
      undo: () => undefined,
      queueOnFrame: () => true,
      focusCanvas: () => undefined,
    }),
  );
};

test("a copy the canvas couldn't save says the copy wasn't added and where its file still is, with no Ask Aiden", async () => {
  installBotTestIpc({ "designCanvas:appPageVariant": () => ({ error: "io", kept: "src/routes/pricing-v2/route.tsx" }) });
  const { result } = renderCopyActions();
  act(() => result.current.duplicateAppPage("app-1"));
  assert.ok(
    await screen.findByText("The canvas couldn't be saved, so the copy wasn't added. It's still at src/routes/pricing-v2/route.tsx."),
  );
  assert.equal(screen.queryByRole("button", { name: "Ask Aiden" }), null);
});

test("a copy refused after Aiden created its file names the empty file it left", async () => {
  installBotTestIpc({ "designCanvas:appPageVariant": () => ({ error: "io", empty: "src/routes/pricing-v2/route.tsx" }) });
  const { result } = renderCopyActions();
  act(() => result.current.duplicateAppPage("app-1"));
  assert.ok(await screen.findByText("The page's file couldn't be copied. An empty file was left at src/routes/pricing-v2/route.tsx."));
});
