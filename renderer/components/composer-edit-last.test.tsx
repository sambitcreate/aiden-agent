// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import type { Chat, ChatMessage, Workspace } from "../lib/types";

// ↑ in an empty message box brings the last message back to fix and send
// again. The real Composer forks the chat just before that message, the same
// as the Edit in fork action, and only when nothing else would be lost.

let queryClient: QueryClient;

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

function message(id: string, role: "user" | "assistant", content: string, createdAt: number): ChatMessage {
  return { id, role, content, createdAt } as ChatMessage;
}

const ANSWERED = [
  message("u1", "user", "Plan the release", 1),
  message("a1", "assistant", "Here is a plan.", 2),
  message("u2", "user", "Make it shorter", 3),
  message("a2", "assistant", "Shorter plan.", 4),
];

function chat(messages: ChatMessage[], extra: Partial<Chat> = {}): Chat {
  return { id: "chat-1", title: "Release", messages, createdAt: 1, updatedAt: 4, ...extra } as unknown as Chat;
}

beforeEach(() => {
  localStorage.clear();
  installBotTestIpc({
    "settings:get": () => null,
    "shortcut:get": () => null,
    "app:renderer-ready": () => null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

function mount(sessionChat: Chat, { generating = false } = {}) {
  const forks: Array<[string, string]> = [];
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <Composer
            ready
            hasMessages
            chatId={sessionChat.id}
            sessionChat={sessionChat}
            workspace={WORKSPACE}
            onRenameChat={() => undefined}
            onSend={async () => undefined}
            onStop={() => undefined}
            onForkChat={async (messageId, position) => {
              forks.push([messageId, position]);
            }}
            isGenerating={generating}
          />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return forks;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

test("↑ in an empty message box forks just before the last message, to edit and resend it", async () => {
  const forks = mount(chat(ANSWERED));
  await settle();
  box().focus();
  await act(async () => {
    fireEvent.keyDown(box(), { key: "ArrowUp" });
  });
  assert.deepEqual(forks, [["u2", "before"]]);
});

test("↑ is left to the text box when it holds text, or with a modifier held", async () => {
  const forks = mount(chat(ANSWERED));
  await settle();
  fireEvent.change(box(), { target: { value: "first line" } });
  await settle();
  const event = fireEvent.keyDown(box(), { key: "ArrowUp" });
  assert.equal(event, true, "the caret moves instead");
  fireEvent.change(box(), { target: { value: "" } });
  await settle();
  fireEvent.keyDown(box(), { key: "ArrowUp", shiftKey: true });
  fireEvent.keyDown(box(), { key: "ArrowUp", altKey: true });
  assert.deepEqual(forks, []);
});

test("↑ does nothing while a reply is still coming, or before the last message has one", async () => {
  const streaming = mount(chat(ANSWERED), { generating: true });
  await settle();
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  assert.deepEqual(streaming, []);
  cleanup();

  const unanswered = mount(chat([...ANSWERED, message("u3", "user", "And a title?", 5)]));
  await settle();
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  assert.deepEqual(unanswered, [], "the last message has no finished reply to fork from");
});

test("a Bot chat, which can't edit in a fork, leaves ↑ alone", async () => {
  const forks = mount(chat(ANSWERED, { botId: "bot-1" } as Partial<Chat>));
  await settle();
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  assert.deepEqual(forks, []);
});
