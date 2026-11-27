// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import type { Chat, Workspace, WorkspaceFileEntry } from "../lib/types";
import { TEST_WORKSPACE, createTestQueryClient, settle } from "../lib/test-harness";

// The real Composer with IPC faked: `@` lists the workspace's files and a pick
// becomes a chip. Boolean oracles throughout: a failing assert on a happy-dom
// node would inspect the whole DOM.

let queryClient: QueryClient;
let sends: string[];
let fileListings: number;
let rejectSends: boolean;
let filesGate: Promise<void> | null;

function entry(path: string, kind: WorkspaceFileEntry["kind"] = "file"): WorkspaceFileEntry {
  const parts = path.split("/");
  return { path, name: parts[parts.length - 1]!, parentPath: parts.slice(0, -1).join("/"), depth: parts.length - 1, kind };
}

const FILES = [
  entry("renderer", "directory"),
  entry("renderer/components/composer.tsx"),
  entry("renderer/components/composer-mention-picker.tsx"),
  entry("README.md"),
];

const CHAT = { id: "chat-1", title: "New chat", messages: [], createdAt: 1, updatedAt: 1 } as unknown as Chat;

beforeEach(() => {
  localStorage.clear();
  sends = [];
  fileListings = 0;
  rejectSends = false;
  filesGate = null;
  installBotTestIpc({
    "settings:get": () => null,
    "app:renderer-ready": () => null,
    "shortcut:get": () => null,
    "pullRequests:list": () => ({ links: [] }),
    "pullRequests:current": () => null,
    "pullRequests:pending": () => [],
    "workspaces:repositoryIdentity": () => null,
    "workspaces:files": async () => {
      fileListings += 1;
      if (filesGate) await filesGate;
      return { entries: FILES, truncated: false, skippedDirectories: 0 };
    },
  });
  queryClient = createTestQueryClient();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

async function mount(workspace: Workspace = TEST_WORKSPACE) {
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CommandSystemProvider>
            <Composer
              ready
              hasMessages={false}
              chatId={CHAT.id}
              sessionChat={CHAT}
              workspace={workspace}
              onRenameChat={() => undefined}
              onSend={async (text) => {
                sends.push(text);
                if (rejectSends) throw new Error("offline");
              }}
              onStop={() => undefined}
              isGenerating={false}
            />
          </CommandSystemProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

async function type(textbox: HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.change(textbox, { target: { value } });
  });
  await settle();
}

async function press(textbox: HTMLTextAreaElement, key: string, init: Record<string, unknown> = {}) {
  await act(async () => {
    fireEvent.keyDown(textbox, { key, ...init });
  });
  await settle();
}

function picker() {
  return screen.queryByRole("listbox", { name: "Workspace files" });
}

function optionTexts(): string[] {
  return screen.queryAllByRole("option").map((option) => option.textContent ?? "");
}

function chipPaths(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-composer-mention]")].map(
    (chip) => chip.dataset.composerMention ?? "",
  );
}

test("@ at a word boundary opens a ranked file listbox the textarea owns, with the match marked", async () => {
  const textbox = await mount();
  await type(textbox, "mail me@comp");
  assert.ok(picker() === null, "an @ inside a word is not a mention");
  assert.ok(fileListings === 0, "files are not listed until a mention starts");

  await type(textbox, "look at @comp");
  assert.ok(picker() !== null, "the picker opens");
  assert.ok(textbox.getAttribute("aria-autocomplete") === "list");
  assert.ok(textbox.getAttribute("aria-controls") === picker()!.id);
  const texts = optionTexts();
  assert.ok(texts.length === 2, `two files match, got ${JSON.stringify(texts)}`);
  assert.ok(texts[0]!.startsWith("composer.tsx"), `best match first, got ${JSON.stringify(texts)}`);
  const active = textbox.getAttribute("aria-activedescendant");
  assert.ok(active !== null && document.getElementById(active)?.getAttribute("aria-selected") === "true");
  const marks = [...picker()!.querySelectorAll("mark")].map((mark) => mark.textContent);
  assert.ok(marks.includes("comp"), `marked ${JSON.stringify(marks)}`);
});

test("arrows move the active file, Enter picks it into one chip and takes the typed @query out", async () => {
  const textbox = await mount();
  await type(textbox, "look at @comp");
  await press(textbox, "ArrowDown");
  const active = document.getElementById(textbox.getAttribute("aria-activedescendant") ?? "");
  assert.ok(active?.textContent?.startsWith("composer-mention-picker.tsx"), "ArrowDown moves to the second file");

  await press(textbox, "Enter");

  assert.ok(textbox.value === "look at ", `draft became ${JSON.stringify(textbox.value)}`);
  assert.deepEqual(chipPaths(), ["renderer/components/composer-mention-picker.tsx"]);
  assert.ok(picker() === null, "the picker closes after a pick");
  assert.ok(sends.length === 0, "Enter on the picker never sends");
});

test("one Backspace at the start of the text deletes the whole chip and nothing else", async () => {
  const textbox = await mount();
  await type(textbox, "@READ");
  await press(textbox, "Tab");
  await type(textbox, "@rend");
  await press(textbox, "Enter");
  assert.deepEqual(chipPaths(), ["README.md", "renderer"]);
  await type(textbox, "explain");
  textbox.setSelectionRange(0, 0);

  await press(textbox, "Backspace");

  assert.deepEqual(chipPaths(), ["README.md"], "the last chip goes, in one press");
  assert.ok(textbox.value === "explain", "the text is untouched");
  textbox.setSelectionRange(3, 3);
  await press(textbox, "Backspace");
  assert.deepEqual(chipPaths(), ["README.md"], "Backspace inside the text leaves the chips alone");
});

test("send writes the chips first as @path, a folder with a slash, then clears them", async () => {
  const textbox = await mount();
  await type(textbox, "@rend");
  await press(textbox, "Enter");
  await type(textbox, "@READ");
  await press(textbox, "Enter");
  await type(textbox, "what changed?");

  await press(textbox, "Enter");
  await settle();

  assert.deepEqual(sends, ["@renderer/ @README.md what changed?"]);
  assert.deepEqual(chipPaths(), []);
});

test("a failed send gives the chips back as chips, the picker stays closed, and a retry sends the same text", async () => {
  const textbox = await mount();
  await type(textbox, "@READ");
  await press(textbox, "Enter");
  await type(textbox, "x");
  rejectSends = true;

  await press(textbox, "Enter");
  await settle();

  assert.deepEqual(sends, ["@README.md x"]);
  assert.ok(textbox.value === "x", `draft became ${JSON.stringify(textbox.value)}`);
  assert.deepEqual(chipPaths(), ["README.md"]);
  assert.ok(picker() === null, "the restored draft does not reopen the picker");
  // A reload has only the stored text, so the unresolved send keeps its mentions as `@path`.
  const stored = JSON.parse(localStorage.getItem(`aiden:composer-draft:${CHAT.id}`) ?? "null") as { unresolvedText?: string } | null;
  assert.ok(stored?.unresolvedText === "@README.md x", `stored ${JSON.stringify(stored)}`);

  rejectSends = false;
  await press(textbox, "Enter");
  await settle();
  assert.deepEqual(sends, ["@README.md x", "@README.md x"], "the retry sends exactly what failed");
  assert.deepEqual(chipPaths(), []);
});

test("a /btw or /visualize prompt keeps @ as text, with no picker", async () => {
  const textbox = await mount();
  await type(textbox, "/btw what is @READ");
  assert.ok(picker() === null);
  await type(textbox, "/visualize @READ");
  assert.ok(picker() === null);
  assert.ok(fileListings === 0);
});

test("Enter waits while the files load instead of sending the typed @query", async () => {
  let release!: () => void;
  filesGate = new Promise((resolve) => {
    release = resolve;
  });
  const textbox = await mount();
  await type(textbox, "@READ");
  assert.ok(picker() !== null);

  await press(textbox, "Enter");
  assert.deepEqual(sends, [], "nothing is sent while loading");
  assert.ok(textbox.value === "@READ");

  await act(async () => {
    release();
  });
  await settle();
  await press(textbox, "Enter");
  assert.deepEqual(chipPaths(), ["README.md"], "once loaded, Enter picks");
});

test("Escape closes the picker without editing; typing on stays closed until the @ is retyped", async () => {
  const textbox = await mount();
  await type(textbox, "@comp");
  assert.ok(picker() !== null);

  await press(textbox, "Escape");
  assert.ok(picker() === null, "Escape closes the picker");
  assert.ok(textbox.value === "@comp", "Escape keeps the text");
  await type(textbox, "@compo");
  assert.ok(picker() === null, "the dismissed mention stays closed");

  await type(textbox, "");
  await type(textbox, "@");
  assert.ok(picker() !== null, "a new @ opens it again");
});

test("keys an input method is composing never move or pick", async () => {
  const textbox = await mount();
  await type(textbox, "@comp");
  await settle();
  const before = textbox.getAttribute("aria-activedescendant");
  assert.ok(before !== null, "the listed files have an active row");
  // Chromium marks a composing key with keyCode 229; a committing Enter carries isComposing.
  await press(textbox, "ArrowDown", { keyCode: 229 });
  assert.ok(textbox.getAttribute("aria-activedescendant") === before);
  await press(textbox, "Enter", { isComposing: true });
  assert.deepEqual(chipPaths(), []);
  assert.ok(textbox.value === "@comp");
});

test("a workspace without folder access offers no mentions", async () => {
  const textbox = await mount({ ...TEST_WORKSPACE, permission: "none" });
  await type(textbox, "@comp");
  assert.ok(picker() === null);
  assert.ok(fileListings === 0);
});
