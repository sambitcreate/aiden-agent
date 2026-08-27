import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./message-bubble.js";
import { MessageList } from "./message-list.js";
import {
  partitionMessageAttachments,
  resolveAttachmentPreviewTrigger,
} from "./message-attachments.js";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  "base64",
);

function imageAttachment(id = "image-1") {
  return {
    id,
    name: "preview.png",
    mimeType: "image/png",
    kind: "image" as const,
    size: ONE_PIXEL_PNG.length,
    data: ONE_PIXEL_PNG.toString("base64"),
  };
}

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

test("persisted assistant images render inline with an accessible preview action", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      chatId="chat-1"
      messages={[
        {
          id: "assistant-image",
          role: "assistant",
          content: "",
          createdAt: 1,
          attachments: [imageAttachment()],
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
  assert.match(markup, /data-message-attachments="assistant"/u);
  assert.match(markup, /aria-label="Open preview\.png preview"/u);
  assert.match(markup, /data:image\/png;base64/u);
  assert.doesNotMatch(markup, /file:\/\//u);
});

test("image-only live Pi artifacts render before assistant prose exists", () => {
  const attachment = imageAttachment("live-image");
  const markup = renderToStaticMarkup(
    <MessageList
      chatId="chat-1"
      messages={[]}
      streamingText=""
      streamingReasoning={null}
      streamingArtifacts={[{ version: 1, kind: "image", attachment }]}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />,
  );
  assert.match(markup, /data-message-attachments="assistant"/u);
  assert.match(markup, /preview\.png/u);
});

test("HTML artifacts render a sandboxed frame chrome before preview loads", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      chatId="chat-html"
      messages={[
        {
          id: "assistant-html",
          role: "assistant",
          content: "",
          createdAt: 1,
          htmlArtifacts: [
            {
              version: 1,
              kind: "html",
              id: "html-1",
              title: "Dependencies",
              mimeType: "text/html",
              size: 12,
              mediaId: "media-1",
            },
          ],
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
  assert.match(markup, /data-html-artifact="media-1"/u);
  assert.match(markup, /Dependencies/u);
  assert.match(markup, /Loading visualization/u);
  assert.doesNotMatch(markup, /<iframe/u);
  assert.doesNotMatch(markup, /allow-same-origin/u);
  assert.doesNotMatch(markup, /<p>hello/u);
});

test("legacy active image MIME is rendered as a file card instead of inline content", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const markup = renderToStaticMarkup(
    <MessageBubble
      role="user"
      content=""
      attachments={[
        {
          id: "legacy-svg",
          name: "legacy.svg",
          mimeType: "image/svg+xml",
          kind: "image",
          size: svg.length,
          data: svg.toString("base64"),
        },
      ]}
    />,
  );
  assert.match(markup, /legacy\.svg/u);
  assert.doesNotMatch(markup, /data:image\/svg\+xml/u);
});

test("an image that fails browser decoding degrades to the safe attachment card", () => {
  const attachment = imageAttachment();
  const partition = partitionMessageAttachments([attachment], new Set([attachment.id]));
  assert.equal(partition.images.length, 0);
  assert.deepEqual(partition.files, [attachment]);
});

test("preview focus follows the same attachment across live-to-persisted handoff", () => {
  const trigger = (id: string, isConnected: boolean): HTMLButtonElement =>
    ({
      isConnected,
      dataset: { attachmentPreviewId: id },
    }) as unknown as HTMLButtonElement;
  const original = trigger("image-1", true);
  assert.equal(resolveAttachmentPreviewTrigger("image-1", original, []), original);

  const disconnectedLiveTrigger = trigger("image-1", false);
  const persistedTrigger = trigger("image-1", true);
  assert.equal(
    resolveAttachmentPreviewTrigger("image-1", disconnectedLiveTrigger, [persistedTrigger]),
    persistedTrigger,
  );
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
      chatId="chat-1"
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

test("assistant images follow chronological prose and display activity", () => {
  const content = "I rendered the preview.";
  const timeline: GenerationTimeline = {
    version: 3,
    generationId: "generation-with-image",
    status: "completed",
    startedAt: 1,
    finishedAt: 2,
    steps: [
      {
        id: "display-step",
        order: 0,
        kind: "tool",
        toolCallId: "display-call",
        toolName: "display_image",
        label: "Display Image",
        status: "completed",
        startedAt: 1,
        updatedAt: 2,
        finishedAt: 2,
        contentOffset: content.length,
        target: "preview.png",
      },
    ],
  };
  const markup = renderToStaticMarkup(
    <MessageList
      chatId="chat-1"
      messages={[
        {
          id: "assistant-image-order",
          role: "assistant",
          content,
          createdAt: 1,
          timeline,
          attachments: [imageAttachment()],
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

  const prose = markup.indexOf(content);
  const activity = markup.indexOf("preview.png");
  const image = markup.indexOf('data-message-attachments="assistant"');
  assert.ok(prose >= 0 && prose < activity);
  assert.ok(activity < image);
});

test("persisted assistant failure renders once with fixed private-safe copy", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      chatId="chat-1"
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
