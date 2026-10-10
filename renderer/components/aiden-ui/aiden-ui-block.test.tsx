import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { compileAum } from "../../shared/aiden-ui/compile";
import type { ChatUiVisualV1 } from "../../shared/aiden-ui/types";
import type { Attachment } from "../../../main/services/types";
import { visualSnapshotImages } from "../../../main/services/visual-snapshot-core";
import { AidenUiBlock, type AidenUiAction } from "./aiden-ui-block";
import { setChartModuleLoader } from "./chart";

const FIXTURES = new URL("../../shared/aiden-ui/fixtures/markup/", import.meta.url);

function visualFrom(name: string, overrides: Partial<ChatUiVisualV1> = {}): ChatUiVisualV1 {
  const compiled = compileAum(readFileSync(new URL(`${name}.aum`, FIXTURES), "utf8"));
  assert.ok(compiled.tree);
  return {
    version: 1,
    kind: "ui",
    id: `ui-${name}`,
    title: compiled.title ?? name,
    catalogVersion: 1,
    tree: compiled.tree,
    ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
    ...(compiled.state ? { state: compiled.state } : {}),
    fallbackText: compiled.fallbackText,
    ...overrides,
  };
}

interface FakeChart {
  config: { type: string; data: { labels: unknown[]; datasets: { data: unknown[] }[] } };
  destroyed: boolean;
}
let charts: FakeChart[] = [];
let clipboard: string[] = [];

beforeEach(() => {
  charts = [];
  clipboard = [];
  setChartModuleLoader(async () => ({
    default: class {
      chart: FakeChart;
      constructor(_canvas: unknown, config: unknown) {
        this.chart = { config: config as FakeChart["config"], destroyed: false };
        charts.push(this.chart);
      }
      destroy() {
        this.chart.destroyed = true;
      }
    },
  }));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void clipboard.push(text) },
  });
});
afterEach(() => cleanup());

const liveCharts = () => charts.filter((chart) => !chart.destroyed);

test("bound inputs drive the values, chart, and table without a model call", async () => {
  render(<AidenUiBlock visual={visualFrom("dashboard")} />);
  const figure = screen.getByRole("figure", { name: "Q3 revenue by region" });
  assert.ok(within(figure).getByText("$6,930.00"));
  await waitFor(() => assert.equal(liveCharts().length, 1));
  assert.deepEqual(liveCharts()[0]!.config.data.datasets[0]!.data, [2400, 3100, 1430]);
  assert.ok(screen.getByRole("img", { name: "Revenue by region" }));

  fireEvent.click(screen.getByRole("radio", { name: "Margin" }));
  assert.ok(within(figure).getByText("31%"));
  await waitFor(() => assert.deepEqual(liveCharts()[0]!.config.data.datasets[0]!.data, [0.28, 0.35, 0.27]));
  // Sorted table rows read from data, formatted per column.
  // The last table is the visible one; the chart's screen-reader table comes first.
  const tables = within(figure).getAllByRole("table");
  const rows = within(tables[tables.length - 1]!).getAllByRole("row").map((row) => row.textContent);
  assert.deepEqual(rows.slice(1), ["AMER$3,100.0035%", "EMEA$2,400.0028%", "APAC$1,430.0027%"]);
});

test("actions send, copy, and open only through their own handlers", async () => {
  const actions: AidenUiAction[] = [];
  const states: Record<string, unknown>[] = [];
  render(
    <AidenUiBlock visual={visualFrom("tabs")} onAction={(action) => actions.push(action)} onStateChange={(state) => states.push(state)} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  assert.deepEqual(actions, [{ kind: "send", text: "Start the team plan" }]);

  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => assert.deepEqual(clipboard, ["Plan: team"]));

  fireEvent.click(screen.getByRole("button", { name: "Pricing page" }));
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByText("https://example.com/pricing"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));

  fireEvent.mouseDown(screen.getByRole("tab", { name: "Solo" }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name: "Solo" }));
  assert.ok(screen.getByText("$12.00"));
  assert.equal(screen.queryByRole("radiogroup", { name: "Seats" }), null);
  assert.deepEqual(states[states.length - 1], { plan: "solo", seats: 5, annual: false, note: "" });
});

test("a non-https openUrl does nothing", () => {
  const visual = visualFrom("comparison", {
    tree: {
      t: "Visual",
      k: "0",
      c: [{ t: "Button", k: "0.0", p: { action: { act: "open", url: { op: "lit", v: "http://example.com" } } }, c: [{ t: "#text", k: "0.0.0", s: "Go" }] }],
    },
  });
  render(<AidenUiBlock visual={visual} />);
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  assert.equal(screen.queryByRole("dialog"), null);
});

test("Each and If follow state: rows appear when a filter is turned off", () => {
  render(<AidenUiBlock visual={visualFrom("filter")} />);
  const titles = () => screen.queryAllByText(/^(Crash on launch|Slow search|Typo in settings)$/u).map((node) => node.textContent);
  assert.deepEqual(titles(), ["Crash on launch", "Slow search"]);
  fireEvent.click(screen.getByRole("switch", { name: "Show closed" }));
  assert.deepEqual(titles(), ["Crash on launch", "Slow search", "Typo in settings"]);
});

test("a draft visual is inert: actions never fire and inputs are disabled", () => {
  const actions: AidenUiAction[] = [];
  render(<AidenUiBlock visual={visualFrom("tabs")} draft onAction={(action) => actions.push(action)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose plan" }));
  assert.equal(actions.length, 0);
  assert.ok(screen.getByRole("figure").querySelector("[inert]"));
});

test("a theme change redraws charts but keeps local state", async () => {
  const visual = visualFrom("dashboard");
  const view = render(<AidenUiBlock visual={visual} />);
  fireEvent.click(screen.getByRole("radio", { name: "Margin" }));
  await waitFor(() => assert.equal(liveCharts().length, 1));
  const before = charts.length;
  act(() => document.documentElement.classList.add("dark"));
  await waitFor(() => assert.ok(charts.length > before));
  view.rerender(<AidenUiBlock visual={{ ...visual }} />);
  assert.equal(screen.getByRole("radio", { name: "Margin" }).getAttribute("aria-checked"), "true");
  document.documentElement.classList.remove("dark");
});

test("Copy as text copies the visual's plain-text rendering", async () => {
  const visual = visualFrom("steps");
  render(<AidenUiBlock visual={visual} />);
  fireEvent.click(screen.getByRole("button", { name: `Copy ${visual.title} as text` }));
  await waitFor(() => assert.deepEqual(clipboard, [visual.fallbackText]));
});

test("the explainer renders math, code, inline keys, and its slider value", () => {
  render(<AidenUiBlock visual={visualFrom("explainer")} />);
  assert.ok(screen.getByText(/\$1,628\.89/u));
  fireEvent.keyDown(screen.getByRole("slider", { name: "Years" }), { key: "ArrowRight" });
  assert.ok(screen.getByText(/After 11 years/u));
  assert.equal(screen.getByText("⌘").tagName, "KBD");
  fireEvent.click(screen.getByRole("button", { name: "Show the code" }));
  assert.ok(screen.getByText(/def grow/u));
});

test("nested loops stay inside one render budget instead of hanging the chat", () => {
  const rows = JSON.stringify(Array.from({ length: 500 }, (_, index) => index));
  const compiled = compileAum(
    `<Visual><Data name="a">${rows}</Data><Each in={$a}><Each in={$a}><Each in={$a}><Text>{$item}</Text></Each></Each></Each></Visual>`,
  );
  assert.ok(compiled.tree);
  const started = Date.now();
  const view = render(
    <AidenUiBlock
      visual={{ version: 1, kind: "ui", id: "ui-loops", title: "Loops", catalogVersion: 1, tree: compiled.tree, dataJson: compiled.dataJson, fallbackText: "" }}
    />,
  );
  assert.ok(view.container.querySelectorAll("p").length <= 2000);
  assert.ok(Date.now() - started < 5000);
});

test("a visual's follow-up waits for the user to confirm the exact text", () => {
  const actions: AidenUiAction[] = [];
  const view = render(<AidenUiBlock visual={visualFrom("tabs")} onAction={(action) => actions.push(action)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose plan" }));
  assert.equal(actions.length, 0);
  const chip = screen.getByRole("group", { name: "Follow-up suggested by Plan options" });
  assert.ok(within(chip).getByText(/Start the team plan/u));
  fireEvent.click(within(chip).getByRole("button", { name: "Send" }));
  assert.deepEqual(actions, [{ kind: "send", text: "Start the team plan" }]);
  assert.equal(screen.queryByRole("group", { name: "Follow-up suggested by Plan options" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Choose plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss follow-up" }));
  assert.equal(actions.length, 1);
  view.rerender(<AidenUiBlock visual={visualFrom("tabs")} onAction={(action) => actions.push(action)} followUpBusy />);
  fireEvent.click(screen.getByRole("button", { name: "Choose plan" }));
  assert.ok(screen.getByRole("button", { name: "Add to draft" }));
});

test("newer saved state re-seeds an untouched visual and merges into a touched one", () => {
  const base = visualFrom("tabs");
  const view = render(<AidenUiBlock visual={{ ...base, state: { plan: "team", seats: 5, annual: false, note: "" } }} />);
  view.rerender(<AidenUiBlock visual={{ ...base, state: { plan: "solo", seats: 5, annual: false, note: "" } }} />);
  assert.equal(screen.getByRole("tab", { name: "Solo" }).getAttribute("aria-selected"), "true");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Team" }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name: "Team" }));
  view.rerender(<AidenUiBlock visual={{ ...base, state: { plan: "solo", seats: 10, annual: false, note: "" } }} />);
  assert.equal(screen.getByRole("tab", { name: "Team" }).getAttribute("aria-selected"), "true");
});

test("an attachment-backed Image draws its picture when given the attachment, and alt text otherwise", () => {
  const compiled = compileAum(`<Visual><Image attachment="photo-1" alt="Original chart" /></Visual>`);
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok(compiled.tree);
  const visual: ChatUiVisualV1 = {
    version: 1,
    kind: "ui",
    id: "ui-image",
    title: "Picture",
    catalogVersion: 1,
    tree: compiled.tree,
    fallbackText: compiled.fallbackText,
  };
  const view = render(<AidenUiBlock visual={visual} />);
  assert.equal(view.container.querySelector("img") === null, true);
  assert.ok(screen.getByText("Original chart"));

  view.rerender(<AidenUiBlock visual={visual} attachments={[{ id: "photo-1", mimeType: "image/png", data: "iVBORw0KGgo=" }]} />);
  const picture = screen.getByRole("img", { name: "Original chart" });
  assert.equal(picture.getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");
});

test("a computed Image reference draws its picture from the snapshot's image set", () => {
  const compiled = compileAum(`<Visual><Image attachment={"photo-" + 1} alt="Original chart" /></Visual>`);
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok(compiled.tree);
  const visual: ChatUiVisualV1 = {
    version: 1,
    kind: "ui",
    id: "ui-computed-image",
    title: "Computed picture",
    catalogVersion: 1,
    tree: compiled.tree,
    fallbackText: compiled.fallbackText,
  };
  const messageImages: Attachment[] = [
    { id: "photo-1", name: "photo-1.png", mimeType: "image/png", kind: "image", size: 4, data: "iVBORw0KGgo=" },
    { id: "photo-2", name: "photo-2.png", mimeType: "image/png", kind: "image", size: 4, data: "AAAA" },
  ];
  // The capture renders with exactly the images the snapshot helper selects.
  const snapshotImages = visualSnapshotImages(visual, messageImages);
  const view = render(<AidenUiBlock visual={visual} attachments={snapshotImages} />);
  const picture = screen.getByRole("img", { name: "Original chart" });
  assert.equal(picture.getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");
  view.unmount();
});

test("visual Markdown never loads a remote image or navigates a link directly", async () => {
  const compiled = compileAum(
    "<Visual><Markdown>![report](https://example.test/collect?data=private)\n\n[Open report](https://example.test/report) and [plain](http://example.test/plain)</Markdown></Visual>",
  );
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok(compiled.tree);
  const visual: ChatUiVisualV1 = {
    version: 1,
    kind: "ui",
    id: "ui-markdown-policy",
    title: "Remote report",
    catalogVersion: 1,
    tree: compiled.tree,
    fallbackText: compiled.fallbackText,
  };
  const actions: AidenUiAction[] = [];
  const view = render(<AidenUiBlock visual={visual} onAction={(action) => actions.push(action)} />);
  const figure = screen.getByRole("figure", { name: "Remote report" });

  // The remote image becomes its alt text: nothing is requested.
  assert.equal(figure.querySelector("img") === null, true);
  assert.ok(within(figure).getByText("report"));
  // Links are never plain anchors; an https link asks first, a non-https one is text.
  assert.equal(figure.querySelector("a[href]") === null, true);
  assert.equal(screen.queryByRole("button", { name: "plain" }), null);
  fireEvent.click(screen.getByText("plain"));
  assert.equal(screen.queryByRole("dialog"), null);

  fireEvent.click(screen.getByRole("button", { name: "Open report" }));
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByText("https://example.test/report"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.deepEqual(actions, []);

  // While the visual is still streaming, its link is visible but cannot act.
  view.rerender(<AidenUiBlock visual={visual} draft />);
  assert.equal((screen.getByRole("button", { name: "Open report" }) as HTMLButtonElement).disabled, true);
});
