import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";
import { DEFAULT_CHAT_WORKSPACE_ID } from "../shared/chat-workspace";
import {
  noWorkspaceFolderForFirstSend,
  rehomeStrandedNoWorkspaceDrafts,
  releasedNoWorkspaceIds,
} from "./no-workspace-send";
import {
  indexWorkspacesById,
  noWorkspaceHome,
  resolveSidebarGroupWorkspaceId,
  sidebarGroupWorkspaceId,
  workspaceChoices,
} from "./no-workspace";
import { localInboxEntries, localInboxProject } from "./sidebar-inbox-view";
import type { ChatMeta, Workspace } from "./types";

function api(chatsByWorkspace: Record<string, string[]>) {
  let created = 0;
  return {
    created: () => created,
    listChats: async (workspaceId: string) => (chatsByWorkspace[workspaceId] ?? []).map((id) => ({ id })),
    createNoWorkspace: async () => ({ id: `fresh-${++created}` }),
  };
}

test("a No workspace draft keeps an unused hidden folder and never makes another", async () => {
  const fake = api({});
  assert.equal(await noWorkspaceFolderForFirstSend(fake, "hidden-1"), undefined);
  assert.equal(fake.created(), 0);
});

test("a draft in a hidden folder that already holds a chat is saved in a fresh folder", async () => {
  const fake = api({ default: ["older-chat"] });
  assert.equal(await noWorkspaceFolderForFirstSend(fake, "default"), "fresh-1");
  assert.equal(await noWorkspaceFolderForFirstSend(fake, "default"), "fresh-2", "every send gets its own");
});

const record = (id: string, createdAt: number, noWorkspace?: true): Workspace => ({
  id,
  name: noWorkspace ? "No workspace" : id,
  permission: "ask",
  createdAt,
  updatedAt: createdAt,
  ...(noWorkspace ? { noWorkspace } : {}),
});

test("the Chats group is represented by the default home, else the oldest hidden record", () => {
  const project = record("project", 1);
  assert.equal(noWorkspaceHome([project]), undefined);
  assert.equal(noWorkspaceHome([project, record("b", 9, true), record("a", 5, true)])?.id, "a");
  assert.equal(noWorkspaceHome([record("a", 5, true), record("default", 7, true)])?.id, "default");
  assert.deepEqual(workspaceChoices([project, record("a", 5, true)]).map((entry) => entry.id), ["project"]);
});

test("indexed group resolution preserves pass-through and first-match duplicate-id rules", () => {
  const onlyProjects = [record("project-a", 1), record("project-b", 2)];
  const resolveWithoutHome = resolveSidebarGroupWorkspaceId(onlyProjects, indexWorkspacesById(onlyProjects));
  for (const workspaceId of ["project-a", "project-b", "unregistered"]) {
    assert.equal(resolveWithoutHome(workspaceId), workspaceId);
    assert.equal(resolveWithoutHome(workspaceId), sidebarGroupWorkspaceId(workspaceId, onlyProjects));
  }

  const withDuplicates = [
    record("project", 1),
    record("hidden-home", 2, true),
    record("hidden-other", 5, true),
    record("dup-project-first", 6),
    record("dup-project-first", 7, true),
    record("dup-hidden-first", 8, true),
    record("dup-hidden-first", 9),
  ];
  const byId = indexWorkspacesById(withDuplicates);
  const resolveGroup = resolveSidebarGroupWorkspaceId(withDuplicates, byId);
  for (const workspaceId of ["project", "hidden-home", "hidden-other", "dup-project-first", "dup-hidden-first", "missing"]) {
    assert.equal(resolveGroup(workspaceId), sidebarGroupWorkspaceId(workspaceId, withDuplicates), workspaceId);
  }
  assert.equal(resolveGroup("dup-project-first"), "dup-project-first");
  assert.equal(resolveGroup("dup-hidden-first"), "hidden-home");
  assert.equal(resolveGroup("missing"), "missing");
});

test("localInboxEntries and indexed draft grouping match linear scans with O(N + W) workspace id reads", () => {
  const workspaceCount = 5_000;
  const chatCount = 5_000;
  const draftCount = 25;
  let idReads = 0;

  const instrumentedWorkspace = (raw: Workspace): Workspace => {
    const tracked = {
      name: raw.name,
      permission: raw.permission,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(raw.noWorkspace ? { noWorkspace: true } : {}),
    } as Workspace;
    Object.defineProperty(tracked, "id", {
      enumerable: true,
      get() {
        idReads += 1;
        return raw.id;
      },
    });
    return tracked;
  };

  const rawWorkspaces: Workspace[] = [
    record("project-0", 1),
    record("project-1", 2),
    record("dup-id", 3),
    record("dup-id", 4, true),
    ...Array.from({ length: workspaceCount - 4 }, (_, index) => record(`hidden-${index}`, index + 10, true)),
  ];
  const trackedWorkspaces = rawWorkspaces.map(instrumentedWorkspace);

  const chats: ChatMeta[] = Array.from({ length: chatCount }, (_, index) => {
    const id = `chat-${index}`;
    const createdAt = 1_000 + index;
    const updatedAt = 2_000 + index;
    if (index === 0) return { id, title: id, workspaceId: ASSISTANT_WORKSPACE_ID, createdAt, updatedAt };
    if (index === 1) return { id, title: id, workspaceId: undefined, createdAt, updatedAt };
    if (index === 2) return { id, title: id, workspaceId: DEFAULT_CHAT_WORKSPACE_ID, createdAt, updatedAt };
    if (index === 3) return { id, title: id, workspaceId: "project-0", botId: "bot-1", createdAt, updatedAt };
    if (index === 4) return { id, title: id, workspaceId: "removed-workspace", createdAt, updatedAt };
    if (index === 5) return { id, title: id, workspaceId: "dup-id", createdAt, updatedAt };
    if (index % 50 === 0) return { id, title: id, workspaceId: `project-${index % 2}`, createdAt, updatedAt };
    return {
      id,
      title: id,
      workspaceId: `hidden-${index % (workspaceCount - 4)}`,
      createdAt,
      updatedAt,
    };
  });

  idReads = 0;
  const entries = localInboxEntries({
    platform: "darwin",
    chats,
    workspaces: trackedWorkspaces,
    rowState: () => "idle",
    unread: () => false,
    pending: new Map(),
  });
  const inboxIdReads = idReads;
  assert.ok(
    inboxIdReads <= workspaceCount,
    `expected localInboxEntries to read each workspace id at most once (${workspaceCount}), saw ${inboxIdReads}`,
  );

  // Verify exact output equivalence against single-lookup localInboxProject(chat, rawWorkspaces) on a slice covering every branch and tail workspace.
  const verificationIndices = new Set<number>([
    0, 1, 2, 3, 4, 5, 50, 51, 100,
    chatCount - 3, chatCount - 2, chatCount - 1,
  ]);
  const sampleChats = chats.filter((_, index) => verificationIndices.has(index));
  const sampleEntries = localInboxEntries({
    platform: "darwin",
    chats: sampleChats,
    workspaces: trackedWorkspaces,
    rowState: () => "idle",
    unread: () => false,
    pending: new Map(),
  });
  const expectedSample = sampleChats.flatMap((chat) => {
    const project = localInboxProject(chat, rawWorkspaces);
    return project === null ? [] : [[chat.title, project]];
  });
  assert.deepEqual(
    sampleEntries.map((entry) => [entry.title, entry.project]),
    expectedSample,
  );
  assert.equal(entries.length, chatCount - 2, "only the Bot chat and removed-workspace chat are excluded");

  const drafts: ChatMeta[] = Array.from({ length: draftCount }, (_, index) => ({
    id: `draft-${index}`,
    title: "New chat",
    workspaceId:
      index === 0
        ? "project-0"
        : index === 1
          ? "dup-id"
          : index === 2
            ? "unregistered-ws"
            : `hidden-${workspaceCount - 5 - index}`,
    createdAt: 10_000 + index,
    updatedAt: 10_000 + index,
  }));

  idReads = 0;
  const byId = indexWorkspacesById(trackedWorkspaces);
  const resolveGroup = resolveSidebarGroupWorkspaceId(trackedWorkspaces, byId);
  const indexedGroups = new Map<string, string[]>();
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const draftChat = drafts[index]!;
    const groupId = resolveGroup(draftChat.workspaceId!);
    const group = indexedGroups.get(groupId);
    if (group) group.push(draftChat.id);
    else indexedGroups.set(groupId, [draftChat.id]);
  }
  const draftIdReads = idReads;
  assert.ok(
    draftIdReads <= workspaceCount * 2 + 1,
    `expected indexed draft grouping to stay O(N + W) (<= ${workspaceCount * 2 + 1}), saw ${draftIdReads}`,
  );

  const baselineGroups = new Map<string, string[]>();
  for (const draftChat of [...drafts].reverse()) {
    const groupId = sidebarGroupWorkspaceId(draftChat.workspaceId!, rawWorkspaces);
    baselineGroups.set(groupId, [...(baselineGroups.get(groupId) ?? []), draftChat.id]);
  }
  assert.deepEqual([...indexedGroups.entries()], [...baselineGroups.entries()]);
});

type TestDraft = { chat: { id: string; workspaceId: string }; sending: boolean };

/** A draft store fake: moves are applied to the drafts so later reads see them. */
function draftMover(drafts: TestDraft[], createNoWorkspace?: () => Promise<{ id: string }>) {
  const moves: Record<string, string> = {};
  let created = 0;
  return {
    moves,
    created: () => created,
    api: {
      createNoWorkspace: createNoWorkspace ?? (async () => ({ id: `fresh-${++created}` })),
      draftWorkspaceId: (draftId: string) => {
        const found = drafts.find((entry) => entry.chat.id === draftId);
        return found && !found.sending ? found.chat.workspaceId : undefined;
      },
      moveDraft: (draftId: string, workspaceId: string) => {
        moves[draftId] = workspaceId;
        drafts.find((entry) => entry.chat.id === draftId)!.chat.workspaceId = workspaceId;
      },
    },
  };
}

const draft = (id: string, workspaceId: string, sending = false): TestDraft => ({ chat: { id, workspaceId }, sending });

test("deleting a No workspace chat moves drafts aimed at its released folder to the Chats home", async () => {
  const before = new Set(["default", "hidden-a"]);
  const after = [record("project", 1), record("default", 2, true)];
  const released = releasedNoWorkspaceIds(before, after);
  assert.deepEqual([...released], ["hidden-a"]);

  const drafts = [draft("fork-of-deleted", "hidden-a"), draft("project-draft", "project"), draft("saving", "hidden-a", true)];
  const mover = draftMover(drafts);
  const home = await rehomeStrandedNoWorkspaceDrafts(mover.api, drafts, released, after);
  assert.equal(home, "default");
  assert.deepEqual(mover.moves, { "fork-of-deleted": "default" }, "other drafts and a saving draft stay put");
  assert.equal(mover.created(), 0);
});

test("a stranded draft gets a new hidden folder when no Chats home is left", async () => {
  const after = [record("project", 1)];
  const released = releasedNoWorkspaceIds(new Set(["hidden-a"]), after);
  const drafts = [draft("d", "hidden-a")];
  const mover = draftMover(drafts);
  assert.equal(await rehomeStrandedNoWorkspaceDrafts(mover.api, drafts, released, after), "fresh-1");
  assert.deepEqual(mover.moves, { d: "fresh-1" });
});

test("releasing a folder no draft uses makes nothing new", async () => {
  const after = [record("project", 1)];
  const drafts = [draft("d", "project")];
  const mover = draftMover(drafts);
  const released = releasedNoWorkspaceIds(new Set(["hidden-a"]), after);
  assert.equal(await rehomeStrandedNoWorkspaceDrafts(mover.api, drafts, released, after), undefined);
  assert.equal(mover.created(), 0);
});

test("a draft moved to a project while its new Chats folder is being made keeps the project", async () => {
  const after = [record("project", 1)];
  const released = releasedNoWorkspaceIds(new Set(["hidden-a"]), after);
  const drafts = [draft("picked", "hidden-a"), draft("left", "hidden-a")];
  let finishCreate!: (workspace: { id: string }) => void;
  const mover = draftMover(drafts, () => new Promise((resolve) => (finishCreate = resolve)));
  const rehoming = rehomeStrandedNoWorkspaceDrafts(mover.api, drafts, released, after);
  drafts[0]!.chat.workspaceId = "project";
  finishCreate({ id: "replacement" });
  assert.equal(await rehoming, "replacement");
  assert.deepEqual(
    drafts.map((entry) => entry.chat.workspaceId),
    ["project", "replacement"],
  );
});
