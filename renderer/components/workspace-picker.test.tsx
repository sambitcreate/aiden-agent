// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspacePicker, type WorkspaceMenuRequest } from "./workspace-picker";
import { NewChatHeadline } from "./new-chat-headline";
import { Button, TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import type { Workspace } from "../lib/types";
import { workspaceCloneId, type WorkspacePathInspection } from "../shared/workspace-intake";
import { queryKeys } from "../lib/queries";

// The real picker with IPC faked at the preload bridge. Boolean and string
// oracles throughout: a failing assert on a happy-dom node would print the DOM.

let queryClient: QueryClient;
let calls: BotTestIpcCall[];
let handlers: Record<string, (...args: unknown[]) => unknown>;
let selected: string[];
let scratchCreated: number;
let noWorkspaceChosen: number;
/** When set, moving the draft waits for this before it finishes. */
let selectGate: Promise<void> | null;

function workspace(id: string, name: string, createdAt: number, extra: Partial<Workspace> = {}): Workspace {
  return { id, name, folderPath: `/Users/me/projects/${name}`, permission: "ask", createdAt, updatedAt: createdAt, ...extra };
}

const WORKTREE = workspace("api-wt", "api-fix", 900, {
  managedWorktree: {
    repositoryPath: "/Users/me/projects/api",
    worktreePath: "/Users/me/.aiden/worktrees/api-fix",
    branch: "aiden/fix",
    createdFromHead: "abc",
  },
});
const MANY = ["web", "api", "docs", "infra", "mobile", "design", "notes"].map((name, index) =>
  workspace(name, name, 1_000 - index),
);

beforeEach(() => {
  localStorage.clear();
  selected = [];
  scratchCreated = 0;
  noWorkspaceChosen = 0;
  selectGate = null;
  handlers = {
    "chats:list": () => [],
    "settings:get": () => null,
    "shortcut:get": () => null,
    "app:renderer-ready": () => null,
    "workspaces:list": () => MANY,
    "workspaces:cloneCancel": () => true,
  };
  // Tests add channels to `handlers` after install; the fake reads it per call.
  calls = installBotTestIpc(handlers);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

const composerRef = { current: null as HTMLTextAreaElement | null };

function Harness({
  workspaces,
  activeWorkspaceId,
  request,
  blockedReason,
  busyReason,
}: {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  request?: WorkspaceMenuRequest;
  blockedReason?: string;
  busyReason?: string;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <WorkspacePicker
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={async (id) => {
              if (selectGate) await selectGate;
              selected.push(id);
            }}
            onCreateScratchWorkspace={async () => {
              scratchCreated += 1;
            }}
            onChooseNoWorkspace={async () => {
              noWorkspaceChosen += 1;
            }}
            onOpenFolder={async () => undefined}
            openRequest={request}
            blockedReason={blockedReason}
            busyReason={busyReason}
            returnFocusRef={composerRef}
            trigger={<Button aria-label="Choose a workspace">Workspace</Button>}
          />
          <textarea aria-label="Composer" ref={composerRef} />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

async function wait(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function openMenu(workspaces: Workspace[] = MANY, activeWorkspaceId = "api", menuView: "list" | "clone" = "list") {
  // Mounted first, then asked to open, as the headline name and the palette do.
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Harness workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />);
  });
  await act(async () => {
    view.rerender(
      <Harness workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} request={{ nonce: 1, view: menuView }} />,
    );
  });
  await wait();
}

function optionNames(): string[] {
  return screen.queryAllByRole("option").map((option) => (option.textContent ?? "").replace(/\s+/gu, " ").trim());
}

function search(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Search workspaces" }) as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

/** Wait past the path-inspection debounce. */
async function afterInspectDelay() {
  await wait(200);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the trigger opens a menu with the five most recent workspaces and the actions, without worktrees", async () => {
  await act(async () => {
    render(<Harness workspaces={[...MANY, WORKTREE]} activeWorkspaceId="api" />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Choose a workspace" }));
  });
  await wait();
  const names = optionNames();
  assert.deepEqual(
    names.slice(0, 5).map((name) => /^[a-z]+/u.exec(name)?.[0]),
    ["web", "api", "docs", "infra", "mobile"],
  );
  assert.ok(/days? ago$/u.test(names[0] ?? ""), "other workspaces show when they were last active");
  assert.equal(names.some((name) => name.startsWith("api-fix")), false, "managed worktrees are left out");
  assert.equal(names[5], "All workspaces (7)");
  assert.ok(names[6]?.startsWith("Open folder…"));
  assert.equal(names[7], "Clone repository…");
  assert.ok(names[8]?.startsWith("Scratch chat"));
  assert.ok(names[9]?.startsWith("No workspace"));
  assert.equal(names.some((name) => /Don.t work in a workspace/u.test(name)), false);
  assert.equal(screen.queryAllByLabelText("Current workspace").length, 1);
  assert.equal(document.activeElement === search(), true, "the search field is focused on open");

  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name: "All workspaces (7)" }));
  });
  assert.equal(optionNames().filter((name) => !/^(Open folder|Clone|Scratch|No workspace)/u.test(name)).length, 7);
});

test("typing searches all workspaces, past the recent five", async () => {
  await openMenu();
  await type(search(), "notes");
  assert.ok(optionNames()[0]?.startsWith("notes"));
  assert.ok(optionNames().some((name) => name.startsWith("Scratch chat")), "actions stay available");
});

test("Scratch chat keeps today's scratch-folder behaviour", async () => {
  await openMenu();
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name: /^Scratch chat/u }));
  });
  await wait();
  assert.equal(scratchCreated, 1);
  assert.equal(screen.queryByRole("dialog") === null, true, "the menu closes");
});

const HIDDEN = workspace("hidden", "No workspace", 2_000, {
  folderPath: "/Users/me/Library/Application Support/Aiden Agent/chat-folders/kind-fern-hike",
  noWorkspace: true,
});

test("No workspace is one choice: hidden chat folders are never listed, and choosing it moves the draft", async () => {
  await openMenu([...MANY, HIDDEN], "api");
  const names = optionNames();
  assert.equal(names.filter((name) => name.startsWith("No workspace")).length, 1);
  assert.equal(names.some((name) => name.includes("kind-fern-hike")), false);
  await type(search(), "fern");
  assert.equal(optionNames().some((name) => name.includes("kind-fern-hike")), false, "search skips them too");
  await type(search(), "");
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name: /^No workspace/u }));
  });
  await wait();
  assert.equal(noWorkspaceChosen, 1);
  assert.equal(screen.queryByRole("dialog") === null, true, "the menu closes");
});

test("a draft that already has no workspace shows that row as current, and choosing it changes nothing", async () => {
  await openMenu([...MANY, HIDDEN], "hidden");
  const row = screen.getByRole("option", { name: /^No workspace/u });
  assert.equal(row.querySelector("[aria-label='Current workspace']") !== null, true);
  await act(async () => {
    fireEvent.click(row);
  });
  await wait();
  assert.equal(noWorkspaceChosen, 0);
  assert.deepEqual(selected, []);
  assert.equal(screen.queryByRole("dialog") === null, true);
});

test("a typed path offers Open for a folder and moves the draft to the registered workspace", async () => {
  handlers["workspaces:inspectPath"] = (): WorkspacePathInspection => ({
    kind: "folder",
    path: "/Users/me/repo",
    isGitRepo: true,
  });
  handlers["workspaces:openPath"] = () => ({
    ok: true,
    workspace: workspace("repo", "repo", 5),
    created: false,
    existing: false,
  });
  await openMenu();
  await type(search(), "~/repo");
  await afterInspectDelay();
  const option = screen.getByRole("option", { name: /Open \/Users\/me\/repo/u });
  assert.ok((option.textContent ?? "").includes("Git repository"));
  assert.equal(option.getAttribute("aria-selected"), "true", "the path row becomes the default choice");
  const inspect = calls.find((call) => call.channel === "workspaces:inspectPath");
  assert.deepEqual(inspect?.args, ["~/repo", "api"], "relative paths resolve against the current workspace");

  await act(async () => {
    fireEvent.click(option);
  });
  await wait();
  const open = calls.find((call) => call.channel === "workspaces:openPath");
  assert.deepEqual(open?.args, ["~/repo", { create: false, relativeToWorkspaceId: "api" }]);
  assert.deepEqual(selected, ["repo"]);
});

test("a missing folder offers Create folder and open, which asks main to create it", async () => {
  handlers["workspaces:inspectPath"] = (): WorkspacePathInspection => ({ kind: "creatable", path: "/Users/me/new" });
  handlers["workspaces:openPath"] = () => ({
    ok: true,
    workspace: workspace("new", "new", 5),
    created: true,
    existing: false,
  });
  await openMenu();
  await type(search(), "~/new");
  await afterInspectDelay();
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name: /^Create folder and open \/Users\/me\/new/u }));
  });
  await wait();
  const open = calls.find((call) => call.channel === "workspaces:openPath");
  assert.equal((open?.args[1] as { create: boolean }).create, true);
  assert.deepEqual(selected, ["new"]);
});

test("a path that is already a workspace selects it without registering anything", async () => {
  handlers["workspaces:inspectPath"] = (): WorkspacePathInspection => ({
    kind: "existing-workspace",
    workspaceId: "docs",
    path: "/Users/me/projects/docs",
  });
  await openMenu();
  await type(search(), "~/projects/docs");
  await afterInspectDelay();
  const option = screen.getByRole("option", { name: /^docs/u });
  assert.ok((option.textContent ?? "").includes("Already a workspace"));
  await act(async () => {
    fireEvent.click(option);
  });
  await wait();
  assert.deepEqual(selected, ["docs"]);
  assert.equal(calls.some((call) => call.channel === "workspaces:openPath"), false);
});

test("an invalid path shows main's reason as a message, not a choice", async () => {
  handlers["workspaces:inspectPath"] = (): WorkspacePathInspection => ({
    kind: "invalid",
    code: "parent-missing",
    reason: "The parent folder doesn't exist.",
  });
  await openMenu();
  await type(search(), "~/nowhere/deep");
  await afterInspectDelay();
  assert.ok(screen.queryByText("The parent folder doesn't exist.") !== null);
  assert.equal(
    optionNames().some((name) => name.includes("nowhere") || name.includes("parent folder")),
    false,
  );
});

test("a slow answer for an older path never replaces the newer one", async () => {
  const older = deferred<WorkspacePathInspection>();
  handlers["workspaces:inspectPath"] = (input) =>
    input === "~/a" ? older.promise : { kind: "folder", path: "/Users/me/ab", isGitRepo: false };
  await openMenu();
  await type(search(), "~/a");
  await afterInspectDelay();
  await type(search(), "~/ab");
  await afterInspectDelay();
  assert.ok(screen.queryByRole("option", { name: /^Open \/Users\/me\/ab/u }) !== null);
  await act(async () => {
    older.resolve({ kind: "creatable", path: "/Users/me/a" });
    await older.promise;
  });
  await wait();
  assert.ok(screen.queryByRole("option", { name: /^Open \/Users\/me\/ab/u }) !== null);
  assert.equal(screen.queryByRole("option", { name: /Create folder/u }) === null, true);
});

async function startCloneView() {
  handlers["workspaces:clonePreview"] = (url) => ({
    ok: true,
    url: `https://github.com/${String(url)}.git`,
    repoName: "site",
    destination: "/Users/me/projects/site",
  });
  await openMenu(MANY, "api", "clone");
  const url = screen.getByLabelText("Git URL or owner/repo") as HTMLInputElement;
  assert.equal(document.activeElement === url, true, "the URL field is focused");
  await type(url, "acme/site");
  await wait(300);
  const destination = screen.getByLabelText("Destination") as HTMLInputElement;
  assert.equal(destination.value, "/Users/me/projects/site");
  return url;
}

test("Clone shows progress for its own clone only, then a failure inline with the URL kept", async () => {
  const result = deferred<unknown>();
  handlers["workspaces:clone"] = () => result.promise;
  const url = await startCloneView();
  assert.ok(screen.queryByText("Uses your git credentials. Runs only when you press Clone.") !== null);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  });
  const request = calls.find((call) => call.channel === "workspaces:clone")?.args[0] as {
    cloneId: string;
    url: string;
    destination?: string;
  };
  assert.equal(request.url, "acme/site");
  assert.equal(request.destination, undefined, "an untouched destination is main's default");
  assert.equal(workspaceCloneId(request.cloneId), request.cloneId, "main accepts the clone id");

  await act(async () => {
    emitBotTestNotification("workspaces:clone-progress", { cloneId: "someone-elses", phase: "Resolving deltas", percent: 90 });
    emitBotTestNotification("workspaces:clone-progress", { cloneId: request.cloneId, phase: "Receiving objects", percent: 40 });
  });
  assert.ok(screen.queryByText("Receiving objects · 40%") !== null);
  // Only the phase is announced; the percentage stays on the progress bar.
  assert.equal(screen.getByRole("status").textContent, "Receiving objects");
  assert.equal(screen.queryByText(/Resolving deltas/u) === null, true);
  assert.equal(screen.getByRole("progressbar", { name: "Clone progress" }).getAttribute("aria-valuenow"), "40");

  await act(async () => {
    result.resolve({ ok: false, code: "not-found", reason: "That repository wasn't found, or you don't have access to it." });
    await result.promise;
  });
  await wait();
  assert.equal(screen.getByRole("alert").textContent, "That repository wasn't found, or you don't have access to it.");
  assert.equal(url.value, "acme/site");
  assert.equal(screen.queryByRole("progressbar") === null, true);
  assert.deepEqual(selected, []);
});

test("an edited destination is sent, and a finished clone moves the draft there", async () => {
  handlers["workspaces:clone"] = () => ({
    ok: true,
    workspace: workspace("site", "site", 5),
    destination: "/Users/me/code/site",
  });
  await startCloneView();
  await type(screen.getByLabelText("Destination") as HTMLInputElement, "~/code/site");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  });
  await wait();
  const request = calls.find((call) => call.channel === "workspaces:clone")?.args[0] as { destination?: string };
  assert.equal(request.destination, "~/code/site");
  assert.deepEqual(selected, ["site"]);
  assert.equal(screen.queryByRole("dialog") === null, true, "the menu closes on success");
});

test("Esc during a clone cancels it, then steps back to the list", async () => {
  handlers["workspaces:clone"] = () => new Promise(() => undefined);
  await startCloneView();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  });
  const cloneId = (calls.find((call) => call.channel === "workspaces:clone")?.args[0] as { cloneId: string }).cloneId;
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
  await wait();
  const cancel = calls.find((call) => call.channel === "workspaces:cloneCancel");
  assert.deepEqual(cancel?.args, [cloneId]);
  assert.ok(screen.queryByRole("button", { name: "Clone" }) !== null, "still in the clone view, ready to retry");

  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
  await wait();
  assert.ok(screen.queryByRole("combobox", { name: "Search workspaces" }) !== null, "back to the list");
});

test("Esc closes the list and returns focus to the composer", async () => {
  await openMenu();
  assert.equal(document.activeElement === search(), true);
  await act(async () => {
    fireEvent.keyDown(search(), { key: "Escape" });
  });
  await wait();
  assert.equal(screen.queryByRole("combobox", { name: "Search workspaces" }) === null, true);
  assert.equal(document.activeElement === screen.getByRole("textbox", { name: "Composer" }), true);
});

test("the headline names the workspace as a menu button, and a scratch chat asks what's on your mind", async () => {
  let opened = 0;
  const project = workspace("api", "api", 1);
  const { rerender } = render(
    <NewChatHeadline workspace={project} workspaces={[project]} onChooseWorkspace={() => (opened += 1)} />,
  );
  const name = screen.getByRole("button", { name: "api" });
  assert.equal(name.closest("[data-new-chat-headline]")?.textContent, "What should we build in api?");
  fireEvent.click(name);
  assert.equal(opened, 1);

  // Without a way to change the workspace the name is plain text.
  rerender(<NewChatHeadline workspace={project} workspaces={[project]} />);
  assert.equal(screen.queryByRole("button", { name: "api" }) === null, true);

  // Only a workspace made by Scratch chat is a scratch chat, whatever its folder.
  const lookalike = { ...workspace("l", "calm-moon-run", 1), folderPath: "/Users/me/aiden/calm-moon-run" };
  rerender(<NewChatHeadline workspace={lookalike} workspaces={[lookalike]} onChooseWorkspace={() => undefined} />);
  assert.ok(screen.queryByRole("button", { name: "calm-moon-run" }) !== null);
  const scratch = { ...workspace("s", "Landing page", 1), folderPath: "/srv/home/me/aiden/x", scratch: true as const };
  rerender(<NewChatHeadline workspace={scratch} workspaces={[scratch]} onChooseWorkspace={() => undefined} />);
  assert.ok(screen.queryByText("What’s on your mind?") !== null);
  assert.equal(screen.queryByRole("button") === null, true);

  // A No workspace chat has no project to name either.
  rerender(<NewChatHeadline workspace={HIDDEN} workspaces={[HIDDEN]} onChooseWorkspace={() => undefined} />);
  assert.ok(screen.queryByText("What’s on your mind?") !== null);
});

test("a blocked picker stays closed, even when asked to open, and describes why on its trigger", async () => {
  const reason = "Wait for the current Git operation to finish before switching workspaces.";
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Harness workspaces={MANY} activeWorkspaceId="api" blockedReason={reason} />);
  });
  const trigger = screen.getByRole("button", { name: "Choose a workspace" });
  await act(async () => {
    fireEvent.click(trigger);
  });
  await act(async () => {
    view.rerender(
      <Harness workspaces={MANY} activeWorkspaceId="api" blockedReason={reason} request={{ nonce: 1, view: "list" }} />,
    );
  });
  await wait();
  assert.equal(screen.queryByRole("combobox", { name: "Search workspaces" }) === null, true);
  const describedBy = trigger.getAttribute("aria-describedby") ?? "";
  assert.equal(document.getElementById(describedBy)?.textContent, reason);
  assert.equal(document.getElementById(describedBy)?.getAttribute("role"), "status");
});

test("a busy draft's menu won't open on request, and its rows can't move the draft", async () => {
  const busy = "Wait for the message to finish sending before changing workspaces.";
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Harness workspaces={MANY} activeWorkspaceId="api" busyReason={busy} />);
  });
  await act(async () => {
    view.rerender(<Harness workspaces={MANY} activeWorkspaceId="api" busyReason={busy} request={{ nonce: 1, view: "clone" }} />);
  });
  await wait();
  assert.equal(screen.queryByRole("dialog") === null, true, "the headline, palette and ⌘⇧O requests are refused");

  // Already open when the send starts: the rows stop working.
  await act(async () => {
    view.rerender(<Harness workspaces={MANY} activeWorkspaceId="api" request={{ nonce: 2, view: "list" }} />);
  });
  await wait();
  await act(async () => {
    view.rerender(<Harness workspaces={MANY} activeWorkspaceId="api" busyReason={busy} request={{ nonce: 2, view: "list" }} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name: /^docs/u }));
    fireEvent.click(screen.getByRole("option", { name: /^Scratch chat/u }));
  });
  await wait();
  assert.deepEqual([selected, scratchCreated], [[], 0]);
});

test("the invalid-URL reason describes the URL field", async () => {
  handlers["workspaces:clonePreview"] = () => ({ ok: false, code: "invalid-url", reason: "Enter a repository URL." });
  await openMenu(MANY, "api", "clone");
  const url = screen.getByLabelText("Git URL or owner/repo") as HTMLInputElement;
  await type(url, "not a url");
  await wait(300);
  const describedBy = (url.getAttribute("aria-describedby") ?? "").split(" ");
  assert.ok(describedBy.some((id) => document.getElementById(id)?.textContent === "Enter a repository URL."));
  assert.equal(url.getAttribute("aria-invalid"), "true");
});

test("a finished clone stays busy until the draft has moved, so it can't start twice", async () => {
  let release!: () => void;
  selectGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  handlers["workspaces:clone"] = () => ({ ok: true, workspace: workspace("site", "site", 5), destination: "/x/site" });
  await startCloneView();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  });
  await wait();
  assert.equal(screen.queryByRole("button", { name: "Clone" }) === null, true);
  assert.equal((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByLabelText("Git URL or owner/repo") as HTMLInputElement).disabled, true);
  await act(async () => {
    release();
  });
  await wait();
  assert.deepEqual(selected, ["site"]);
  assert.equal(calls.filter((call) => call.channel === "workspaces:clone").length, 1);
});

test("a clone that finishes after Cancel is added to the list but does not move the draft", async () => {
  let finish!: (value: unknown) => void;
  handlers["workspaces:clone"] = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await startCloneView();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
  assert.ok(calls.some((call) => call.channel === "workspaces:cloneCancel"));
  await act(async () => {
    finish({ ok: true, workspace: workspace("late", "late", 5), destination: "/x/late" });
  });
  await wait();
  const cached = queryClient.getQueryData<Workspace[]>(queryKeys.workspaces) ?? [];
  assert.equal(cached.some((entry) => entry.id === "late"), true, "the registered clone is listed");
  assert.deepEqual(selected, []);
});

test("closing the menu mid-clone cancels the clone", async () => {
  handlers["workspaces:clone"] = () => new Promise(() => undefined);
  await startCloneView();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
  });
  const cloneId = (calls.find((call) => call.channel === "workspaces:clone")?.args[0] as { cloneId: string }).cloneId;
  // The chip toggles the menu closed (the same close path as clicking outside).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Choose a workspace" }));
  });
  await wait();
  assert.equal(screen.queryByRole("dialog") === null, true);
  assert.deepEqual(calls.find((call) => call.channel === "workspaces:cloneCancel")?.args, [cloneId]);
});
