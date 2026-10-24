import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { ReasoningBlock } from "./reasoning-block";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import { APPEARANCE_CHANGE_EVENT, applyAppearanceConfig, cacheAppearance } from "../lib/appearance-runtime";
import { createDefaultAppearanceConfig } from "../shared/appearance";
import type { BusySendPreference } from "../shared/appearance";
import { ActivityFeed } from "./activity-feed";
import type { GenerationTimeline } from "../shared/generation-timeline";

let queryClient: QueryClient;
let sent: string[];
function preference(mode: BusySendPreference) {
  cacheAppearance({ ...createDefaultAppearanceConfig(), busySendBehavior: mode });
  window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT));
}
beforeEach(() => {
  localStorage.clear();
  sent = [];
  installBotTestIpc({ "settings:get": () => null, "shortcut:get": () => null, "app:renderer-ready": () => null });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
});
afterEach(() => { cleanup(); queryClient.clear(); localStorage.clear(); });
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
function Harness({ generating = true, steer = true }: { generating?: boolean; steer?: boolean }) {
  return <QueryClientProvider client={queryClient}><TooltipProvider><CommandSystemProvider>
    <Composer ready chatId="busy-preferences" hasMessages isGenerating={generating} onStop={() => undefined}
      onSend={async () => { sent.push("send"); }} onQueue={async () => { sent.push("queue"); }}
      onSteer={steer ? async () => { sent.push("steer"); } : undefined} />
  </CommandSystemProvider></TooltipProvider></QueryClientProvider>;
}

test("busy default drives Enter and button; modifier Enter uses the other action", async () => {
  preference("steer");
  render(<Harness />);
  await flush();
  const textbox = screen.getByRole("textbox");
  fireEvent.change(textbox, { target: { value: "Guidance" } });
  fireEvent.keyDown(textbox, { key: "Enter" });
  await flush();
  assert.deepEqual(sent, ["steer"]);
  fireEvent.change(textbox, { target: { value: "Follow-up" } });
  fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
  await flush();
  assert.deepEqual(sent, ["steer", "queue"]);
  fireEvent.change(textbox, { target: { value: "More guidance" } });
  fireEvent.click(screen.getByRole("button", { name: "Steer response" }));
  await flush();
  assert.deepEqual(sent, ["steer", "queue", "steer"]);
});

test("a live settings change updates busy default and unsupported steering safely queues", async () => {
  render(<Harness steer={false} />);
  await flush();
  act(() => preference("steer"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Follow up" } });
  assert.ok(screen.getByRole("button", { name: "Queue message" }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await flush();
  assert.deepEqual(sent, ["queue"]);
});

test("idle modifier Enter sends normally and Shift+Enter never sends", async () => {
  preference("steer");
  render(<Harness generating={false} />);
  await flush();
  const textbox = screen.getByRole("textbox");
  fireEvent.change(textbox, { target: { value: "Request" } });
  fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
  assert.deepEqual(sent, []);
  fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });
  await flush();
  assert.deepEqual(sent, ["send"]);
});

test("reasoning automatic visibility follows lifecycle while manual choices persist", () => {
  const view = render(<ReasoningBlock content="Provider reasoning" automaticOpen />);
  const toggle = screen.getByRole("button", { name: "Thinking" });
  view.rerender(<ReasoningBlock content="Provider reasoning" automaticOpen={false} />);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);
  view.rerender(<ReasoningBlock content="Provider reasoning" automaticOpen={false} />);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(view.container.querySelector("[data-disclosure-layout]")?.getAttribute("data-disclosure-layout"), "full");
  fireEvent.click(toggle);
  view.rerender(<ReasoningBlock content="Provider reasoning" automaticOpen />);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

const completed: GenerationTimeline = {
  version: 3, generationId: "mode-run", startedAt: 1, finishedAt: 2, status: "completed",
  steps: [{ kind: "tool", id: "read", order: 0, toolName: "read_file", toolCallId: "read", label: "Read file", status: "completed", startedAt: 1, updatedAt: 2, target: "prefs.json" }],
};
test("activity levels distinguish collapsed, retained ticker, detailed trail and verbose history", () => {
  const view = render(<ActivityFeed timeline={completed} mode="compact" />);
  const disclosure = view.container.querySelector("details")!;
  assert.equal(disclosure.open, false);
  view.rerender(<ActivityFeed timeline={completed} mode="standard" retainDetails />);
  assert.ok(view.container.querySelector(".activity-feed-window"));
  assert.equal(view.container.querySelector('[role="status"]'), null, "retained completed work is not announced as running");
  view.rerender(<ActivityFeed timeline={completed} mode="detailed" retainDetails />);
  assert.equal(disclosure.open, true);
  view.rerender(<ActivityFeed timeline={completed} mode="detailed" />);
  assert.equal(disclosure.open, false);
  view.rerender(<ActivityFeed timeline={completed} mode="verbose" />);
  assert.equal(disclosure.open, true);
  fireEvent.click(view.container.querySelector("summary")!);
  view.rerender(<ActivityFeed timeline={completed} mode="detailed" retainDetails />);
  assert.equal(disclosure.open, false);
});

test("automatically closing a focused reasoning preview returns focus to its header", () => {
  const view = render(<ReasoningBlock content="Readable details" automaticOpen />);
  const preview = screen.getByRole("region", { name: "Model reasoning" });
  act(() => preview.focus());
  assert.equal(document.activeElement, preview);
  view.rerender(<ReasoningBlock content="Readable details" automaticOpen={false} />);
  assert.equal(document.activeElement, screen.getByRole("button", { name: "Thinking" }));
});

test("live preferences survive route remounts when browser storage cannot save", async () => {
  const view = render(<Harness />);
  await flush();
  const storage = mock.method(localStorage, "setItem", () => { throw new Error("storage full"); });
  try {
    await act(async () => {
      applyAppearanceConfig({ ...createDefaultAppearanceConfig(), busySendBehavior: "steer" }, false, false);
      await Promise.resolve();
    });
    assert.equal(localStorage.getItem("aiden-agent.appearance-v1"), null);
    assert.ok(screen.getByRole("button", { name: "Steer response" }));
    view.unmount();
    render(<Harness />);
    await flush();
    assert.ok(screen.getByRole("button", { name: "Steer response" }), "the remounted composer keeps the accepted preference");
  } finally {
    storage.mock.restore();
    await act(async () => {
      applyAppearanceConfig(createDefaultAppearanceConfig(), false, false);
      await Promise.resolve();
    });
  }
});

test("automatic trail collapse restores a stuck reader before hiding details, but respects tail following", () => {
  let restores = 0;
  const view = render(<div data-follow="false"><ActivityFeed timeline={completed} mode="detailed" retainDetails /></div>);
  const section = view.container.querySelector("details")!;
  const header = section.querySelector("summary")!;
  section.getBoundingClientRect = () => ({ top: -80 }) as DOMRect;
  header.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  section.scrollIntoView = () => { restores += 1; };
  view.rerender(<div data-follow="false"><ActivityFeed timeline={completed} mode="detailed" /></div>);
  assert.equal(restores, 1);
  view.rerender(<div data-follow="true"><ActivityFeed timeline={completed} mode="detailed" retainDetails /></div>);
  view.rerender(<div data-follow="true"><ActivityFeed timeline={completed} mode="detailed" /></div>);
  assert.equal(restores, 1, "the follow latch owns the new-message destination");
});

test("Queue default supports alternate steering and an unavailable alternate preserves the draft", async () => {
  const view = render(<Harness />);
  await flush();
  const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(textbox, { target: { value: "Guide the response" } });
  fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });
  await flush();
  assert.deepEqual(sent, ["steer"]);
  view.rerender(<Harness steer={false} />);
  fireEvent.change(textbox, { target: { value: "Keep this draft" } });
  fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
  await flush();
  assert.deepEqual(sent, ["steer"]);
  assert.equal(textbox.value, "Keep this draft");
});
