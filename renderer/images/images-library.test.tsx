import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { installBotTestIpc } from "../main/bots/test-dom";
import { parseImagesHomeSearch } from "../main/images-home-search";
import { SAVE_ALL_MAX_IMAGES, type GalleryItem } from "../shared/images/ipc-types";
import type { WorkflowSummary } from "../shared/images/schema";
import { ImageLibrary } from "./image-library";
import { ImagesHome } from "./images-home";
import { summarizeWorkflowImages } from "./library-core";
import type { ImageActions } from "./viewer/use-image-actions";
import { WorkflowGrid, type WorkflowCardActions } from "./workflow-grid";

afterEach(() => cleanup());

const NOW = new Date(2026, 9, 31, 12, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime();
const item = (seed: string, patch: Partial<GalleryItem> = {}): GalleryItem => ({
  assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png", runId: `run-${seed}`, runState: "succeeded", workflowId: "wf-a",
  workflowTitle: "Posters", nodeId: "g", nodeTitle: "Generate Image", variant: 0, index: 0, provider: "openrouter", model: "google/flash-image",
  createdAt: at(31, 11), saved: true, thumbUrl: `thumb-${seed}`, ...patch,
});
const LIBRARY = [
  item("a", { prompt: "A lighthouse at dusk" }),
  item("b", { createdAt: at(31, 10), workflowId: "wf-b", workflowTitle: "Product shots", nodeTitle: "Hero", model: "black-forest/flux", prompt: "white sneaker" }),
  item("c", { createdAt: at(30, 9), workflowId: "wf-gone", workflowTitle: undefined, nodeTitle: undefined, prompt: "lighthouse in fog" }),
  item("d", { createdAt: at(20, 9), workflowId: "wf-b", workflowTitle: "Product shots", model: "black-forest/flux" }),
];

function fakeActions(log: string[]): ImageActions {
  return {
    saveAs: (assetId) => void log.push(`save-as:${assetId[0]}`),
    copy: (assetId) => void log.push(`copy:${assetId[0]}`),
    reveal: (assetId) => void log.push(`reveal:${assetId[0]}`),
    revealFolder: () => void log.push("reveal-folder"),
    saveAll: (assetIds) => void log.push(`save-all:${assetIds.length}:${assetIds.slice(0, 4).map((id) => id[0]).join("")}`),
    drag: (assetId) => void log.push(`drag:${assetId[0]}`),
    view: async () => null,
  };
}

function Library({
  items = LIBRARY,
  status = "ready",
  log = [],
  opened = [],
  refresh = () => undefined,
}: {
  items?: GalleryItem[];
  status?: "loading" | "ready" | "error";
  log?: string[];
  opened?: string[];
  refresh?: () => void;
}) {
  const actions = React.useMemo(() => fakeActions(log), [log]);
  return (
    <ImageLibrary
      gallery={{ status, items, saveFolderLabel: "Pictures › Aiden", refresh }}
      actions={actions}
      liveWorkflowIds={new Set(["wf-a", "wf-b"])}
      onOpenWorkflow={(id) => opened.push(id)}
      now={NOW}
    />
  );
}

const tiles = () => document.querySelectorAll<HTMLButtonElement>("[data-library-index]");
const tileNames = () => Array.from(tiles(), (tile) => tile.getAttribute("aria-label"));
const status = () => screen.getByRole("status").textContent;

async function choose(combobox: string, option: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: combobox }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const listbox = await screen.findByRole("listbox");
  fireEvent.keyDown(within(listbox).getByRole("option", { name: option }), { key: "Enter" });
  await waitFor(() => assert.equal(screen.queryByRole("listbox"), null));
}

async function optionsOf(combobox: string): Promise<string[]> {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: combobox }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const listbox = await screen.findByRole("listbox");
  const labels = within(listbox).getAllByRole("option").map((option) => option.textContent ?? "");
  fireEvent.keyDown(listbox, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("listbox"), null));
  return labels;
}

test("All Images sections by day, and the search narrows by prompt, title or model until Clear Filters", () => {
  render(<Library />);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(at(20, 9));
  assert.deepEqual(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent), ["Today", "Yesterday", date]);
  assert.equal(status(), "4 images");
  assert.ok(screen.getByText("Saved to Pictures › Aiden"));

  const search = screen.getByRole("searchbox", { name: "Search images" });
  fireEvent.change(search, { target: { value: "LIGHTHOUSE" } });
  assert.deepEqual(tileNames(), ["Image 1 of 2, Posters: A lighthouse at dusk", "Image 2 of 2, Deleted workflow: lighthouse in fog"]);
  assert.equal(status(), "2 of 4 images");
  fireEvent.change(search, { target: { value: "hero" } });
  assert.deepEqual(tileNames(), ["Image 1 of 1, Product shots: white sneaker"]);

  fireEvent.change(search, { target: { value: "nothing like this" } });
  assert.equal(tiles().length, 0);
  assert.ok(screen.getByText("No matching images"));
  fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
  assert.equal(tiles().length, 4);
  assert.equal((screen.getByRole("searchbox", { name: "Search images" }) as HTMLInputElement).value, "");
});

test("the workflow and model filters show counts that follow each other, and the sort flips the order", async () => {
  render(<Library />);
  assert.deepEqual(await optionsOf("Workflow"), ["All Workflows (4)", "Product shots (2)", "Deleted workflows (1)", "Posters (1)"]);
  await choose("Workflow", "Product shots (2)");
  assert.equal(tiles().length, 2);
  assert.deepEqual(await optionsOf("Model"), ["All Models (2)", "black-forest/flux (2)"]);

  await choose("Workflow", "All Workflows (4)");
  await choose("Model", "google/flash-image (2)");
  assert.deepEqual(tileNames().map((name) => name?.split(",")[1]?.trim()), ["Posters: A lighthouse at dusk", "Deleted workflow: lighthouse in fog"]);

  await choose("Model", "All Models (4)");
  await choose("Sort", "Oldest First");
  assert.equal(screen.getAllByRole("heading", { level: 3 }).slice(-1)[0]?.textContent, "Today");
  assert.match(tileNames()[0] ?? "", /^Image 1 of 4, Product shots$/u);
});

test("a thumbnail opens the viewer over the filtered images, and Open Workflow goes to a workflow that still exists", async () => {
  const opened: string[] = [];
  render(<Library opened={opened} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search images" }), { target: { value: "lighthouse" } });
  fireEvent.click(tiles()[1]!);
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByText("2 of 2"));
  // The deleted workflow can't be opened.
  assert.equal((within(dialog).getByRole("button", { name: "Open Workflow" }) as HTMLButtonElement).disabled, true);
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });
  await waitFor(() => assert.ok(within(dialog).getByText("1 of 2")));
  fireEvent.click(within(dialog).getByRole("button", { name: "Open Workflow" }));
  assert.deepEqual(opened, ["wf-a"]);
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});

test("a thumbnail's menu saves, copies and reveals that image, and offers its workflow", async () => {
  const log: string[] = [];
  const opened: string[] = [];
  render(<Library log={log} opened={opened} />);
  fireEvent.contextMenu(tiles()[1]!);
  let menu = await screen.findByRole("menu");
  const labels = within(menu).getAllByRole("menuitem").map((entry) => entry.textContent ?? "");
  assert.deepEqual([labels[0], labels[1], labels[3]], ["Save…", "Copy Image", "Open Workflow"]);
  assert.match(labels[2] ?? "", /^Show in (Finder|folder)$/u);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy Image" }));
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));

  fireEvent.contextMenu(tiles()[2]!);
  menu = await screen.findByRole("menu");
  assert.equal(within(menu).getByRole("menuitem", { name: "Open Workflow" }).getAttribute("aria-disabled"), "true");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Save…" }));
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));

  fireEvent.contextMenu(tiles()[3]!);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Open Workflow" }));
  assert.deepEqual(log, ["copy:b", "save-as:c"]);
  assert.deepEqual(opened, ["wf-b"]);
});

test("Save All saves what the filters show, and says when only the first part of a large set is saved", () => {
  const log: string[] = [];
  const { unmount } = render(<Library log={log} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search images" }), { target: { value: "product" } });
  fireEvent.click(screen.getByRole("button", { name: "Save all 2 images…" }));
  assert.deepEqual(log, ["save-all:2:bd"]);
  unmount();

  const many = Array.from({ length: SAVE_ALL_MAX_IMAGES + 5 }, (_, index) => item(String(index), { createdAt: NOW - index * 1000 }));
  render(<Library items={many} log={log} />);
  assert.ok(screen.getByText(`Saves the first ${SAVE_ALL_MAX_IMAGES} of ${SAVE_ALL_MAX_IMAGES + 5}`));
  fireEvent.click(screen.getByRole("button", { name: `Save the first ${SAVE_ALL_MAX_IMAGES} of ${SAVE_ALL_MAX_IMAGES + 5} images…` }));
  assert.equal(log[1]?.split(":")[1], String(SAVE_ALL_MAX_IMAGES));
});

test("the grid is one Tab stop that the arrow keys, Home and End move across sections", () => {
  render(<Library />);
  const tabStops = () => Array.from(tiles()).filter((tile) => tile.tabIndex === 0);
  assert.deepEqual(tabStops(), [tiles()[0]]);
  tiles()[0]!.focus();
  fireEvent.keyDown(tiles()[0]!, { key: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  assert.equal(document.activeElement, tiles()[2]);
  assert.deepEqual(tabStops(), [tiles()[2]]);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  assert.equal(document.activeElement, tiles()[3]);
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  assert.equal(document.activeElement, tiles()[0]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  assert.equal(document.activeElement, tiles()[0]);
});

test("before any image, while loading and after a failed read, the library says what is happening", () => {
  const log: string[] = [];
  let retried = 0;
  const { rerender } = render(<Library items={[]} log={log} />);
  assert.ok(screen.getByText("No images yet"));
  assert.ok(screen.getByText(/lands here, and is saved to Pictures › Aiden automatically/u));
  fireEvent.click(screen.getByRole("button", { name: "Show Folder" }));
  assert.deepEqual(log, ["reveal-folder"]);
  assert.equal(screen.queryByRole("searchbox"), null);

  rerender(<Library items={[]} status="loading" />);
  assert.ok(screen.getByText("Loading images…"));
  rerender(<Library items={[]} status="error" refresh={() => (retried += 1)} />);
  assert.ok(within(screen.getByRole("alert")).getByText("Images couldn't be loaded"));
  fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
  assert.equal(retried, 1);
});

const WORKFLOWS: WorkflowSummary[] = [
  { id: "wf-b", title: "Product shots", revision: 3, updatedAt: at(31, 10) },
  { id: "wf-new", title: "Untitled", revision: 1, updatedAt: at(31, 11) },
];

test("each workflow card shows its newest image, image count and last image time, and keeps its actions", async () => {
  const picked: string[] = [];
  const actions: WorkflowCardActions = {
    open: (workflow) => picked.push(`open:${workflow.id}`),
    rename: (workflow) => picked.push(`rename:${workflow.id}`),
    duplicate: (workflow) => picked.push(`duplicate:${workflow.id}`),
    remove: (workflow) => picked.push(`delete:${workflow.id}`),
  };
  render(<WorkflowGrid workflows={WORKFLOWS} summaries={summarizeWorkflowImages(LIBRARY)} galleryReady now={at(31, 10) + 5 * 60_000} actions={actions} />);
  const cards = within(screen.getByRole("list", { name: "Image workflows" })).getAllByRole("listitem");
  assert.equal(cards[0]!.querySelector("img")?.getAttribute("src"), "thumb-b");
  const open = within(cards[0]!).getByRole("button", { name: "Product shots" });
  assert.equal(open.getAttribute("aria-describedby") && document.getElementById(open.getAttribute("aria-describedby")!)?.textContent, "2 images · 5 min ago");
  assert.equal(cards[1]!.querySelector("img"), null);
  assert.ok(within(cards[1]!).getByText("No images yet"));

  fireEvent.click(open);
  fireEvent.keyDown(within(cards[1]!).getByRole("button", { name: "More actions for Untitled" }), { key: "Enter" });
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename…" }));
  assert.deepEqual(picked, ["open:wf-b", "rename:wf-new"]);
});

test("the home keeps All Images selected across opening a workflow from it and coming back", async () => {
  installBotTestIpc({
    "imageWorkflows:list": () => ({ workflows: WORKFLOWS, imageCounts: {} }),
    "imageWorkflows:list-models": () => ({ models: [] }),
    "imageWorkflows:gallery": () => ({ items: LIBRARY.slice(1, 2), saveFolderLabel: "Pictures › Aiden" }),
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/images",
    validateSearch: parseImagesHomeSearch,
    component: function Home() {
      // Typed against the app's registered router, so this test route's search is cast.
      const { view } = homeRoute.useSearch() as { view?: "images" };
      return <ImagesHome view={view ?? "workflows"} />;
    },
  });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/images/$workflowId",
    component: function Editor() {
      return <p>Editing {(editorRoute.useParams() as { workflowId: string }).workflowId}</p>;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, editorRoute]),
    history: createMemoryHistory({ initialEntries: ["/images"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  const tab = (name: string) => screen.getByRole("tab", { name });
  await waitFor(() => assert.equal(tab("Workflows").getAttribute("aria-selected"), "true"));

  fireEvent.mouseDown(tab("All Images"), { button: 0 });
  fireEvent.click(tab("All Images"));
  const view = () => (router.state.location.search as { view?: string }).view;
  await waitFor(() => assert.equal(view(), "images"));
  await waitFor(() => assert.equal(tiles().length, 1));
  fireEvent.click(tiles()[0]!);
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Open Workflow" }));
  await screen.findByText("Editing wf-b");

  await act(async () => router.history.back());
  await waitFor(() => assert.equal(tab("All Images").getAttribute("aria-selected"), "true"));
  assert.equal(view(), "images");
});
