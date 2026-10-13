import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { MessageList } from "./message-list";
import type { ChatMessage } from "../lib/types";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline";
import type { SubagentMessageReferenceV1, SubagentRunSnapshotV1 } from "../shared/subagent-runs";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

const prompt: ChatMessage = { id: "user-1", role: "user", content: "Show me", createdAt: 1 };

const visual = {
  version: 1 as const,
  kind: "html" as const,
  id: "html-live",
  title: "Chart",
  mimeType: "text/html" as const,
  size: 10,
  mediaId: "media-1",
};

interface Frame {
  messages: ChatMessage[];
  streamingText: string | null;
  streamComplete?: boolean;
  persistedHandoffMessageId?: string | null;
  timeline?: GenerationTimeline | null;
  live?: boolean;
  liveSubagents?: SubagentRunSnapshotV1[];
  subagentsEnabled?: boolean;
}

function transcript({
  messages,
  streamingText,
  streamComplete,
  persistedHandoffMessageId,
  timeline,
  live,
  liveSubagents,
  subagentsEnabled,
}: Frame) {
  return (
    <MessageList
      chatId="chat-settle"
      messages={messages}
      streamingText={streamingText}
      streamingReasoning={null}
      streamingArtifacts={live ? [visual] : []}
      streamComplete={streamComplete}
      persistedHandoffMessageId={persistedHandoffMessageId ?? null}
      timeline={timeline ?? null}
      liveSubagents={liveSubagents ?? []}
      subagentsEnabled={subagentsEnabled ?? false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
      onFork={() => undefined}
    />
  );
}

/** The reply's copy action; the prompt above it has its own. */
function replyCopyButton(): HTMLElement {
  const buttons = screen.getAllByLabelText("Copy message");
  return buttons[buttons.length - 1]!;
}

function copies(container: HTMLElement, text: string): number {
  return [...container.querySelectorAll("p")].filter((paragraph) => paragraph.textContent?.includes(text)).length;
}

test("a finished reply settles in place: one copy during the handoff, the same elements after", () => {
  document.documentElement.dataset.reduceMotion = "true";
  installBotTestIpc({ "chats:htmlArtifactSrcdoc": () => new Promise(() => undefined) });
  const intro = "Here is the snippet you asked for.";
  const reply = `${intro}\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n`;
  const view = render(
    transcript({ messages: [prompt], streamingText: `${intro}\n\n\`\`\`ts\nconst answer = 42;\n`, live: true }),
  );
  const paragraph = screen.getByText(intro).closest("p");
  const code = screen.getByText("const answer = 42;").closest(".group\\/code");
  const card = view.container.querySelector('[data-html-artifact="media-1"]');
  assert.ok(paragraph && code && card, "the live reply shows its prose, open code, and visual");
  // The action row is already laid out, just hidden, so settling never shifts the reply.
  const copy = replyCopyButton();
  assert.ok(copy.closest('[aria-hidden="true"]'), "hidden from assistive tech while streaming");

  // chat:done: the saved message joins the transcript while the reveal finishes.
  const saved: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: reply,
    createdAt: 2,
    htmlArtifacts: [{ ...visual, id: "html-saved" }],
  };
  view.rerender(
    transcript({
      messages: [prompt, saved],
      streamingText: reply,
      streamComplete: true,
      persistedHandoffMessageId: saved.id,
      live: true,
    }),
  );
  assert.equal(copies(view.container, intro), 1, "exactly one copy of the reply during the handoff");
  assert.equal(view.container.querySelectorAll('[data-html-artifact="media-1"]').length, 1);

  // The handoff ends and the live state clears: the saved row is the same row.
  view.rerender(transcript({ messages: [prompt, saved], streamingText: null }));
  assert.equal(copies(view.container, intro), 1);
  assert.equal(screen.getByText(intro).closest("p"), paragraph, "the paragraph is the same element");
  assert.equal(
    screen.getByText("const answer = 42;").closest(".group\\/code"),
    code,
    "the code block highlights in place instead of being replaced",
  );
  assert.equal(view.container.querySelector('[data-html-artifact="media-1"]'), card, "the visual stays mounted");
  assert.equal(replyCopyButton(), copy, "the reserved actions appear in place");
  assert.equal(copy.closest('[aria-hidden="true"]'), null);
  assert.ok(screen.getByRole("button", { name: "Fork from here" }), "and the settled reply gains its fork action");
});

function previews(container: HTMLElement): number {
  return container.querySelectorAll('[data-rich-link-provider="github"]').length;
}

test("a reply settling into its saved message shows its rich preview once", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const link = "[PR](https://github.com/openai/codex/pull/247)";
  const saved: ChatMessage = { id: "assistant-1", role: "assistant", content: link, createdAt: 2 };
  const view = render(transcript({ messages: [prompt], streamingText: `${link}\n\n` }));
  assert.equal(previews(view.container), 1, "the live reply previews its link");
  view.rerender(
    transcript({
      messages: [prompt, saved],
      streamingText: link,
      streamComplete: true,
      persistedHandoffMessageId: saved.id,
    }),
  );
  assert.equal(previews(view.container), 1);
  view.rerender(transcript({ messages: [prompt, saved], streamingText: null }));
  assert.equal(previews(view.container), 1);
});

test("an earlier reply with the same text keeps its own preview while a new one streams", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const repeated = "[PR](https://github.com/openai/codex/pull/247)";
  const messages: ChatMessage[] = [
    prompt,
    { id: "assistant-old", role: "assistant", content: repeated, createdAt: 2 },
    { id: "user-2", role: "user", content: "Again?", createdAt: 3 },
  ];
  for (const handoffId of [null, "missing-current-response"]) {
    const view = render(
      transcript({ messages, streamingText: repeated, streamComplete: true, persistedHandoffMessageId: handoffId }),
    );
    assert.equal(previews(view.container), 2, String(handoffId));
    view.unmount();
  }
});

function toolStep(contentOffset: number): AgentToolStep {
  return {
    id: "tool-1",
    order: 0,
    kind: "tool",
    toolCallId: "call-1",
    toolName: "read_file",
    label: "Read file",
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    contentOffset,
  };
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

test("text closed by a tool step finishes its reveal instead of appearing all at once", async () => {
  const sentences = Array.from({ length: 24 }, (_, index) => `Sentence ${index + 1} ends here.`);
  const text = `${sentences.join(" ")}\n\n`;
  const timeline = (steps: AgentToolStep[]): GenerationTimeline => ({
    version: 3,
    generationId: "generation-1",
    status: "running",
    startedAt: 1,
    steps,
  });
  const view = render(transcript({ messages: [prompt], streamingText: text, timeline: timeline([]) }));
  await wait(30);
  assert.equal(view.container.textContent?.includes("Sentence 24 ends here."), false, "still revealing");

  // A tool call starts: this text is no longer the live tail.
  view.rerender(transcript({ messages: [prompt], streamingText: text, timeline: timeline([toolStep(text.length)]) }));
  assert.ok(view.container.textContent?.includes("Sentence 1 ends here."), "what was shown stays");
  assert.equal(
    view.container.textContent?.includes("Sentence 24 ends here."),
    false,
    "the rest is not dumped in the same frame",
  );
  await wait(1_000);
  assert.ok(view.container.textContent?.includes("Sentence 24 ends here."), "and it finishes revealing");
});

function liveRun(runId: string): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId,
    groupId: "group-1",
    generationId: "generation-1",
    childId: `child-${runId}`,
    chatId: "chat-settle",
    workspaceId: "workspace-1",
    revision: 1,
    role: "scout",
    label: "Code scout",
    taskPreview: "Review the renderer integration",
    state: "running",
    activity: "Reading component boundaries",
    startedAt: 1,
    updatedAt: 2,
    modelId: "test-model",
    turns: 1,
    tools: 1,
    tokens: 10,
    warnings: [],
  };
}

function chipRunIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-subagent-chip-run-id]")].map(
    (chip) => chip.dataset.subagentChipRunId ?? "",
  );
}

test("subagent chips show on live and saved replies only while subagents are enabled", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const reference: SubagentMessageReferenceV1 = {
    version: 1,
    generationId: "generation-0",
    runIds: ["saved-run"],
    total: 1,
    completed: 1,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  };
  const earlier: ChatMessage = {
    id: "assistant-0",
    role: "assistant",
    content: "Earlier answer.",
    createdAt: 0,
    subagents: reference,
  };
  const frame = (subagentsEnabled: boolean): Frame => ({
    messages: [earlier, prompt],
    streamingText: "Working on it.\n\n",
    liveSubagents: [liveRun("live-run")],
    subagentsEnabled,
  });

  const view = render(transcript(frame(true)));
  assert.deepEqual(chipRunIds(view.container).sort(), ["live-run", "saved-run"]);

  view.rerender(transcript(frame(false)));
  assert.deepEqual(chipRunIds(view.container), [], "a disabled capability hides every chip");
});
