// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
let repositoryKey: string;
let branchesUncommitted: number;

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
  repositoryKey = "github.com/acme/app";
  branchesUncommitted = 0;
  calls = installBotTestIpc({
    "pullRequests:list": () => ({ links: linkedPullRequests }),
    "pullRequests:current": () => null,
    "pullRequests:pending": () => [],
    "workspaces:repositoryIdentity": () => ({ canonicalKey: repositoryKey, relativePath: "" }),
    "git:branches": () => ({
      isRepo: true,
      current: "main",
      branches: ["main"],
      remoteBranches: [],
      uncommitted: branchesUncommitted,
    }),
    "git:worktrees": () => [],
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

function status(): string {
  const live = [...document.querySelectorAll('[role="group"][aria-label="Composer workspace bar"] [role="status"]')];
  return live.map((node) => node.textContent ?? "").join("");
}

const OPEN_PULL_REQUEST = {
  host: "github.com",
  repository: "acme/app",
  number: 7,
  state: "open",
  title: "Fix the login",
  url: "https://github.com/acme/app/pull/7",
  headBranch: "fix/login",
  baseBranch: "main",
  checks: [],
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  linkedPullRequests = [OPEN_PULL_REQUEST];
  await mount({ chat: STARTED, gitStatus: CLEAN_REPO });
  assert.ok(bar().getAttribute("data-mode") === "summary");
  assert.ok(bar().getAttribute("inert") === null);
  assert.ok(workspaceButton() === null, "the window header already names the workspace");
  assert.ok(screen.queryByRole("button", { name: "main" }) !== null);
  assert.ok(pullRequestChip() !== null);
  assert.ok(status() === "", "opening a chat whose PR chip qualifies announces nothing");
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

test("the changes count follows Git status after the branch menu has been opened and closed", async () => {
  branchesUncommitted = 3;
  const view = await mount({ chat: DRAFT, gitStatus: { ...CLEAN_REPO, uncommitted: 3 } });
  const trigger = screen.getByRole("button", { name: "main, 3 uncommitted changes" });
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  await settle();
  assert.ok(calls.some((call) => call.channel === "git:branches"), "the open menu read branches");
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
  await settle();
  // The working tree is committed; the closed menu's branches read is now stale.
  await act(async () => {
    view.rerender(<Harness chat={DRAFT} gitStatus={{ ...CLEAN_REPO, uncommitted: 0 }} />);
  });
  assert.ok(screen.queryByRole("button", { name: "main" }) !== null, "the trigger drops the count");
  assert.ok(document.querySelector("[data-changes-badge]") === null);
});

test("a never-pushed feature branch on a self-hosted remote offers the PR chip", async () => {
  repositoryKey = "git.example.com/acme/app";
  await mount({ chat: STARTED, gitStatus: { ...CLEAN_REPO, branch: "fix/login" } });
  assert.ok(pullRequestChip() !== null, "linking an existing PR stays reachable");
});

test("a known non-GitHub forge never shows the PR chip", async () => {
  repositoryKey = "gitlab.com/acme/app";
  await mount({ chat: STARTED, gitStatus: { ...CLEAN_REPO, branch: "fix/login" } });
  assert.ok(pullRequestChip() === null);
});

test("the default branch with nothing linked shows no PR chip", async () => {
  await mount({ chat: STARTED, gitStatus: { ...CLEAN_REPO, upstream: "origin/main", ahead: 2 } });
  assert.ok(pullRequestChip() === null);
});

test("a PR chip that appears mid-chat is announced with its label", async () => {
  await mount({ chat: STARTED, gitStatus: CLEAN_REPO });
  assert.ok(pullRequestChip() === null);
  assert.ok(status() === "");
  linkedPullRequests = [OPEN_PULL_REQUEST];
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["chat-pull-requests"] });
  });
  await settle();
  assert.ok(pullRequestChip() !== null);
  assert.ok(status() === "1 open · 1 linked available", `announced ${JSON.stringify(status())}`);
  assert.ok(document.activeElement !== pullRequestChip(), "the chip takes no focus");
});

test("focus the user moved off the strip stays put when chips change", async () => {
  const view = await mount({ chat: DRAFT, gitStatus: CLEAN_REPO });
  const button = workspaceButton();
  assert.ok(button !== null);
  await act(async () => {
    button.focus();
  });
  // Clicking non-focusable transcript text drops focus to <body> without a focusin.
  await act(async () => {
    button.blur();
  });
  assert.ok(document.activeElement === document.body);
  await act(async () => {
    view.rerender(<Harness chat={STARTED} gitStatus={CLEAN_REPO} />);
  });
  assert.ok(workspaceButton() === null);
  assert.ok(document.activeElement === document.body, "focus is not pulled into the composer");
});
