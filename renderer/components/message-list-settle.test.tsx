import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { MessageList } from "./message-list";
import { withCommittedRunInput } from "../lib/chat-message-queue";
import type { ChatMessage } from "../lib/types";
import type { ChatArtifactV1 } from "../shared/chat-artifacts";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline";
import type { SubagentMessageReferenceV1, SubagentRunSnapshotV1 } from "../shared/subagent-runs";
import { STREAMING_REVEAL_FADE_MS, STREAMING_REVEAL_RELEASE_MS, STREAMING_REVEAL_MAX_WAIT_MS } from "../lib/streaming-reveal";

afterEach(() => {
  mock.restoreAll();
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
  reasoning?: string | null;
  streamingArtifacts?: readonly ChatArtifactV1[];
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
  reasoning,
  streamingArtifacts,
}: Frame) {
  return (
    <MessageList
      chatId="chat-settle"
      messages={messages}
      streamingText={streamingText}
      streamingReasoning={reasoning ?? null}
      streamingArtifacts={streamingArtifacts ?? (live ? [visual] : [])}
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

/** The rendered Markdown of the reply that shows `text`: its whole document root. */
function replyMarkdown(container: HTMLElement, text: string): string {
  const paragraph = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes(text));
  assert.ok(paragraph?.parentElement, `a paragraph with ${JSON.stringify(text)}`);
  return paragraph.parentElement.innerHTML;
}

test("a streamed reply settles into exactly what the same reply renders from history", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const reply = [
    "Read the [design notes][notes] first.[^review]",
    "",
    "- The first point",
    "",
    "  It has a second paragraph.",
    "",
    "- The second point",
    "",
    "[notes]: https://example.com/notes",
    "[^review]: Written during the review.",
    "",
  ].join("\n");
  const saved: ChatMessage = { id: "assistant-1", role: "assistant", content: reply, createdAt: 2 };

  const history = render(transcript({ messages: [prompt, saved], streamingText: null }));
  const expected = replyMarkdown(history.container, "Read the");
  history.unmount();
  // The oracle itself resolves what a block-by-block render cannot.
  const parsed = document.createElement("div");
  parsed.innerHTML = expected;
  assert.equal(parsed.querySelector("a")?.getAttribute("href"), "https://example.com/notes");
  assert.equal(parsed.querySelectorAll("ul").length, 1, "one loose list");
  assert.ok(parsed.querySelector("section")?.textContent?.includes("Written during the review."));

  const view = render(transcript({ messages: [prompt], streamingText: reply.slice(0, 40) }));
  for (const end of [80, 120, reply.length]) {
    view.rerender(transcript({ messages: [prompt], streamingText: reply.slice(0, end) }));
  }
  view.rerender(
    transcript({
      messages: [prompt, saved],
      streamingText: reply,
      streamComplete: true,
      persistedHandoffMessageId: saved.id,
    }),
  );
  assert.equal(replyMarkdown(view.container, "Read the"), expected, "the finished reveal");
  view.rerender(transcript({ messages: [prompt, saved], streamingText: null }));
  assert.equal(replyMarkdown(view.container, "Read the"), expected, "the settled reply");
});

test("a reply settling behind a queued prompt keeps its place and its elements", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const text = "The first answer.";
  const saved: ChatMessage = { id: "assistant-1", role: "assistant", content: text, createdAt: 2 };
  const queued: ChatMessage = { id: "user-2", role: "user", content: "And then?", createdAt: 3 };
  const view = render(transcript({ messages: [prompt], streamingText: `${text}\n\n` }));
  const paragraph = screen.getByText(text).closest("p");
  assert.ok(paragraph);

  // The queued prompt is saved after the reply while the reply still hands over.
  view.rerender(
    transcript({
      messages: [prompt, saved, queued],
      streamingText: text,
      streamComplete: true,
      persistedHandoffMessageId: saved.id,
    }),
  );
  const follows = (first: Node, second: Node) =>
    Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(screen.getByText(text).closest("p"), paragraph, "the reply is not remounted");
  assert.ok(follows(paragraph, screen.getByText("And then?")), "and it stays above the queued prompt");

  view.rerender(transcript({ messages: [prompt, saved, queued], streamingText: null }));
  assert.equal(screen.getByText(text).closest("p"), paragraph, "the saved reply is the same element");
});

test("a new answer to a prompt that already has one starts with its own sections closed", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const answered: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "The first answer.",
    reasoning: "Earlier thinking.",
    createdAt: 2,
  };
  const view = render(transcript({ messages: [prompt, answered], streamingText: null }));
  const header = view.container.querySelector<HTMLButtonElement>("section > button[aria-expanded]");
  assert.ok(header, "the saved reasoning has a disclosure");
  act(() => header.click());
  assert.equal(header.closest("section")?.dataset.disclosureLayout, "full", "the reader opened it");

  // The saved answer is replaced by a fresh one streaming in its place.
  view.rerender(transcript({ messages: [prompt], streamingText: "", reasoning: "Fresh thinking." }));
  const live = view.container.querySelector<HTMLButtonElement>("section > button[aria-expanded]");
  assert.equal(live?.getAttribute("aria-expanded"), "false", "the new reasoning starts closed");
  assert.equal(live?.closest("section")?.dataset.disclosureLayout, "collapsed");
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

test("text closed by a tool step joins whole at the next release", async () => {
  const text = "Checked the config.\n\nNow reading the file that defines";
  const timeline = (steps: AgentToolStep[]): GenerationTimeline => ({
    version: 3,
    generationId: "generation-1",
    status: "running",
    startedAt: 1,
    steps,
  });
  const view = render(transcript({ messages: [prompt], streamingText: text, timeline: timeline([]) }));
  assert.ok(view.container.textContent?.includes("Checked the config."));
  assert.equal(view.container.textContent?.includes("Now reading"), false, "an unfinished sentence waits");

  // A tool call starts: this text can no longer grow, so its end is a boundary
  // that joins at the next release instead of all at once.
  view.rerender(transcript({ messages: [prompt], streamingText: text, timeline: timeline([toolStep(text.length)]) }));
  assert.equal(view.container.textContent?.includes("Now reading"), false, "the release interval still holds");
  await wait(STREAMING_REVEAL_RELEASE_MS + 20);
  assert.ok(view.container.textContent?.includes("Now reading the file that defines"));
});

test("tool-closed text keeps its release slot when follow-up prose starts", async () => {
  const first = "Checked the config.\n\nNow reading the file that defines";
  const timeline = (steps: AgentToolStep[], status: GenerationTimeline["status"] = "running"): GenerationTimeline => ({
    version: 3,
    generationId: "generation-1",
    status,
    startedAt: 1,
    steps,
  });
  const closed = timeline([toolStep(first.length)]);
  const view = render(transcript({ messages: [prompt], streamingText: first, timeline: timeline([]) }));
  view.rerender(transcript({ messages: [prompt], streamingText: first, timeline: closed }));
  assert.equal(view.container.textContent?.includes("Now reading"), false, "the release interval holds");

  // The next prose row starts before the closed row's slot comes round.
  const both = `${first}\n\nThe follow-up`;
  view.rerender(transcript({ messages: [prompt], streamingText: both, timeline: closed }));
  assert.equal(view.container.textContent?.includes("Now reading"), false, "newer prose does not flush the closed tail");

  await wait(STREAMING_REVEAL_RELEASE_MS + 20);
  assert.ok(view.container.textContent?.includes("Now reading the file that defines"), "the tail joins at its slot");

  // The end of the turn shows every row in full.
  view.rerender(transcript({ messages: [prompt], streamingText: both, timeline: closed, streamComplete: true }));
  assert.ok(view.container.textContent?.includes("The follow-up"));
});

test("a streaming reply keeps one hidden action row after its last row, so new paragraphs never move it", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const first = "Checked the config.\n\n";
  const timeline: GenerationTimeline = {
    version: 3,
    generationId: "generation-1",
    status: "running",
    startedAt: 1,
    steps: [toolStep(first.length)],
  };
  const view = render(transcript({ messages: [prompt], streamingText: first, timeline }));
  const copy = replyCopyButton();
  assert.ok(copy.closest('[aria-hidden="true"]'), "laid out but hidden while streaming");
  const tool = view.container.querySelector(".activity-feed");
  assert.ok(tool, "the tool step shows");
  assert.ok(
    tool.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the row sits after the tool step, not under the paragraph above it",
  );

  const both = `${first}The follow-up paragraph.\n\n`;
  view.rerender(transcript({ messages: [prompt], streamingText: both, timeline }));
  const followUp = screen.getByText("The follow-up paragraph.");
  assert.equal(replyCopyButton(), copy, "the same row stays put as a new paragraph starts");
  assert.ok(followUp.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(copy.closest("p, .streaming-reveal"), null, "it belongs to the turn, not a paragraph");
});

test("max-wait timeout releases pending heading and prose tails while turn still runs", async () => {
  // A lone heading with no boundary: should stay hidden until timeout
  const contentWithHeading = "Intro paragraph.\n\n## Next section";
  const view = render(transcript({ messages: [prompt], streamingText: contentWithHeading }));
  assert.ok(view.container.textContent?.includes("Intro paragraph."));
  assert.equal(view.container.textContent?.includes("Next section"), false, "unfinished heading waits");

  // Wait past the max-wait timeout
  await wait(STREAMING_REVEAL_MAX_WAIT_MS + 50);
  // The heading should now be visible, and the turn is still running (streamComplete not set)
  assert.ok(view.container.textContent?.includes("Next section"), "heading visible after timeout");
  assert.equal(view.container.textContent?.includes("Intro paragraph."), true, "intro still present");

  // Verify we're still streaming by checking for the data-streaming attribute
  const reveal = view.container.querySelector(".streaming-reveal");
  assert.ok(reveal?.hasAttribute("data-streaming"), "still streaming (turn not complete)");
});

test("max-wait timeout shows unfinished prose sentence while turn still runs", async () => {
  // Plain prose with no sentence-ending punctuation: should wait for timeout
  const contentWithProse = "Here is the intro.\n\nShort unfinished sentence";
  const view = render(transcript({ messages: [prompt], streamingText: contentWithProse }));
  assert.ok(view.container.textContent?.includes("Here is the intro."));
  assert.equal(view.container.textContent?.includes("Short unfinished"), false, "incomplete prose waits");

  // Wait past the timeout
  await wait(STREAMING_REVEAL_MAX_WAIT_MS + 50);
  assert.ok(view.container.textContent?.includes("Short unfinished sentence"), "prose visible after timeout");

  // More of the same sentence arriving never hides what the deadline showed.
  view.rerender(transcript({ messages: [prompt], streamingText: `${contentWithProse} keeps going` }));
  assert.ok(view.container.textContent?.includes("Short unfinished sentence"), "flushed prose stays visible");

  // Turn is still running
  const reveal = view.container.querySelector(".streaming-reveal");
  assert.ok(reveal?.hasAttribute("data-streaming"), "turn still running");
});

test("a streaming reply joins a paragraph at a time and stops fading once settled", async () => {
  const first = "The first paragraph is ready.";
  const second = "The second paragraph follows.";
  const view = render(transcript({ messages: [prompt], streamingText: `${first}\n\n${second.slice(0, 10)}` }));
  assert.ok(view.container.textContent?.includes(first), "the first block shows at once");
  const reveal = view.container.querySelector(".streaming-reveal");
  assert.ok(reveal?.hasAttribute("data-streaming"), "new blocks fade while the reply streams");

  const reply = `${first}\n\n${second}\n\n`;
  view.rerender(transcript({ messages: [prompt], streamingText: reply }));
  assert.equal(view.container.textContent?.includes(second), false, "the next block waits its turn");
  await wait(STREAMING_REVEAL_RELEASE_MS + 20);
  assert.ok(view.container.textContent?.includes(second), "then joins whole");

  const saved: ChatMessage = { id: "assistant-1", role: "assistant", content: reply, createdAt: 2 };
  view.rerender(
    transcript({ messages: [prompt, saved], streamingText: reply, streamComplete: true, persistedHandoffMessageId: saved.id }),
  );
  await wait(STREAMING_REVEAL_FADE_MS + 50);
  view.rerender(transcript({ messages: [prompt, saved], streamingText: null }));
  const settled = view.container.querySelector(".streaming-reveal");
  assert.equal(settled, reveal, "the settled reply keeps its tree");
  assert.equal(settled?.hasAttribute("data-streaming"), false, "and no longer fades anything in");
});

test("with reduced motion every streamed block shows as soon as it arrives", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const view = render(transcript({ messages: [prompt], streamingText: "One.\n\n" }));
  view.rerender(transcript({ messages: [prompt], streamingText: "One.\n\nTwo.\n\n- three\n- four" }));
  for (const text of ["One.", "Two.", "three", "four"]) {
    assert.ok(view.container.textContent?.includes(text), text);
  }
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

test("keyboard focus on a subagent group's header follows the group when it moves under its tool row", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const text = "Splitting the work.\n\n";
  const live = { ...liveRun("focus-run"), generationId: "generation-focus" };
  const timeline = (steps: AgentToolStep[]): GenerationTimeline => ({
    version: 3,
    generationId: "generation-focus",
    status: "running",
    startedAt: 1,
    steps,
  });
  const frame = (steps: AgentToolStep[]): Frame => ({
    messages: [prompt],
    streamingText: text,
    timeline: timeline(steps),
    liveSubagents: [live],
    subagentsEnabled: true,
  });
  const view = render(transcript(frame([])));
  const before = screen.getByRole("button", { name: /^Kicked off 1 subagent\./u });
  await act(async () => {
    before.focus();
  });

  // The subagent tool call's row arrives, and the group moves beneath it.
  await act(async () => {
    view.rerender(
      transcript(frame([{ ...toolStep(text.length), toolName: "subagent", label: "Subagent" }])),
    );
  });
  const after = screen.getByRole("button", { name: /^Kicked off 1 subagent\./u });
  assert.equal(after === before, false, "the group remounted in its new place");
  assert.equal(document.activeElement === after, true, "focus moved with it instead of dropping to the page");
});

test("a reply steered mid-run stays the same reply through guidance, handoff and settlement", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const text = "The reply with reasoning.";
  const reasoning = "Let me think about this.";
  const view = render(transcript({ messages: [prompt], streamingText: `${text}\n\n`, reasoning }));
  const paragraph = screen.getByText(text).closest("p");
  const header = view.container.querySelector<HTMLButtonElement>("section > button[aria-expanded]");
  assert.ok(paragraph && header, "the live reply shows its prose and reasoning");
  act(() => header.click());
  const collapsed = header.getAttribute("aria-expanded");

  const steered = withCommittedRunInput(
    { messages: [prompt] },
    { messageId: "user-steer-1", text: "Use examples", createdAt: 2 },
  ).messages;
  const saved: ChatMessage = { id: "assistant-1", role: "assistant", content: text, reasoning, createdAt: 3 };
  const frames: Frame[] = [
    { messages: steered, streamingText: `${text}\n\n`, reasoning },
    {
      messages: [...steered, saved],
      streamingText: text,
      reasoning,
      streamComplete: true,
      persistedHandoffMessageId: saved.id,
    },
    { messages: [...steered, saved], streamingText: null },
  ];
  for (const frame of frames) {
    view.rerender(transcript(frame));
    assert.ok(screen.getByText(text).closest("p") === paragraph, "the reply is not remounted");
    assert.equal(
      view.container.querySelector("section > button[aria-expanded]")?.getAttribute("aria-expanded"),
      collapsed,
      "the reader's choice on its reasoning holds",
    );
  }
});

test("a reply that settles gives way to the next run's reply", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const first: ChatMessage = { id: "assistant-1", role: "assistant", content: "The first answer.", createdAt: 2 };
  const next: ChatMessage = { id: "user-2", role: "user", content: "And then?", createdAt: 3 };
  const second: ChatMessage = { id: "assistant-2", role: "assistant", content: "The second answer.", createdAt: 4 };
  // Two rows under one key leave React free to drop or swap either reply.
  const errors = mock.method(console, "error", () => undefined);
  const view = render(transcript({ messages: [prompt], streamingText: "The first answer.\n\n" }));
  view.rerender(
    transcript({
      messages: [prompt, first],
      streamingText: first.content,
      streamComplete: true,
      persistedHandoffMessageId: first.id,
    }),
  );
  const settled = screen.getByText(first.content).closest("p");
  // The queued prompt starts its run as the first one settles, with no idle frame between.
  view.rerender(transcript({ messages: [prompt, first, next], streamingText: "The second answer.\n\n" }));
  const streamed = screen.getByText(second.content).closest("p");
  view.rerender(
    transcript({
      messages: [prompt, first, next, second],
      streamingText: second.content,
      streamComplete: true,
      persistedHandoffMessageId: second.id,
    }),
  );
  view.rerender(transcript({ messages: [prompt, first, next, second], streamingText: null }));
  assert.deepEqual(
    [first.content, next.content, second.content].map((text) => screen.getAllByText(text).length),
    [1, 1, 1],
    "each message shows once",
  );
  assert.deepEqual(
    errors.mock.calls.map((call) => String(call.arguments[0])).filter((message) => message.includes("same key")),
    [],
    "every row keeps its own key",
  );
  assert.ok(screen.getByText(first.content).closest("p") === settled, "the first reply stays put");
  assert.ok(screen.getByText(second.content).closest("p") === streamed, "the second settles in place");
  const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(follows(screen.getByText(next.content), streamed!), "below the prompt it answers");
});

test("a saved reply that differs from the live one never shares the live row's key", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const streamed = "The streamed answer, cut short.";
  // The saved copy is not what streamed (a failure note, a trimmed partial), so
  // it cannot take the live row's place: both rows show until the live one ends.
  const saved: ChatMessage = { id: "assistant-1", role: "assistant", content: "The saved answer.", createdAt: 2 };
  const errors = mock.method(console, "error", () => undefined);
  const view = render(transcript({ messages: [prompt], streamingText: `${streamed}\n\n` }));
  view.rerender(
    transcript({
      messages: [prompt, saved],
      streamingText: streamed,
      streamComplete: true,
      persistedHandoffMessageId: null,
    }),
  );
  assert.deepEqual(
    [streamed, saved.content].map((text) => screen.queryAllByText(text).length),
    [1, 1],
    "the live reply and the saved reply each show once",
  );
  view.rerender(transcript({ messages: [prompt, saved], streamingText: null }));
  assert.equal(screen.queryAllByText(streamed).length, 0, "the live reply leaves");
  assert.equal(screen.queryAllByText(saved.content).length, 1, "the saved reply stays");
  assert.deepEqual(
    errors.mock.calls.map((call) => String(call.arguments[0])).filter((message) => message.includes("same key")),
    [],
    "every row keeps its own key",
  );
});

test("a generated image shows exactly once through handoff and settlement", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const image = {
    version: 1 as const,
    kind: "image" as const,
    id: "image-live",
    attachment: {
      id: "attachment-image-1",
      name: "generated.png",
      kind: "image" as const,
      mimeType: "image/png",
      size: 1024,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    },
  };
  const prose = "Here is the generated image.";
  const saved: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: prose,
    createdAt: 2,
    attachments: [image.attachment],
  };
  const shown = () => [...view.container.querySelectorAll(`[data-attachment-preview-id="${image.attachment.id}"]`)];
  const onlyPreview = () => shown().length === 1 && shown()[0] === preview;
  const view = render(transcript({ messages: [prompt], streamingText: `${prose}\n\n`, streamingArtifacts: [image] }));
  const [preview] = shown();
  assert.ok(preview, "the live reply shows its image");
  view.rerender(
    transcript({
      messages: [prompt, saved],
      streamingText: prose,
      streamComplete: true,
      persistedHandoffMessageId: saved.id,
      streamingArtifacts: [image],
    }),
  );
  assert.ok(onlyPreview(), "one image, the same one, while the reply hands over");
  view.rerender(transcript({ messages: [prompt, saved], streamingText: null }));
  assert.ok(onlyPreview(), "and once the saved reply settles");
});

test("links a reparsed reply replaces keep their previews, as the saved reply shows them", () => {
  document.documentElement.dataset.reduceMotion = "true";
  const tight = Array.from(
    { length: 50 },
    (_, i) => `- [Link ${i + 1}](https://github.com/org/repo/pull/${1000 + i})`,
  ).join("\n");
  // An indented paragraph after a blank line turns the tight list loose: every
  // link moves from the list item into a new paragraph.
  const loose = `${tight}\n\n  More details.\n`;
  const saved: ChatMessage = { id: "assistant-1", role: "assistant", content: loose, createdAt: 2 };
  const history = render(transcript({ messages: [prompt, saved], streamingText: null }));
  const fromHistory = previews(history.container);
  assert.equal(fromHistory, 50, "the saved reply previews all its links");
  history.unmount();

  const view = render(transcript({ messages: [prompt], streamingText: `${tight}\n` }));
  assert.equal(previews(view.container), 50, "the tight list previews its links while streaming");
  view.rerender(transcript({ messages: [prompt], streamingText: loose }));
  assert.ok(view.container.querySelector("li > p"), "the list is loose now");
  assert.equal(previews(view.container), 50, "the replaced links keep their previews");
  view.rerender(
    transcript({
      messages: [prompt, saved],
      streamingText: loose,
      streamComplete: true,
      persistedHandoffMessageId: saved.id,
    }),
  );
  assert.equal(previews(view.container), 50);
  view.rerender(transcript({ messages: [prompt, saved], streamingText: null }));
  assert.equal(previews(view.container), fromHistory, "the settled reply shows what history shows");
});
