import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { MessageList } from "./message-list";
import { Toaster } from "./ui";
import { KeepVisualChatContext } from "../lib/visual-menu-actions";
import { DesignModeControlsContext, noteDesignCanvasView, type DesignModeControls, type DesignModeSource } from "../lib/design-mode";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline";
import { mapRemoteMessage } from "../lib/hosts/remote-chat-mapper";

afterEach(() => cleanup());

const visual = {
  version: 1 as const,
  kind: "html" as const,
  id: "html-live",
  title: "Chart",
  mimeType: "text/html" as const,
  size: 10,
  mediaId: "media-live",
};

function toolStep(id: string, toolCallId: string, toolName: string, contentOffset: number): AgentToolStep {
  return {
    id, order: 0, kind: "tool", toolCallId, toolName, label: toolName,
    status: "running", startedAt: 1, updatedAt: 1, contentOffset,
  };
}

function liveList(text: string, steps: AgentToolStep[]) {
  const timeline: GenerationTimeline = {
    version: 3, generationId: "generation-1", status: "running", startedAt: 1, steps,
  };
  return (
    <MessageList
      chatId="chat-live"
      messages={[]}
      streamingText={text}
      streamingReasoning={null}
      streamingArtifacts={[visual]}
      streamingArtifactPlacements={new Map([[visual.mediaId, "call-render"]])}
      timeline={timeline}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />
  );
}

test("a streaming draft renders in its tool row and yields to the presented visual", () => {
  installBotTestIpc({ "chats:htmlArtifactSrcdoc": () => new Promise(() => undefined) });
  const intro = "Before chart.";
  const renderStep = toolStep("tool-1", "call-render", "render_artifact", intro.length);
  const timeline: GenerationTimeline = {
    version: 3, generationId: "generation-1", status: "running", startedAt: 1, steps: [renderStep],
  };
  const draftSrc = `aiden-genui://preview/${"d".repeat(64)}`;
  const list = (presented: boolean) => (
    <MessageList
      chatId="chat-live"
      messages={[]}
      streamingText={`${intro} After chart.`}
      streamingReasoning={null}
      streamingArtifacts={presented ? [visual] : []}
      streamingArtifactPlacements={new Map([[visual.mediaId, "call-render"]])}
      streamingVisualDrafts={presented ? new Map() : new Map([["call-render", { src: draftSrc, title: "Chart" }]])}
      timeline={timeline}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />
  );
  const view = render(list(false));
  // Live prose reveals over animation frames, so anchor on the tool's activity row.
  const html = view.container.innerHTML;
  const activityAt = html.indexOf("render_artifact");
  const draftAt = html.indexOf("data-inline-visual-draft");
  assert.ok(activityAt >= 0 && draftAt > activityAt, "the draft follows its tool's activity row");
  assert.equal(view.container.querySelector("[data-inline-visual-draft] iframe")?.getAttribute("src"), draftSrc);

  view.rerender(list(true));
  assert.equal(view.container.querySelector("[data-inline-visual-draft]"), null);
  assert.ok(view.container.querySelector('[data-html-artifact="media-live"]'));
});

test("visuals the model asked to make wide render wide, live and once saved", () => {
  installBotTestIpc({ "chats:htmlArtifactSrcdoc": () => new Promise(() => undefined) });
  const renderStep = toolStep("tool-1", "call-render", "render_artifact", 0);
  const timeline: GenerationTimeline = {
    version: 3, generationId: "generation-1", status: "running", startedAt: 1, steps: [renderStep],
  };
  const live = render(
    <MessageList
      chatId="chat-live"
      messages={[]}
      streamingText="Board."
      streamingReasoning={null}
      streamingArtifacts={[visual]}
      streamingArtifactPlacements={new Map([[visual.mediaId, "call-render"]])}
      streamingWideVisuals={new Set([visual.mediaId])}
      timeline={timeline}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />,
  );
  assert.equal(live.container.querySelector('[data-html-artifact="media-live"]')?.getAttribute("data-layout"), "wide");
  live.unmount();

  const saved = render(
    <MessageList
      chatId="chat-saved"
      messages={[
        {
          id: "m-1",
          role: "assistant",
          content: "Board.",
          createdAt: 1,
          htmlArtifacts: [visual, { ...visual, id: "html-2", mediaId: "media-column", title: "Card" }],
          htmlArtifactPlacements: [{ mediaId: visual.mediaId, toolCallId: "call-render", layout: "wide" }],
        },
      ]}
      streamingText={null}
      streamingReasoning={null}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />,
  );
  assert.equal(saved.container.querySelector('[data-html-artifact="media-live"]')?.getAttribute("data-layout"), "wide");
  assert.equal(saved.container.querySelector('[data-html-artifact="media-column"]')?.hasAttribute("data-layout"), false);
});

test("a live visual keeps its node when a later tool step outruns the buffered text", () => {
  installBotTestIpc({ "chats:htmlArtifactSrcdoc": () => new Promise(() => undefined) });
  const intro = "Before chart.";
  const renderStep = toolStep("tool-1", "call-render", "render_artifact", intro.length);
  const view = render(liveList(`${intro} After`, [renderStep]));
  const before = view.container.querySelector('[data-html-artifact="media-live"]');
  assert.ok(before);

  // Main stamps the next step at the full text length before the renderer's
  // buffered delta lands, so the step briefly points past the visible text.
  const ahead = toolStep("tool-2", "call-read", "read_file", `${intro} After chart, more text`.length);
  view.rerender(liveList(`${intro} After`, [renderStep, ahead]));
  const during = view.container.querySelector('[data-html-artifact="media-live"]');
  // Compare identities as booleans: printing happy-dom nodes in a diff hangs.
  assert.equal(during === before, true, "the live visual was remounted");
  assert.equal(view.container.querySelectorAll('[data-html-artifact="media-live"]').length, 1);
});

const NATIVE = {
  version: 1 as const,
  kind: "ui" as const,
  id: "ui-board",
  toolCallId: "call-ui",
  title: "Board",
  catalogVersion: 1,
  tree: {
    t: "Visual",
    k: "0",
    c: [
      { t: "Text", k: "0.0", c: [{ t: "#text", k: "0.0.0", s: "Native body" }] },
      {
        t: "Button",
        k: "0.1",
        p: { action: { act: "send" as const, text: { op: "lit" as const, v: "Tell me more" } } },
        c: [{ t: "#text", k: "0.1.0", s: "More" }],
      },
    ],
  },
  fallbackText: "Native body",
};

test("a saved native visual renders after its tool row and sends follow-ups through the shared handler", async () => {
  const intro = "Before the board.";
  const step = { ...toolStep("tool-1", "call-ui", "render_ui", intro.length), status: "completed" as const, finishedAt: 2 };
  const prompts: string[] = [];
  const view = render(
    <MessageList
      chatId="chat-saved"
      messages={[
        {
          id: "m-1",
          role: "assistant",
          content: `${intro} After the board.`,
          createdAt: 1,
          timeline: { version: 3, generationId: "g", status: "completed", startedAt: 1, finishedAt: 3, steps: [step] },
          uiVisuals: [NATIVE],
        },
      ]}
      streamingText={null}
      streamingReasoning={null}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      onVisualPrompt={(text) => prompts.push(text)}
      agentActivity={null}
      error={null}
    />,
  );
  await waitFor(() => assert.ok(view.container.querySelector('[data-aiden-ui="ui-board"]')));
  const html = view.container.innerHTML;
  const activityAt = html.indexOf("render_ui");
  const visualAt = html.indexOf('data-aiden-ui="ui-board"');
  const afterAt = html.indexOf("After the board.");
  assert.ok(activityAt >= 0 && visualAt > activityAt && afterAt > visualAt, "tool row → visual → later prose");
  fireEvent.click(view.getByRole("button", { name: "More" }));
  assert.deepEqual(prompts, [], "a follow-up waits for confirmation");
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  assert.deepEqual(prompts, ["Tell me more"]);
});

test("a reply starting or ending updates a saved visual's pending follow-up", async () => {
  const list = (busy: boolean) => (
    <MessageList
      chatId="chat-saved"
      messages={[{ id: "m-1", role: "assistant", content: "Board.", createdAt: 1, uiVisuals: [NATIVE] }]}
      streamingText={null}
      streamingReasoning={null}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      onVisualPrompt={() => undefined}
      visualFollowUpBusy={busy}
      agentActivity={null}
      error={null}
    />
  );
  const view = render(list(false));
  fireEvent.click(await view.findByRole("button", { name: "More" }));
  assert.ok(view.getByRole("button", { name: "Send" }));
  view.rerender(list(true));
  assert.ok(view.getByRole("button", { name: "Add to draft" }));
  assert.equal(view.queryByRole("button", { name: "Send" }), null);
  view.rerender(list(false));
  assert.ok(view.getByRole("button", { name: "Send" }));
});

test("a streaming native draft is inert in its row and the presented visual replaces it", async () => {
  const step = toolStep("tool-1", "call-ui", "render_ui", 0);
  const timeline: GenerationTimeline = { version: 3, generationId: "g", status: "running", startedAt: 1, steps: [step] };
  const list = (presented: boolean) => (
    <MessageList
      chatId="chat-live"
      messages={[]}
      streamingText="Board."
      streamingReasoning={null}
      streamingUiVisuals={presented ? [NATIVE] : []}
      streamingUiDrafts={presented ? new Map() : new Map([["call-ui", { ...NATIVE, id: "draft-call-ui" }]])}
      timeline={timeline}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />
  );
  const view = render(list(false));
  await waitFor(() => assert.ok(view.container.querySelector('[data-aiden-ui="draft-call-ui"]')));
  const draft = view.container.querySelector('[data-aiden-ui="draft-call-ui"]');
  assert.ok(draft);
  assert.equal(draft.getAttribute("aria-busy"), "true");
  view.rerender(list(true));
  assert.equal(view.container.querySelector('[data-aiden-ui="draft-call-ui"]'), null);
  assert.ok(view.container.querySelector('[data-aiden-ui="ui-board"]'));
});

test("a remote chat draws another computer's native visual as its text, after its tool row, with nothing to press inside", async () => {
  const intro = "Before the board.";
  const step = { ...toolStep("tool-1", "call-1", "render_ui", intro.length), status: "completed" as const, finishedAt: 2 };
  const message = mapRemoteMessage({
    id: "m-1", role: "assistant", text: `${intro} After the board.`, createdAt: new Date(1).toISOString(),
    timeline: { version: 3, generationId: "g", status: "completed", startedAt: 1, finishedAt: 3, steps: [step] },
    visuals: [{ id: "ui-remote", kind: "ui", title: "Revenue", toolCallId: "call-1", fallbackText: "By month (bar chart, 2 points)\nmonth: Jan · revenue: $1,200.00\n<Button label=\"Approve\" />" }],
  });
  assert.ok(message);
  const view = render(
    <MessageList
      chatId="chat-remote"
      messages={[message]}
      storedImageActions={false}
      streamingText={null}
      streamingReasoning={null}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />,
  );
  await waitFor(() => assert.ok(view.container.querySelector('[data-aiden-ui="ui-remote"]')));
  const block = view.container.querySelector('[data-aiden-ui="ui-remote"]');
  assert.ok(block, "the visual is drawn");
  const html = view.container.innerHTML;
  assert.ok(html.indexOf("render_ui") < html.indexOf('data-aiden-ui="ui-remote"') && html.indexOf('data-aiden-ui="ui-remote"') < html.indexOf("After the board."));
  // Each line is its own paragraph, markup in the text included, and there is nothing to act on inside it.
  assert.deepEqual([...block.querySelectorAll("p")].map((line) => line.textContent), [
    "By month (bar chart, 2 points)", "month: Jan · revenue: $1,200.00", "<Button label=\"Approve\" />",
  ]);
  assert.equal(view.queryByRole("button", { name: "Approve" }), null);
  assert.ok(view.getByRole("button", { name: "Copy Revenue as text" }));
});

function savedList(message: Record<string, unknown>, wrap: (list: React.ReactElement) => React.ReactElement = (list) => list) {
  return wrap(
    <>
      <MessageList
        chatId="chat-saved"
        messages={[{ id: "m-1", role: "assistant", content: "Board.", createdAt: 1, ...message }]}
        streamingText={null}
        streamingReasoning={null}
        timeline={null}
        liveSubagents={[]}
        subagentsEnabled={false}
        onOpenSubagent={() => undefined}
        agentActivity={null}
        error={null}
      />
      <Toaster />
    </>,
  );
}

async function openVisualMenu(title: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `Actions for ${title}` }), { button: 0, pointerType: "mouse" });
  await screen.findByRole("menu");
}

test("a native visual offers Keep in Artifacts from its caption menu only once settled in a chat that can keep it", async () => {
  const kept: unknown[][] = [];
  const calls = installBotTestIpc({
    "workspaces:artifacts:keepVisual": (...args) => {
      kept.push(args);
      return { id: "art-1" };
    },
  });
  // Without a workspace to keep it in (a Bot, the Assistant, a remote chat), Copy stays the only action.
  const plain = render(savedList({ uiVisuals: [NATIVE] }));
  assert.ok(await screen.findByRole("button", { name: "Copy Board as text" }));
  assert.equal(screen.queryByRole("button", { name: "Actions for Board" }), null);
  plain.unmount();

  // A visual still streaming has no saved reply to keep it from.
  const live = render(
    <KeepVisualChatContext.Provider value="chat-live">
      <MessageList
        chatId="chat-live"
        messages={[]}
        streamingText="Board."
        streamingReasoning={null}
        streamingUiVisuals={[NATIVE]}
        timeline={{ version: 3, generationId: "g", status: "running", startedAt: 1, steps: [toolStep("tool-1", "call-ui", "render_ui", 0)] }}
        liveSubagents={[]}
        subagentsEnabled={false}
        onOpenSubagent={() => undefined}
        agentActivity={null}
        error={null}
      />
    </KeepVisualChatContext.Provider>,
  );
  assert.ok(await screen.findByRole("button", { name: "Copy Board as text" }));
  live.unmount();

  render(savedList({ uiVisuals: [NATIVE] }, (list) => <KeepVisualChatContext.Provider value="chat-saved">{list}</KeepVisualChatContext.Provider>));
  await screen.findByRole("button", { name: "Actions for Board" });
  assert.equal(screen.queryByRole("button", { name: "Copy Board as text" }), null);
  await openVisualMenu("Board");
  assert.ok(screen.getByRole("menuitem", { name: "Copy as text" }), "the visual's own action stays in the menu");
  fireEvent.click(screen.getByRole("menuitem", { name: "Keep in Artifacts" }));
  await screen.findByText("Kept in Artifacts.");
  assert.deepEqual(kept, [["chat-saved", "m-1", "ui-board"]]);
  assert.equal(calls.filter((call) => call.channel === "workspaces:artifacts:keepVisual").length, 1);
});

test("a refused keep tells the person why without the IPC wrapper", async () => {
  installBotTestIpc({
    "workspaces:artifacts:keepVisual": () => {
      throw new Error("Error invoking remote method 'workspaces:artifacts:keepVisual': Error: This workspace already has 20 artifacts.");
    },
  });
  render(savedList({ uiVisuals: [NATIVE] }, (list) => <KeepVisualChatContext.Provider value="chat-saved">{list}</KeepVisualChatContext.Provider>));
  await screen.findByRole("button", { name: "Actions for Board" });
  await openVisualMenu("Board");
  fireEvent.click(screen.getByRole("menuitem", { name: "Keep in Artifacts" }));
  await screen.findByText("This workspace already has 20 artifacts.");
});

function designControls(on: boolean, changes: Array<[boolean, DesignModeSource]>): DesignModeControls {
  return {
    chatId: "chat-saved",
    on,
    set: (enabled, source) => changes.push([enabled, source]),
    toggle: () => undefined,
  };
}

test("an HTML visual offers Send to canvas only where design mode is available, and sending turns design mode on", async () => {
  const placed: unknown[][] = [];
  installBotTestIpc({
    "chats:htmlArtifactSrcdoc": () => new Promise(() => undefined),
    "designCanvas:placeArtifact": (...args) => {
      placed.push(args);
      return { status: "placed", frameId: "frame-1" };
    },
  });
  const plain = render(savedList({ htmlArtifacts: [visual] }));
  assert.ok(screen.getByRole("button", { name: "Export Chart" }));
  assert.equal(screen.queryByRole("button", { name: "Actions for Chart" }), null);
  plain.unmount();

  // Design mode belongs to another chat: this one cannot send there.
  const other = render(
    savedList({ htmlArtifacts: [visual] }, (list) => (
      <DesignModeControlsContext.Provider value={{ ...designControls(false, []), chatId: "chat-other" }}>{list}</DesignModeControlsContext.Provider>
    )),
  );
  assert.ok(screen.getByRole("button", { name: "Export Chart" }));
  other.unmount();

  const changes: Array<[boolean, DesignModeSource]> = [];
  render(
    savedList({ htmlArtifacts: [visual] }, (list) => (
      <DesignModeControlsContext.Provider value={designControls(false, changes)}>{list}</DesignModeControlsContext.Provider>
    )),
  );
  await openVisualMenu("Chart");
  assert.ok(screen.getByRole("menuitem", { name: "Export…" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Send to canvas" }));
  await screen.findByText("Sent to the canvas.");
  assert.deepEqual(placed, [["chat-saved", "media-live"]]);
  assert.deepEqual(changes, [[true, "toggle"]]);
});

test("Send to canvas leaves design mode alone when it is on, and a canvas with no room says so", async (t) => {
  let answer: unknown = { status: "already", frameId: "frame-1" };
  const placed: unknown[][] = [];
  installBotTestIpc({
    "chats:htmlArtifactSrcdoc": () => new Promise(() => undefined),
    "designCanvas:placeArtifact": (...args) => {
      placed.push(args);
      return answer;
    },
  });
  // The open canvas's size on screen goes with the request, so the frame lands in view.
  noteDesignCanvasView("chat-saved", { selection: [], viewSize: { w: 1440, h: 900 } });
  t.after(() => noteDesignCanvasView("chat-saved", null));
  const changes: Array<[boolean, DesignModeSource]> = [];
  render(
    savedList({ htmlArtifacts: [visual] }, (list) => (
      <DesignModeControlsContext.Provider value={designControls(true, changes)}>{list}</DesignModeControlsContext.Provider>
    )),
  );
  await openVisualMenu("Chart");
  fireEvent.click(screen.getByRole("menuitem", { name: "Send to canvas" }));
  await screen.findByText("That visual is already on the canvas.");
  assert.deepEqual(placed, [["chat-saved", "media-live", { viewSize: { w: 1440, h: 900 } }]]);

  // Already there on another page: the canvas shows that page, and the toast names it.
  answer = { status: "already", frameId: "frame-1", page: "Ideas" };
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
  await openVisualMenu("Chart");
  fireEvent.click(screen.getByRole("menuitem", { name: "Send to canvas" }));
  await screen.findByText("That visual is already on the canvas, on the page “Ideas”.");

  answer = { error: "full" };
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
  await openVisualMenu("Chart");
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to canvas" }));
  });
  await screen.findByText(/no room for another frame/u);
  assert.deepEqual(changes, [], "design mode was already on, and a refused send changes nothing");
});
