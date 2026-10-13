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
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

function timeline(step: AgentToolStep, status: GenerationTimeline["status"] = "running"): GenerationTimeline {
  return { version: 3, generationId: "generation-1", status, startedAt: 1, steps: [step] };
}

function multiTimeline(steps: AgentToolStep[]): GenerationTimeline {
  return { version: 3, generationId: "generation-1", status: "running", startedAt: 1, steps };
}

function imageArtifact(id: string, name = "Generated image.png", mimeType = "image/png"): ChatArtifactV1 {
  return {
    version: 1,
    kind: "image",
    attachment: { id, name, mimeType, kind: "image", size: 68, data: PNG },
  };
}

function list(props: {
  timeline: GenerationTimeline | null;
  messages?: ChatMessage[];
  artifacts?: ChatArtifactV1[];
  /** attachment id → producing generate_image call id, as the host sends it. */
  placements?: ReadonlyMap<string, string>;
  text?: string;
}) {
  return (
    <MessageList
      chatId="chat-1"
      messages={props.messages ?? []}
      streamingText={props.text ?? "Here it is."}
      streamingReasoning={null}
      streamingArtifacts={props.artifacts ?? []}
      streamingArtifactPlacements={props.placements}
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
  // An image not placed on this call is never its result.
  assert.ok(screen.getByRole("button", { name: "Open Generated image.png preview" }));

  const placements = new Map([["new-image", "call-1"]]);
  view.rerender(
    list({
      timeline: timeline(generateStep("running", { detail: "16:9" })),
      artifacts: [before, imageArtifact("new-image")],
      placements,
    }),
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
    list({
      timeline: timeline(generateStep("completed", { detail: "16:9" })),
      artifacts: [before, imageArtifact("new-image")],
      placements,
    }),
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

function revealedSource(stepId: string): string | null {
  return document.querySelector(`[data-image-scan-slot="${stepId}"] img.image-scan-result`)?.getAttribute("src") ?? null;
}

test("parallel calls each reveal only their own image, once, and never a display_image result", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const steps = (status1: AgentToolStep["status"], status2: AgentToolStep["status"]) => [
    generateStep(status1, { id: "tool-1", toolCallId: "call-1", detail: "16:9" }),
    generateStep(status2, { id: "tool-2", toolCallId: "call-2", order: 1, detail: "1:1" }),
    generateStep("completed", { id: "tool-3", toolCallId: "call-3", order: 2, toolName: "display_image", label: "Display image" }),
  ];
  const first = imageArtifact("from-call-1", "First.gif", "image/gif");
  const second = imageArtifact("from-call-2", "Second.png", "image/png");
  const shown = imageArtifact("from-display", "Shown.webp", "image/webp");
  const view = render(list({ timeline: multiTimeline(steps("running", "running")) }));
  assert.equal(screen.getAllByRole("img", { name: /^Generating image/u }).length, 2);

  // Out of order: the second call's image and a display_image result land first.
  const early = new Map([["from-call-2", "call-2"]]);
  view.rerender(list({ timeline: multiTimeline(steps("running", "running")), artifacts: [shown, second], placements: early }));
  assert.equal(revealedSource("tool-1"), null, "the first call keeps scanning");
  assert.match(revealedSource("tool-2") ?? "", /^data:image\/png/u);
  assert.ok(screen.getByRole("button", { name: "Open Shown.webp preview" }), "display_image results are never claimed");

  const all = new Map([["from-call-2", "call-2"], ["from-call-1", "call-1"]]);
  view.rerender(
    list({ timeline: multiTimeline(steps("running", "completed")), artifacts: [shown, second, first], placements: all }),
  );
  assert.match(revealedSource("tool-1") ?? "", /^data:image\/gif/u);
  assert.match(revealedSource("tool-2") ?? "", /^data:image\/png/u);
  assert.equal(screen.queryByRole("button", { name: "Open First.gif preview" }), null);
  assert.equal(screen.queryByRole("button", { name: "Open Second.png preview" }), null);

  view.rerender(
    list({ timeline: multiTimeline(steps("completed", "completed")), artifacts: [shown, second, first], placements: all }),
  );
  await until(() => screen.queryAllByRole("img", { name: /^Generating image/u }).length === 0);
  for (const name of ["First.gif", "Second.png", "Shown.webp"]) {
    assert.equal(screen.getAllByRole("button", { name: `Open ${name} preview` }).length, 1, name);
  }
});

test("an arrived image keeps revealing even if the live list briefly drops it", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const placements = new Map([["img-a", "call-1"]]);
  const view = render(
    list({ timeline: timeline(generateStep("running", { detail: "4:3" })), artifacts: [imageArtifact("img-a")], placements }),
  );
  assert.equal(screen.getByRole("img", { name: "Generating image, 4:3" }).getAttribute("data-arrival"), "reveal");
  view.rerender(list({ timeline: timeline(generateStep("completed", { detail: "4:3" })), artifacts: [], placements }));
  const slot = screen.getByRole("img", { name: "Generating image, 4:3" });
  assert.equal(slot.getAttribute("data-arrival"), "reveal", "never back to scanning");
  assert.ok(slot.querySelector("img.image-scan-result"));
});

test("a call's extra images wait for its reveal, then all show at the call's row before later text", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const step = (status: AgentToolStep["status"]) => generateStep(status, { detail: "1:1", contentOffset: 0 });
  const placements = new Map([["one", "call-1"], ["two", "call-1"]]);
  const artifacts = [imageArtifact("one", "One.png"), imageArtifact("two", "Two.png")];
  const view = render(list({ timeline: timeline(step("running")), artifacts, placements, text: "After the image." }));
  assert.equal(screen.getAllByRole("img", { name: /^Generating image/u }).length, 1);
  assert.equal(screen.queryByRole("button", { name: "Open Two.png preview" }), null, "held until the reveal ends");
  // The live reply's prose reveals progressively; its bubble is the streaming-reveal block.
  const prose = () => document.querySelector(".streaming-reveal")!;
  const slot = document.querySelector("[data-image-scan-slot]")!;
  assert.ok(slot.compareDocumentPosition(prose()) & Node.DOCUMENT_POSITION_FOLLOWING, "the placeholder sits at its row");

  view.rerender(list({ timeline: timeline(step("completed")), artifacts, placements, text: "After the image." }));
  await until(() => screen.queryByRole("img", { name: /^Generating image/u }) === null);
  const one = screen.getByRole("button", { name: "Open One.png preview" });
  const two = screen.getByRole("button", { name: "Open Two.png preview" });
  assert.ok(one.compareDocumentPosition(two) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(two.compareDocumentPosition(prose()) & Node.DOCUMENT_POSITION_FOLLOWING);
});

test("a settled reply draws each generated image at its generate_image row", () => {
  const steps = [
    generateStep("completed", { contentOffset: 6, detail: "16:9" }),
  ];
  const markupOrder = render(
    list({
      timeline: null,
      text: "",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "First. Then more.",
          createdAt: 1,
          timeline: { version: 3, generationId: "g", status: "completed", startedAt: 1, finishedAt: 2, steps },
          attachments: [
            { id: "gen", name: "Generated image.png", mimeType: "image/png", kind: "image", size: 68, data: PNG },
            { id: "upload", name: "Shown.png", mimeType: "image/png", kind: "image", size: 68, data: PNG },
          ],
          imagePlacements: [{ attachmentId: "gen", toolCallId: "call-1" }],
        },
      ],
    }),
  );
  const generated = screen.getByRole("button", { name: "Open Generated image.png preview" });
  const unplaced = screen.getByRole("button", { name: "Open Shown.png preview" });
  const later = screen.getByText(/Then more\./u);
  assert.ok(generated.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING, "anchored before later text");
  assert.ok(later.compareDocumentPosition(unplaced) & Node.DOCUMENT_POSITION_FOLLOWING, "unplaced images stay trailing");
  markupOrder.unmount();
});

test("elapsed time counts from the step's own start, so a remount keeps it", () => {
  const startedAt = Date.now() - 12_000;
  render(list({ timeline: timeline(generateStep("running", { startedAt, updatedAt: startedAt })) }));
  assert.ok(screen.getByText(/Generating · 1[23]s/u));
});
