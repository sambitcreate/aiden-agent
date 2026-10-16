import assert from "node:assert/strict";
import test from "node:test";
import { newChatWorkspaceChoices } from "./new-chat-workspaces";
import type { Workspace } from "./types";
import {
  cloneFailureMessage,
  cloneProgressLabel,
  isWorkspacePathQuery,
  newCloneId,
  workspaceMenuList,
  workspaceChangeBusyReason,
  workspacePathRow,
} from "./workspace-menu";
import { workspaceCloneId } from "../shared/workspace-intake";

function workspace(id: string, name: string, createdAt: number, extra: Partial<Workspace> = {}): Workspace {
  return { id, name, folderPath: `/Users/me/projects/${name}`, permission: "ask", createdAt, updatedAt: createdAt, ...extra };
}

// Seven workspaces, newest first by creation time (no chats).
const names = ["web", "api", "docs", "infra", "mobile", "design", "notes"];
const choices = newChatWorkspaceChoices(
  names.map((name, index) => workspace(name, name, 1_000 - index)),
  [],
  "api",
);

test("only /, ~ and . start a path query", () => {
  assert.deepEqual(
    ["/tmp", "~/code", "./sub", "../up", " ~/padded", "api", "projects/x", ""].map(isWorkspacePathQuery),
    [true, true, true, true, true, false, false, false],
  );
});

test("an empty query lists the five most recent and offers the rest behind All workspaces", () => {
  const recent = workspaceMenuList(choices, { query: "", expanded: false });
  assert.equal(recent.heading, "Recent");
  assert.deepEqual(recent.rows.map((row) => row.workspace.name), ["web", "api", "docs", "infra", "mobile"]);
  assert.equal(recent.allCount, 7);

  const all = workspaceMenuList(choices, { query: "", expanded: true });
  assert.equal(all.heading, "All workspaces");
  assert.equal(all.rows.length, 7);
  assert.equal(all.allCount, 0);
});

test("five or fewer workspaces need no All workspaces row", () => {
  const few = workspaceMenuList(choices.slice(0, 5), { query: "", expanded: false });
  assert.equal(few.rows.length, 5);
  assert.equal(few.allCount, 0);
});

test("typing searches every workspace, including ones past the recent five, by name or folder", () => {
  const byName = workspaceMenuList(choices, { query: "notes", expanded: false });
  assert.equal(byName.heading, "Matches");
  assert.equal(byName.rows[0]?.workspace.name, "notes");

  const byFolder = workspaceMenuList(
    newChatWorkspaceChoices([workspace("x", "client", 1, { folderPath: "/Volumes/work/acme-portal" })], [], undefined),
    { query: "acme", expanded: false },
  );
  assert.deepEqual(byFolder.rows.map((row) => row.workspace.id), ["x"]);
  assert.equal(workspaceMenuList(choices, { query: "zzzz", expanded: false }).rows.length, 0);
});

test("a path query lists no workspace rows; the path row answers it", () => {
  const list = workspaceMenuList(choices, { query: "~/projects/web", expanded: true });
  assert.deepEqual([list.rows.length, list.allCount], [0, 0]);
});

test("each inspection maps to the row the menu offers", () => {
  const workspaces = [workspace("api", "api", 1)];
  assert.deepEqual(
    workspacePathRow("~/projects/api", { kind: "existing-workspace", workspaceId: "api", path: "/Users/me/projects/api" }, workspaces),
    {
      action: "select",
      input: "~/projects/api",
      workspaceId: "api",
      path: "/Users/me/projects/api",
      label: "api",
      detail: "Already a workspace",
    },
  );
  assert.deepEqual(workspacePathRow("~/repo", { kind: "folder", path: "/Users/me/repo", isGitRepo: true }, []), {
    action: "open",
    input: "~/repo",
    path: "/Users/me/repo",
    label: "Open /Users/me/repo",
    detail: "Git repository",
  });
  const plain = workspacePathRow("~/plain", { kind: "folder", path: "/Users/me/plain", isGitRepo: false }, []);
  assert.equal(plain.action === "open" ? plain.detail : "wrong action", undefined);
  assert.deepEqual(workspacePathRow("~/new", { kind: "creatable", path: "/Users/me/new" }, []), {
    action: "create",
    input: "~/new",
    path: "/Users/me/new",
    label: "Create folder and open /Users/me/new",
  });
  assert.deepEqual(
    workspacePathRow("~/a/b", { kind: "invalid", code: "parent-missing", reason: "The parent folder doesn't exist." }, []),
    { action: "invalid", input: "~/a/b", message: "The parent folder doesn't exist." },
  );
});

test("a registered folder the renderer has not listed yet is named by its path", () => {
  const row = workspacePathRow("/srv/app", { kind: "existing-workspace", workspaceId: "unlisted", path: "/srv/app" }, []);
  assert.equal(row.action === "select" ? row.label : "", "/srv/app");
});

test("clone failures read as main's sentence, cancellation shows nothing, and a stranded clone says where it is", () => {
  assert.equal(cloneFailureMessage({ ok: false, code: "cancelled", reason: "Clone cancelled." }), null);
  assert.equal(
    cloneFailureMessage({ ok: false, code: "not-found", reason: "That repository wasn't found." }),
    "That repository wasn't found.",
  );
  assert.equal(
    cloneFailureMessage({ ok: false, code: "network", reason: "  " }),
    "Git couldn't reach that host. Check the URL and your connection.",
  );
  assert.equal(
    cloneFailureMessage({
      ok: false,
      code: "register-failed",
      reason: "Aiden couldn't add that folder.",
      destination: "/Users/me/projects/site",
    }),
    "Aiden couldn't add that folder. It is in /Users/me/projects/site.",
  );
});

test("clone progress names Git's phase and a clamped whole percentage", () => {
  assert.deepEqual(
    [
      cloneProgressLabel(null),
      cloneProgressLabel({ phase: "Counting objects" }),
      cloneProgressLabel({ phase: "Receiving objects", percent: 41.6 }),
      cloneProgressLabel({ phase: "Resolving deltas", percent: 140 }),
    ],
    ["Cloning…", "Counting objects", "Receiving objects · 42%", "Resolving deltas · 100%"],
  );
});

test("clone ids pass main's routing validation and differ per clone", () => {
  const first = newCloneId();
  const second = newCloneId();
  assert.equal(workspaceCloneId(first), first);
  assert.notEqual(first, second);
  // A random source with hyphens or odd characters still yields a valid id.
  assert.equal(workspaceCloneId(newCloneId(() => "a-b-c-d-e-f-g-h")), "clone_abcdefgh");
});

test("a busy draft names the first thing to wait for", () => {
  const idle = { sending: false, generating: false, gitBusy: false };
  assert.equal(workspaceChangeBusyReason(idle), undefined);
  assert.match(workspaceChangeBusyReason({ ...idle, gitBusy: true }) ?? "", /Git operation/u);
  assert.match(workspaceChangeBusyReason({ ...idle, generating: true, gitBusy: true }) ?? "", /current response/u);
  assert.match(workspaceChangeBusyReason({ sending: true, generating: true, gitBusy: true }) ?? "", /finish sending/u);
});
