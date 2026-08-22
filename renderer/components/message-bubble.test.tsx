import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./message-bubble.js";
import { MessageList } from "./message-list.js";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline.js";

test("user messages render only safe skill provenance", () => {
  const markup = renderToStaticMarkup(
    <MessageBubble
      role="user"
      content="Inspect this."
      skill={{ version: 1, name: "Review", source: "workspace" }}
    />,
  );
  assert.match(markup, /Review/u);
  assert.match(markup, /workspace skill/u);
  assert.doesNotMatch(markup, /invocationId|instructions|SKILL\.md/u);
});

test("legacy messages render unchanged without provenance", () => {
  const markup = renderToStaticMarkup(<MessageBubble role="user" content="Legacy message" />);
  assert.match(markup, /Legacy message/u);
  assert.doesNotMatch(markup, /skill/u);
});

test("assistant image attachments render as an accessible full-screen gallery trigger", () => {
  const markup = renderToStaticMarkup(
    <MessageBubble
      role="assistant"
      content="Here it is."
      attachments={[{
        id: "shared-image",
        name: "Result.png",
        mimeType: "image/png",
        kind: "image",
        size: 12,
        data: "iVBORw0KGgo=",
      }]}
    />,
  );
  assert.match(markup, /data-message-image-gallery/u);
  assert.match(markup, /Open Result\.png full screen/u);
  assert.match(markup, /data:image\/png;base64,iVBORw0KGgo=/u);
});

test("message list forwards persisted assistant image attachments to the gallery", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[{
        id: "assistant-image",
        role: "assistant",
        content: "Shared from the Mac.",
        createdAt: 1,
        attachments: [{
          id: "image-1",
          name: "Desktop.png",
          mimeType: "image/png",
          kind: "image",
          size: 12,
          data: "iVBORw0KGgo=",
        }],
      }]}
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
  assert.match(markup, /Open Desktop\.png full screen/u);
});

test("assistant prose and activity render in chronological order with one copy action", () => {
  const content = "Before.\n\nBetween.\n\nAfter.";
  const tool = (
    order: number,
    contentOffset: number,
    toolName: string,
    target: string,
  ): AgentToolStep => ({
    id: `tool-${order + 1}`,
    order,
    kind: "tool",
    toolCallId: `call-${order + 1}`,
    toolName,
    label: toolName,
    status: "completed",
    startedAt: order + 1,
    updatedAt: order + 1,
    finishedAt: order + 1,
    contentOffset,
    target,
  });
  const timeline: GenerationTimeline = {
    version: 3,
    generationId: "generation-1",
    status: "completed",
    startedAt: 1,
    finishedAt: 3,
    steps: [
      tool(0, "Before.".length, "read_file", "first.txt"),
      tool(1, "Before.\n\nBetween.".length, "edit_file", "second.txt"),
    ],
  };
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: "assistant-1",
          role: "assistant",
          content,
          createdAt: 1,
          timeline,
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

  const before = markup.indexOf("Before.");
  const firstTool = markup.indexOf("first.txt");
  const between = markup.indexOf("Between.");
  const secondTool = markup.indexOf("second.txt");
  const after = markup.indexOf("After.");
  assert.ok(before >= 0 && before < firstTool);
  assert.ok(firstTool < between);
  assert.ok(between < secondTool);
  assert.ok(secondTool < after);
  assert.equal((markup.match(/aria-label="Copy message"/gu) ?? []).length, 1);
});

test("persisted assistant failure renders once with fixed private-safe copy", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[
        {
          id: "assistant-failed",
          role: "assistant",
          content: "Saved partial response",
          createdAt: 1,
          providerFailure: {
            version: 1,
            category: "network",
            attempts: 2,
            retryExhausted: true,
          },
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

  assert.equal((markup.match(/data-provider-failure="network"/gu) ?? []).length, 1);
  assert.match(markup, /role="alert"/u);
  assert.match(markup, /aria-atomic="true"/u);
  assert.equal((markup.match(/Generation failed/gu) ?? []).length, 1);
  assert.match(markup, /after retrying/iu);
});
