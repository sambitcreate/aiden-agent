import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import type { GalleryItem } from "../shared/images/ipc-types";
import type { RunSnapshot } from "../shared/images/run-types";
import { HistoryPanel } from "./history-panel";
import { OutputNodeBody, type OutputImageActions } from "./nodes/output-node";
import { RunPanel } from "./run-panel";
import { EditorSidePanel } from "./side-panel";
import { useGallery } from "./use-gallery";
import { ImageViewer } from "./viewer/image-viewer";
import type { ImageActions } from "./viewer/use-image-actions";

afterEach(() => cleanup());

const item = (seed: string, runId: string, patch: Partial<GalleryItem> = {}): GalleryItem => ({
  assetId: seed.repeat(64), width: 1024, height: 1024, mediaType: "image/png", runId, runState: "succeeded", workflowId: "wf", nodeId: "g", variant: 0,
  index: 0, provider: "openrouter", model: "m", createdAt: 1_000, saved: true, thumbUrl: `thumb-${seed}`, ...patch,
});
const ITEMS = [item("a", "r2", { prompt: "A lighthouse at dusk" }), item("b", "r2"), item("c", "r1")];

function fakeActions(log: string[], originals: Record<string, string> = {}): ImageActions {
  return {
    saveAs: (assetId) => void log.push(`save-as:${assetId[0]}`),
    copy: (assetId) => void log.push(`copy:${assetId[0]}`),
    reveal: (assetId) => void log.push(`reveal:${assetId[0]}`),
    revealFolder: () => void log.push("reveal-folder"),
    saveAll: (assetIds) => void log.push(`save-all:${assetIds.map((id) => id[0]).join("")}`),
    drag: (assetId) => void log.push(`drag:${assetId[0]}`),
    view: async (assetId) => originals[assetId] ?? null,
  };
}

/** The viewer as a host mounts it: it owns the index and closes on request. */
function Host({ items, start, actions, onUse }: { items: GalleryItem[]; start: number; actions: ImageActions; onUse?: (item: GalleryItem) => void }) {
  const [index, setIndex] = React.useState<number | null>(start);
  return (
    <ImageViewer
      items={items}
      index={index}
      onIndexChange={setIndex}
      onClose={() => setIndex(null)}
      actions={actions}
      saveFolderLabel="Pictures › Aiden"
      extraActions={onUse ? [{ id: "use", label: "Use as Input", onSelect: onUse }] : []}
    />
  );
}

const stageImage = () => document.querySelector<HTMLImageElement>("[data-image-viewer-image]");

test("the viewer shows the thumbnail first, then the decoded original, and steps with the arrow keys", async () => {
  const log: string[] = [];
  render(<Host items={ITEMS} start={0} actions={fakeActions(log, { [ITEMS[0]!.assetId]: "original-a" })} />);
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByText("1 of 3"));
  assert.ok(within(dialog).getByText("A lighthouse at dusk"));
  await waitFor(() => assert.equal(stageImage()?.getAttribute("src"), "original-a"));

  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  await waitFor(() => assert.ok(within(dialog).getByText("2 of 3")));
  // No original for this one: the thumbnail stays rather than blanking.
  assert.equal(stageImage()?.getAttribute("src"), "thumb-b");
  fireEvent.keyDown(document.body, { key: "End" });
  await waitFor(() => assert.ok(within(dialog).getByText("3 of 3")));
  // The last image does not wrap around to the first.
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  assert.ok(within(dialog).getByText("3 of 3"));
  fireEvent.keyDown(document.body, { key: "Home" });
  await waitFor(() => assert.ok(within(dialog).getByText("1 of 3")));

  // The filmstrip marks the active image and is a single tab stop.
  const strip = within(dialog).getByRole("list", { name: "Images" });
  const current = within(strip).getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "true");
  assert.deepEqual(current.map((button) => button.getAttribute("aria-label")), ["Image 1 of 3"]);
  assert.deepEqual(within(strip).getAllByRole("button").map((button) => button.tabIndex), [0, -1, -1]);
  fireEvent.click(within(strip).getByRole("button", { name: "Image 3 of 3" }));
  await waitFor(() => assert.ok(within(dialog).getByText("3 of 3")));
});

test("a filmstrip jump past the shown thumbnails keeps focus in the filmstrip, and never takes it from elsewhere", async () => {
  const many = Array.from({ length: 30 }, (_, index) => item(String.fromCharCode(97 + (index % 26)) + String(index), "r1", { assetId: index.toString(16).padStart(64, "0") }));
  render(<Host items={many} start={0} actions={fakeActions([])} />);
  const dialog = await screen.findByRole("dialog");
  const strip = within(dialog).getByRole("list", { name: "Images" });
  within(strip).getByRole("button", { name: "Image 1 of 30" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  await waitFor(() => assert.ok(within(dialog).getByText("30 of 30")));
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Image 30 of 30");
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  await waitFor(() => assert.ok(within(dialog).getByText("1 of 30")));
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Image 1 of 30");

  const copy = within(dialog).getByRole("button", { name: "Copy Image" });
  copy.focus();
  fireEvent.keyDown(copy, { key: "End" });
  await waitFor(() => assert.ok(within(dialog).getByText("30 of 30")));
  assert.equal(document.activeElement, copy);
});

test("the viewer's actions act on the viewed image, a drag goes out natively, and Escape closes", async () => {
  const log: string[] = [];
  const used: string[] = [];
  render(<Host items={ITEMS} start={1} actions={fakeActions(log)} onUse={(picked) => used.push(picked.assetId[0]!)} />);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save…" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Copy Image" }));
  fireEvent.click(within(dialog).getByRole("button", { name: /^Show in (Finder|folder)$/u }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Use as Input" }));
  assert.deepEqual(log, ["save-as:b", "copy:b", "reveal:b"]);
  assert.deepEqual(used, ["b"]);
  assert.ok(within(dialog).getByText("Saved to Pictures › Aiden"));

  // The HTML drag would carry only a URL; the file leaves through the main process instead.
  const image = stageImage()!;
  const notPrevented = fireEvent.dragStart(image);
  assert.equal(notPrevented, false);
  assert.equal(log[log.length - 1], "drag:b");

  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});

test("history groups images by run with each run's state and count, and Save All saves that run's images", () => {
  const log: string[] = [];
  const opened: number[] = [];
  render(
    <HistoryPanel
      status="ready"
      items={ITEMS.map((entry) => (entry.runId === "r2" ? { ...entry, runState: "partial" as const } : entry))}
      saveFolderLabel="Pictures › Aiden"
      now={1_000 + 5 * 60_000}
      onOpen={(index) => opened.push(index)}
      onSaveAll={(ids) => log.push(`save-all:${ids.map((id) => id[0]).join("")}`)}
      onRevealFolder={() => log.push("reveal-folder")}
      onRetry={() => undefined}
    />,
  );
  const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
  assert.deepEqual(headings, ["5 min ago · Finished with errors · 2 images", "5 min ago · Finished · 1 image"]);
  fireEvent.click(screen.getByRole("button", { name: "Save all 1 image from this run…" }));
  fireEvent.click(screen.getByRole("button", { name: "Save all 2 images from this run…" }));
  // Thumbnails open the viewer over the whole history, in its order.
  fireEvent.click(screen.getByRole("button", { name: "Open image 3 of 3" }));
  fireEvent.click(screen.getByRole("button", { name: "Show Folder" }));
  assert.deepEqual(log, ["save-all:c", "save-all:ab", "reveal-folder"]);
  assert.deepEqual(opened, [2]);
  assert.ok(screen.getByText("Saved to Pictures › Aiden"));
  // The run headline stays the editor's only live region.
  assert.equal(document.querySelectorAll('[role="status"]').length, 0);
});

test("an empty history explains where images will appear and that they are saved automatically", () => {
  render(
    <HistoryPanel status="ready" items={[]} saveFolderLabel="Pictures › Aiden" onOpen={() => undefined} onSaveAll={() => undefined} onRevealFolder={() => undefined} onRetry={() => undefined} />,
  );
  assert.ok(screen.getByText("No images yet"));
  assert.ok(screen.getByText(/saved to Pictures › Aiden/u));
});

test("the side panel switches between Run and History, and only the run headline is a status region", async () => {
  const snapshot: RunSnapshot = {
    version: 1,
    run: { runId: "r", workflowId: "wf", workflowRevision: 1, scope: { kind: "all" }, state: "succeeded", requestLimit: 1, requestsSent: 1, createdAt: 1 },
    attempts: [],
  };
  function Panel() {
    const [tab, setTab] = React.useState<"run" | "history">("run");
    return (
      <EditorSidePanel
        tab={tab}
        onTabChange={setTab}
        run={<RunPanel snapshot={snapshot} nodeTitles={new Map()} onStop={() => undefined} onRetry={() => undefined} />}
        history={<p>History body</p>}
      />
    );
  }
  render(<Panel />);
  assert.equal(screen.getByRole("tab", { name: "Run" }).getAttribute("aria-selected"), "true");
  assert.deepEqual(screen.getAllByRole("status").map((node) => node.textContent), ["Finished"]);
  const history = screen.getByRole("tab", { name: "History" });
  fireEvent.mouseDown(history, { button: 0 });
  fireEvent.click(history);
  await waitFor(() => assert.ok(screen.getByText("History body")));
  assert.equal(screen.queryAllByRole("status").length, 0);
  // The panel is the selected tab's: named by it, and the one it controls.
  const panel = screen.getByRole("tabpanel", { name: "History" });
  assert.ok(within(panel).getByText("History body"));
  assert.equal(history.getAttribute("aria-controls"), panel.id);
});

test("before any run, the Run tab says how to start one", () => {
  render(<EditorSidePanel tab="run" onTabChange={() => undefined} run={null} history={null} />);
  assert.ok(screen.getByText("No runs yet"));
});

test("Output thumbnails are buttons that open the viewer, with a +N tile past four", () => {
  const opened: number[] = [];
  const actions: OutputImageActions = {
    open: (index) => opened.push(index), saveAs: () => undefined, copy: () => undefined, reveal: () => undefined, revealLabel: "Show in Finder",
  };
  const refs = ["a", "b", "c", "d", "e", "f"].map((seed) => ({ assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png" as const }));
  const urls = Object.fromEntries(refs.map((ref) => [ref.assetId, `thumb-${ref.assetId[0]}`]));
  render(<OutputNodeBody images={refs} urls={urls} actions={actions} />);
  const buttons = within(screen.getByRole("list", { name: "Generated images" })).getAllByRole("button");
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label") ?? button.querySelector("img")?.getAttribute("alt")), [
    "Generated image 1", "Generated image 2", "Generated image 3", "Generated image 4 and 2 more",
  ]);
  assert.ok(screen.getByText("+2"));
  fireEvent.click(buttons[1]!);
  fireEvent.click(buttons[3]!);
  assert.deepEqual(opened, [1, 3]);
});

test("Shift+F10 on a focused Output thumbnail opens its menu from the keyboard", async () => {
  const saved: string[] = [];
  const actions: OutputImageActions = {
    open: () => undefined, saveAs: (assetId) => saved.push(assetId[0]!), copy: () => undefined, reveal: () => undefined, revealLabel: "Show in Finder",
  };
  const refs = ["a", "b"].map((seed) => ({ assetId: seed.repeat(64), width: 8, height: 8, mediaType: "image/png" as const }));
  render(<OutputNodeBody images={refs} urls={{}} actions={actions} />);
  const second = within(screen.getByRole("list", { name: "Generated images" })).getAllByRole("button")[1]!;
  second.focus();
  fireEvent.keyDown(second, { key: "F10", shiftKey: true });
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Save…" }));
  assert.deepEqual(saved, ["b"]);
});

test("the gallery hook re-reads when a run of its workflow ends, and not while it is running", async () => {
  let reads = 0;
  installBotTestIpc({
    "imageWorkflows:gallery": () => {
      reads += 1;
      return { items: reads === 1 ? [] : [ITEMS[0]], saveFolderLabel: "Pictures › Aiden" };
    },
    "imageWorkflows:list-runs": () => ({ runs: [] }),
  });
  let latest: ReturnType<typeof useGallery> | null = null;
  function Probe() {
    latest = useGallery("wf");
    return null;
  }
  render(<Probe />);
  await waitFor(() => assert.equal(latest?.status, "ready"));
  assert.equal(latest!.items.length, 0);
  const snapshot = (state: RunSnapshot["run"]["state"], workflowId = "wf"): RunSnapshot => ({
    version: 2,
    run: { runId: "r9", workflowId, workflowRevision: 1, scope: { kind: "all" }, state, requestLimit: 1, requestsSent: 1, createdAt: 1 },
    attempts: [],
  });
  act(() => {
    emitBotTestNotification("imageWorkflows:run-changed", snapshot("running"));
    emitBotTestNotification("imageWorkflows:run-changed", snapshot("succeeded", "another"));
  });
  assert.equal(reads, 1);
  act(() => emitBotTestNotification("imageWorkflows:run-changed", snapshot("succeeded")));
  await waitFor(() => assert.equal(latest!.items.length, 1));
  assert.equal(latest!.saveFolderLabel, "Pictures › Aiden");
});
