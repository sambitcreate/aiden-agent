import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { MessageList } from "./message-list";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline";

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
  const html = view.container.innerHTML;
  const activityAt = html.indexOf("render_ui");
  const visualAt = html.indexOf('data-aiden-ui="ui-board"');
  const afterAt = html.indexOf("After the board.");
  assert.ok(activityAt >= 0 && visualAt > activityAt && afterAt > visualAt, "tool row → visual → later prose");
  fireEvent.click(view.getByRole("button", { name: "More" }));
  assert.deepEqual(prompts, ["Tell me more"]);
});

test("a streaming native draft is inert in its row and the presented visual replaces it", () => {
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
  const draft = view.container.querySelector('[data-aiden-ui="draft-call-ui"]');
  assert.ok(draft);
  assert.equal(draft.getAttribute("aria-busy"), "true");
  view.rerender(list(true));
  assert.equal(view.container.querySelector('[data-aiden-ui="draft-call-ui"]'), null);
  assert.ok(view.container.querySelector('[data-aiden-ui="ui-board"]'));
});
