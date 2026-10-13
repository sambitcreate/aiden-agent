import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MessageList } from "./message-list";
import type { ChatMessage } from "../lib/types";
import type { ChatArtifactV1 } from "../shared/chat-artifacts";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

function generateStep(status: AgentToolStep["status"], extra: Partial<AgentToolStep> = {}): AgentToolStep {
  return {
    id: "tool-1",
    order: 0,
    kind: "tool",
    toolCallId: "call-1",
    toolName: "generate_image",
    label: "Generate image",
    status,
    startedAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function timeline(step: AgentToolStep, status: GenerationTimeline["status"] = "running"): GenerationTimeline {
  return { version: 3, generationId: "generation-1", status, startedAt: 1, steps: [step] };
}

function imageArtifact(id: string): ChatArtifactV1 {
  return {
    version: 1,
    kind: "image",
    attachment: { id, name: "Generated image.png", mimeType: "image/png", kind: "image", size: 68, data: PNG },
  };
}

function list(props: {
  timeline: GenerationTimeline | null;
  messages?: ChatMessage[];
  artifacts?: ChatArtifactV1[];
}) {
  return (
    <MessageList
      chatId="chat-1"
      messages={props.messages ?? []}
      streamingText="Here it is."
      streamingReasoning={null}
      streamingArtifacts={props.artifacts ?? []}
      timeline={props.timeline}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
    />
  );
}

/** Polls with real timers (the reveal ends on a timer). */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  }
}

function placeholders(markup: string): string[] {
  return [...markup.matchAll(/aria-label="(Generating image, [^"]+)"/gu)].map((match) => match[1]!);
}

test("a running generate_image call holds a placeholder at its requested shape, with a live caption", () => {
  const markup = renderToStaticMarkup(
    list({ timeline: timeline(generateStep("running", { detail: "16:9", target: "fal/fal-ai/nano-banana-pro" })) }),
  );
  assert.deepEqual(placeholders(markup), ["Generating image, 16:9"]);
  assert.match(markup, /Generating · 0s/u);
  assert.match(markup, /fal · Nano Banana Pro/u);
});

test("a call without a known aspect ratio is square", () => {
  for (const detail of [undefined, "21:9", "wide"]) {
    const markup = renderToStaticMarkup(list({ timeline: timeline(generateStep("running", detail ? { detail } : {})) }));
    assert.deepEqual(placeholders(markup), ["Generating image, 1:1"], String(detail));
  }
});

test("no placeholder while the call is being written, awaits approval, or has finished", () => {
  for (const status of ["pending", "awaiting_approval", "completed", "failed", "cancelled", "blocked"] as const) {
    const markup = renderToStaticMarkup(list({ timeline: timeline(generateStep(status, { detail: "16:9" })) }));
    assert.deepEqual(placeholders(markup), [], status);
  }
  const otherTool = renderToStaticMarkup(
    list({ timeline: timeline(generateStep("running", { toolName: "share_image", detail: "16:9" })) }),
  );
  assert.deepEqual(placeholders(otherTool), []);
});

test("a persisted response never shows a stale placeholder", () => {
  const markup = renderToStaticMarkup(
    list({
      timeline: null,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Done.",
          createdAt: 1,
          timeline: timeline(generateStep("running", { detail: "9:16" }), "failed"),
        },
      ],
    }),
  );
  assert.deepEqual(placeholders(markup), []);
});

test("Reduce Motion renders the still pose", () => {
  document.documentElement.dataset.reduceMotion = "true";
  render(list({ timeline: timeline(generateStep("running", { detail: "3:4" })) }));
  const frame = document.querySelector(".image-scan");
  assert.equal(frame?.getAttribute("data-motion"), "still");
  delete document.documentElement.dataset.reduceMotion;
  cleanup();
  render(list({ timeline: timeline(generateStep("running", { detail: "3:4" })) }));
  assert.equal(document.querySelector(".image-scan")?.getAttribute("data-motion"), "animate");
});

test("an arriving image is revealed in the placeholder, then shown as an ordinary attachment", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const before = imageArtifact("earlier-image");
  const view = render(list({ timeline: timeline(generateStep("running", { detail: "16:9" })), artifacts: [before] }));
  assert.ok(screen.getByRole("img", { name: "Generating image, 16:9" }));
  // An image already in the response is not this call's result.
  assert.ok(screen.getByRole("button", { name: "Open Generated image.png preview" }));

  view.rerender(
    list({ timeline: timeline(generateStep("running", { detail: "16:9" })), artifacts: [before, imageArtifact("new-image")] }),
  );
  const slot = screen.getByRole("img", { name: "Generating image, 16:9" });
  assert.equal(slot.getAttribute("data-arrival"), "reveal");
  assert.ok(slot.querySelector("img.image-scan-result"), "the image is revealed inside the placeholder");
  assert.equal(
    screen.getAllByRole("button", { name: "Open Generated image.png preview" }).length,
    1,
    "the revealed image is not also in the attachment grid",
  );

  view.rerender(
    list({ timeline: timeline(generateStep("completed", { detail: "16:9" })), artifacts: [before, imageArtifact("new-image")] }),
  );
  assert.ok(screen.queryByRole("img", { name: "Generating image, 16:9" }), "completion does not cut the reveal short");
  await until(() => screen.queryByRole("img", { name: "Generating image, 16:9" }) === null);
  assert.equal(screen.getAllByRole("button", { name: "Open Generated image.png preview" }).length, 2);
});

test("a failed call drops its placeholder without an image", () => {
  const view = render(list({ timeline: timeline(generateStep("running", { detail: "1:1" })) }));
  assert.ok(screen.getByRole("img", { name: "Generating image, 1:1" }));
  view.rerender(list({ timeline: timeline(generateStep("failed", { detail: "1:1" })) }));
  assert.equal(screen.queryByRole("img", { name: "Generating image, 1:1" }), null);
  view.rerender(list({ timeline: timeline(generateStep("completed", { detail: "1:1" })) }));
  assert.equal(screen.queryByRole("img", { name: "Generating image, 1:1" }), null);
});
