import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { CommandSystemProvider } from "../lib/command-system";
import type { Workspace, WorkspaceFileEntry, WorkspaceFileIndex } from "../lib/types";
import { FilesPanel } from "./files-panel";
import { TooltipProvider } from "./ui";

afterEach(cleanup);

const WORKSPACE: Workspace = { id: "ws-1", name: "prompt-lab", folderPath: "/Users/me/prompt-lab", permission: "full", createdAt: 0, updatedAt: 0 };

const entry = (path: string, kind: WorkspaceFileEntry["kind"]): WorkspaceFileEntry => ({
  path,
  name: path.split("/").pop()!,
  parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  depth: path.split("/").length - 1,
  kind,
});
const index = (...entries: WorkspaceFileEntry[]): WorkspaceFileIndex => ({ entries, truncated: false, skippedDirectories: 0 }) as WorkspaceFileIndex;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function panel(props: { requestedPath: string | null; requestedPathKey: number }) {
  return (
    <QueryClientProvider client={createBotTestQueryClient()}>
      <CommandSystemProvider>
        <TooltipProvider>
          <FilesPanel workspace={WORKSPACE} active compact={false} {...props} />
        </TooltipProvider>
      </CommandSystemProvider>
    </QueryClientProvider>
  );
}

test("a link to a folder newer than the loaded index expands it once the refreshed index lists it", async () => {
  const refresh = deferred<WorkspaceFileIndex>();
  let loads = 0;
  const calls = installBotTestIpc({
    "workspaces:files": () => (++loads === 1 ? index(entry("README.md", "file")) : refresh.promise),
    "workspaces:readFile": () => {
      throw new Error("new-folder is not a file.");
    },
  });
  const view = render(panel({ requestedPath: null, requestedPathKey: 0 }));
  await screen.findByRole("button", { name: "README.md" });

  // The agent created new-folder after the index loaded, then linked it.
  view.rerender(panel({ requestedPath: "new-folder", requestedPathKey: 1 }));
  await waitFor(() => assert.equal(loads, 2));
  assert.equal(calls.some((call) => call.channel === "workspaces:readFile"), false, "not read as a file from a stale index");

  await act(async () => {
    refresh.resolve(index(entry("README.md", "file"), entry("new-folder", "directory"), entry("new-folder/a.css", "file")));
  });
  const folder = await screen.findByRole("button", { name: "new-folder" });
  await waitFor(() => assert.equal(folder.getAttribute("aria-expanded"), "true"));
  assert.ok(await screen.findByRole("button", { name: "a.css" }));
  assert.equal(calls.some((call) => call.channel === "workspaces:readFile"), false);
});

test("a link to a file the index lists opens it in the editor without another refresh", async () => {
  let loads = 0;
  installBotTestIpc({
    "workspaces:files": () => {
      loads += 1;
      return index(entry("thermostat", "directory"), entry("thermostat/style.css", "file"));
    },
    "workspaces:readFile": (_workspaceId, path) => ({ path, content: "h1 { color: tomato; }", size: 21, modifiedAt: 0, version: "v1" }),
  });
  const view = render(panel({ requestedPath: null, requestedPathKey: 0 }));
  await screen.findByRole("button", { name: "thermostat" });
  view.rerender(panel({ requestedPath: "thermostat/style.css", requestedPathKey: 1 }));
  const editor = await screen.findByRole("textbox", { name: "Edit thermostat/style.css" });
  assert.equal((editor as HTMLTextAreaElement).value, "h1 { color: tomato; }");
  assert.equal(loads, 1);
});
