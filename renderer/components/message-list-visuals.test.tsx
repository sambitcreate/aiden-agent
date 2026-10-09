import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
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
