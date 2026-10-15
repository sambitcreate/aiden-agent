// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import type { Chat, GitInfo, Workspace } from "../lib/types";

// The real Composer and its context bar, with IPC faked. Boolean oracles
// throughout: a failing assert on a happy-dom node would inspect the whole DOM.

let queryClient: QueryClient;
let calls: BotTestIpcCall[];
let linkedPullRequests: unknown[];

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

const CLEAN_REPO: GitInfo = { isRepo: true, branch: "main", uncommitted: 0, hasRemote: true };

const DRAFT = { id: "chat-1", title: "New chat", messages: [], createdAt: 1, updatedAt: 1 } as unknown as Chat;
const STARTED = {
  ...DRAFT,
  messages: [{ id: "m1", role: "user", content: "Fix the login", createdAt: 2 }],
} as unknown as Chat;

beforeEach(() => {
  localStorage.clear();
  linkedPullRequests = [];
  calls = installBotTestIpc({
    "pullRequests:list": () => ({ links: linkedPullRequests }),
    "pullRequests:current": () => null,
    "pullRequests:pending": () => [],
    "workspaces:repositoryIdentity": () => ({ canonicalKey: "github.com/acme/app", relativePath: "" }),
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

interface HarnessProps {
  chat: Chat;
  gitStatus?: GitInfo;
  machinePicker?: React.ReactNode;
}

// The pane owns the composer's input ref, as `chat-pane.tsx` does.
const inputRef = { current: null as HTMLTextAreaElement | null };

function Harness({ chat, gitStatus, machinePicker }: HarnessProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <Composer
            ready
            hasMessages={chat.messages.length > 0}
            chatId={chat.id}
            sessionChat={chat}
            workspace={WORKSPACE}
            gitBranch={gitStatus?.isRepo ? gitStatus.branch : undefined}
            gitStatus={gitStatus}
            machinePicker={machinePicker}
            inputRef={inputRef}
            onRenameChat={() => undefined}
            onSend={async () => undefined}
            onStop={() => undefined}
            isGenerating={false}
          />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

async function mount(props: HarnessProps) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Harness {...props} />);
  });
  // Let the PR and identity reads settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

function bar(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="group"][aria-label="Composer workspace bar"]');
  assert.ok(element !== null, "the context bar is mounted");
  return element;
}

function pullRequestChip() {
  return screen.queryByRole("button", { name: /^Pull requests for this chat/u });
}

function workspaceButton() {
  return screen.queryByRole("button", { name: "Open folder in file manager" });
}

test("a plain folder draft shows the workspace only: no Local label and no PR chip", async () => {
  await mount({ chat: DRAFT });
  assert.ok(bar().getAttribute("data-mode") === "full");
  assert.ok(workspaceButton() !== null);
  assert.ok(screen.queryByText("Local") === null);
  assert.ok(pullRequestChip() === null);
  assert.ok(!calls.some((call) => call.channel.startsWith("pullRequests:")), "a draft reads no PR state");
});

test("a git draft shows the branch with its uncommitted change count", async () => {
  await mount({ chat: DRAFT, gitStatus: { ...CLEAN_REPO, uncommitted: 3 } });
  assert.ok(screen.queryByRole("button", { name: /^main, 3 uncommitted changes$/u }) !== null);
  assert.ok(pullRequestChip() === null);
});

test("a clean git draft shows the branch without a change count", async () => {
  await mount({ chat: DRAFT, gitStatus: CLEAN_REPO });
  assert.ok(screen.queryByRole("button", { name: "main" }) !== null);
});

test("a paired Mac's machine picker replaces nothing and shows on the draft", async () => {
  await mount({ chat: DRAFT, machinePicker: <button type="button">Run on Studio</button> });
  assert.ok(screen.queryByRole("button", { name: "Run on Studio" }) !== null);
});

test("after the first message a GitHub repo with a linked PR collapses to branch and PR", async () => {
  linkedPullRequests = [
    {
      host: "github.com",
      repository: "acme/app",
      number: 7,
      state: "open",
      title: "Fix the login",
      url: "https://github.com/acme/app/pull/7",
      headBranch: "fix/login",
      baseBranch: "main",
      checks: [],
    },
  ];
  await mount({ chat: STARTED, gitStatus: CLEAN_REPO });
  assert.ok(bar().getAttribute("data-mode") === "summary");
  assert.ok(bar().getAttribute("inert") === null);
  assert.ok(workspaceButton() === null, "the window header already names the workspace");
  assert.ok(screen.queryByRole("button", { name: "main" }) !== null);
  assert.ok(pullRequestChip() !== null);
  assert.ok(screen.queryByText("Pull request available") !== null);
});

test("after the first message a repository with nothing to open shows the branch only", async () => {
  await mount({ chat: STARTED, gitStatus: CLEAN_REPO });
  assert.ok(bar().getAttribute("data-mode") === "summary");
  assert.ok(pullRequestChip() === null);
});

test("after the first message a repository without a GitHub remote never shows the PR chip", async () => {
  await mount({ chat: STARTED, gitStatus: { ...CLEAN_REPO, hasRemote: false } });
  assert.ok(pullRequestChip() === null);
  assert.ok(!calls.some((call) => call.channel.startsWith("pullRequests:")));
});

test("after the first message a plain folder hides the bar", async () => {
  await mount({ chat: STARTED });
  assert.ok(bar().getAttribute("data-mode") === "hidden");
  assert.ok(bar().getAttribute("aria-hidden") === "true");
  assert.ok(bar().hasAttribute("inert"));
});

test("focus on a chip that leaves with the first message returns to the composer input", async () => {
  const view = await mount({ chat: DRAFT, gitStatus: CLEAN_REPO });
  const button = workspaceButton();
  assert.ok(button !== null);
  await act(async () => {
    button.focus();
  });
  assert.ok(document.activeElement === button);
  await act(async () => {
    view.rerender(<Harness chat={STARTED} gitStatus={CLEAN_REPO} />);
  });
  assert.ok(workspaceButton() === null);
  assert.ok(document.activeElement === screen.getByRole("textbox"), "focus moves to the input");
});
