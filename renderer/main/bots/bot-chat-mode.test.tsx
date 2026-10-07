import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider } from "../../lib/command-system";
import { Composer } from "../../components/composer";
import { MessageList } from "../../components/message-list";
import { LOCAL_COMPOSER_SURFACES, type ComposerSurfaces } from "../../lib/hosts/composer-surfaces";
import type { ChatMessage, Workspace } from "../../lib/types";
import type { GenerationTimeline } from "../../shared/generation-timeline";
import { BOT_CHAT_COMPOSER_SURFACES } from "./bot-chat-mode";
import { resolveBotReplyProjection } from "./bot-reply-projection";
import { createBotTestQueryClient } from "./test-providers";

afterEach(cleanup);

const workspace = {
  id: "home",
  name: "Home",
  folderPath: "/tmp/bot-home",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
} as unknown as Workspace;

function renderComposer(surfaces: ComposerSurfaces) {
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <CommandSystemProvider>
        <Composer
          ready
          hasMessages
          chatId="bot-chat"
          onSend={async () => undefined}
          onStop={() => undefined}
          isGenerating={false}
          surfaces={surfaces}
          workspace={workspace}
          gitBranch="main"
          onChangePermission={() => undefined}
          onRenameChat={() => undefined}
          onExportChat={async () => "saved"}
        />
      </CommandSystemProvider>
    </QueryClientProvider>,
  );
}

async function typeSlash() {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return screen.queryAllByRole("option").map((option) => option.textContent ?? "");
}

test("a Bot chat composer keeps attach, voice, and send but hides workspace access", () => {
  renderComposer(LOCAL_COMPOSER_SURFACES);
  // The same composer outside Bot mode does offer the access control.
  assert.ok(screen.getByRole("button", { name: /Workspace access/u }));
  cleanup();

  renderComposer(BOT_CHAT_COMPOSER_SURFACES);
  assert.equal(screen.queryByRole("button", { name: /Workspace access/u }), null);
  assert.ok(screen.getByRole("button", { name: "Attach files or images" }));
  assert.ok(screen.getByRole("button", { name: "Start voice input" }));
  assert.ok(screen.getByRole("button", { name: "Send message" }));
});

test("a Bot chat has no slash palette for rename, fork, side questions, or export", async () => {
  renderComposer(LOCAL_COMPOSER_SURFACES);
  const local = await typeSlash();
  for (const command of ["Rename chat", "Fork from a turn", "Ask a side question", "Export chat"]) {
    assert.ok(local.some((option) => option.startsWith(command)), command);
  }
  cleanup();

  renderComposer(BOT_CHAT_COMPOSER_SURFACES);
  assert.deepEqual(await typeSlash(), []);
});

function toolTimeline(contentOffset: number): GenerationTimeline {
  return {
    version: 3,
    generationId: "gen-1",
    status: "completed",
    startedAt: 1,
    finishedAt: 3,
    steps: [
      {
        id: "step-1",
        order: 0,
        kind: "tool",
        toolCallId: "call-1",
        toolName: "web_search",
        label: "Searched the web",
        detail: "weeknight dinners",
        status: "completed",
        startedAt: 1,
        updatedAt: 2,
        finishedAt: 2,
        contentOffset,
      },
    ],
  };
}

test("Bot replies fold tool activity and narration into a collapsed Updates line", () => {
  const progress = "Let me look up a few recipes.";
  const answer = "Here is your meal plan for the week.";
  const content = `${progress}\n\n${answer}`;
  const message: ChatMessage = {
    id: "m1",
    role: "assistant",
    content,
    createdAt: 2,
    timeline: toolTimeline(progress.length),
  };
  render(
    <MessageList
      chatId="bot-chat"
      messages={[message]}
      streamingText={null}
      streamingReasoning={null}
      timeline={null}
      liveSubagents={[]}
      subagentsEnabled={false}
      onOpenSubagent={() => undefined}
      agentActivity={null}
      error={null}
      botPresentation
    />,
  );
  const updates = screen.getByRole("button", { name: "Updates" });
  assert.equal(updates.getAttribute("aria-expanded"), "false");
  assert.ok(screen.getByText(answer));
  assert.equal(screen.queryByText(progress), null);
  assert.equal(screen.queryByText(/weeknight dinners/u), null);

  fireEvent.click(updates);
  const region = screen.getByRole("region", { name: "Updates" });
  assert.ok(within(region).getByText(progress));
  assert.ok(within(region).getByText(/weeknight dinners/u));
});

test("the reply projection matches the phone rule for split, running, and tool-free replies", () => {
  const text = "Checking.\n\nChecking.\n\nDone: three dinners.";
  const boundary = text.indexOf("Done");
  assert.deepEqual(resolveBotReplyProjection(text, toolTimeline(boundary), false), {
    finalText: "Done: three dinners.",
    progressText: "Checking.",
  });
  assert.deepEqual(resolveBotReplyProjection(text, toolTimeline(boundary), true), {
    finalText: "",
    progressText: "Checking.\n\nDone: three dinners.",
  });
  assert.deepEqual(resolveBotReplyProjection("  Hi there  ", null, false), {
    finalText: "Hi there",
    progressText: "",
  });
  const emoji = "😀 done";
  assert.deepEqual(resolveBotReplyProjection(emoji, toolTimeline(1), false), {
    finalText: emoji,
    progressText: "",
  });
});
