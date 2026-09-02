import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Chat } from "./types.js";
import {
  emptyDesignProjectDatabase,
  parseDesignProjectDatabaseV1,
  type DesignProjectDatabaseV1,
  type DesignProjectSnapshotV1,
} from "./design-project-contract.js";
import {
  DesignProjectPublicationUncertainError,
  type DesignProjectDeletePlanV1,
  DesignProjectStore,
} from "./design-project-store.js";
import { DataStore } from "./data-store.js";
import {
  DesignProjectLifecycleJournalStore,
  designProjectLifecycleOperationId,
  type DesignProjectDeleteLifecycleRecordV1,
} from "./design-project-lifecycle-journal.js";
import {
  DesignProjectDeletionConfirmationRequiredError,
  RecoverableDesignProjectDuplicatePort,
  createIdempotentDesignProjectChatDelete,
  createDesignProjectLifecycleCoordinator,
} from "./design-project-lifecycle.js";
import { remappedHtmlArtifactMediaId } from "./generative-ui-artifact-store.js";

const sourceProject: DesignProjectSnapshotV1 = {
  version: 1,
  id: "project:source",
  revision: 3,
  title: "Source",
  chatId: "chat:source",
  workspaceId: "workspace:one",
  connectionState: "prototype-only",
  createdAt: 1,
  updatedAt: 2,
  canvas: {
    viewport: "desktop",
    flowViewport: { x: 1, y: 2, zoom: 1 },
    nodes: [
      {
        id: "node:hero",
        kind: "artboard",
        canonicalOrigin: "generated-artifact",
        lineageId: "lineage:hero",
        artifactMediaIds: ["design:one", "design:two"],
        activeMediaId: "design:two",
        x: 0,
        y: 0,
      },
    ],
  },
  referenceAssetIds: ["a".repeat(64)],
};

const sourceChat: Chat = {
  id: "chat:source",
  title: "Source",
  workspaceId: "workspace:one",
  createdAt: 1,
  updatedAt: 2,
  messages: [
    {
      id: "message:one",
      role: "assistant",
      content: "",
      createdAt: 2,
      htmlArtifacts: ["design:one", "design:two", "other:one"].map((mediaId) => ({
        version: 1,
        kind: "html" as const,
        id: `artifact:${mediaId}`,
        title: mediaId,
        mimeType: "text/html" as const,
        size: 10,
        mediaId,
      })),
    },
  ],
};

function deletePlan(): DesignProjectDeletePlanV1 {
  return {
    version: 1,
    projectId: "project:source",
    expectedRevision: 3,
    expectedDatabaseRevision: 7,
    chatId: "chat:source",
    artifactMediaIds: ["design:one", "design:two"],
    detachedReferenceAssetIds: ["a".repeat(64)],
    unreferencedReferenceAssetIds: ["a".repeat(64)],
    commentIds: ["comment:one"],
    designerActionIds: ["action:one"],
  };
}

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiden-design-project-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("owner-only lifecycle journal survives restart and rejects unsafe replacement", async (t) => {
  const root = await temporaryRoot(t);
  const plan = deletePlan();
  const operationId = designProjectLifecycleOperationId("delete", JSON.stringify(plan));
  const record: DesignProjectDeleteLifecycleRecordV1 = {
    version: 1,
    kind: "delete",
    operationId,
    revision: 0,
    stage: "planned",
    plan,
    startedAt: 10,
    updatedAt: 10,
  };
  const store = new DesignProjectLifecycleJournalStore(() => root);
  await store.create(record);
  assert.equal((await stat(join(root, "design-project-lifecycle.json"))).mode & 0o777, 0o600);
  assert.deepEqual((await new DesignProjectLifecycleJournalStore(() => root).list())[0], record);

  const unsafeContents = JSON.stringify({
    version: 1,
    revision: 1,
    operations: [{ prompt: "forbidden" }],
  });
  await writeFile(join(root, "design-project-lifecycle.json"), unsafeContents);
  const unsafe = new DesignProjectLifecycleJournalStore(() => root);
  await assert.rejects(unsafe.list(), /unsupported shape/u);
  assert.equal(await readFile(join(root, "design-project-lifecycle.json"), "utf8"), unsafeContents);
});

test("duplicate prepares every copied chat artifact, shares immutable assets, and clears only after project commit", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const events: string[] = [];
  const chats = new Map<string, Chat>([[sourceChat.id, structuredClone(sourceChat)]]);
  const artifactsByChat = new Map<string, string[]>();
  const projects = new Map<string, DesignProjectSnapshotV1>([[sourceProject.id, sourceProject]]);
  const chatPort = {
    async get(id: string) {
      return structuredClone(chats.get(id) ?? null);
    },
    async copyVisibleHistory(input: {
      sourceChatId: string;
      targetChatId?: string;
      expectedWorkspaceId?: string;
      beforeInstall?: (chat: Chat) => void | Promise<void>;
    }) {
      const target = input.targetChatId!;
      events.push("copy:before-install");
      const copied = structuredClone(sourceChat);
      copied.id = target;
      copied.messages = copied.messages.map((message) => ({
        ...message,
        htmlArtifacts: message.htmlArtifacts?.map((artifact) => ({
          ...artifact,
          mediaId: remappedHtmlArtifactMediaId(target, artifact.mediaId),
        })),
      }));
      await input.beforeInstall?.(copied);
      events.push("copy:install");
      chats.set(target, copied);
      return copied;
    },
    async rename(id: string, title: string) {
      events.push("chat:rename");
      const chat = chats.get(id)!;
      chat.title = title;
      return structuredClone(chat);
    },
    async remove(id: string) {
      events.push("chat:remove");
      chats.delete(id);
    },
  };
  const artifactPort = {
    async prepareSelectedCopy(_source: string, target: string, mediaIds: readonly string[]) {
      events.push(`artifacts:prepare:${mediaIds.length}`);
      const copies = mediaIds.map((mediaId) => ({
        version: 1 as const,
        kind: "html" as const,
        id: `copy:${mediaId}`,
        title: mediaId,
        mimeType: "text/html" as const,
        size: 10,
        mediaId: remappedHtmlArtifactMediaId(target, mediaId),
      }));
      artifactsByChat.set(
        target,
        copies.map(({ mediaId }) => mediaId),
      );
      return copies;
    },
    async commit(_chatId: string, _mediaIds: readonly string[]) {
      events.push("artifacts:commit");
    },
    async deleteChat(chatId: string) {
      events.push("artifacts:remove");
      artifactsByChat.delete(chatId);
    },
  };
  const projectPort = {
    async get(id: string) {
      return structuredClone(projects.get(id));
    },
  };
  const duplicate = new RecoverableDesignProjectDuplicatePort(
    projectPort,
    chatPort,
    artifactPort,
    journal,
    () => 10,
  );
  const prepared = await duplicate.prepareDuplicate({
    source: sourceProject,
    targetProjectId: "project:copy",
    targetTitle: "Copied title",
  });
  assert.deepEqual(events.slice(0, 5), [
    "copy:before-install",
    "artifacts:prepare:3",
    "copy:install",
    "artifacts:commit",
    "chat:rename",
  ]);
  assert.deepEqual(prepared.referenceAssetIds, [{ from: "a".repeat(64), to: "a".repeat(64) }]);
  assert.equal(prepared.artifactMediaIds.length, 2);
  assert.equal((await journal.list()).length, 1);
  projects.set("project:copy", {
    ...sourceProject,
    id: "project:copy",
    chatId: prepared.targetChatId,
  });
  await duplicate.complete("project:copy");
  assert.deepEqual(await journal.list(), []);
  assert.equal(chats.get(prepared.targetChatId)?.title, "Copied title");
});

test("restart removes a prepared duplicate when its project row never committed", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const removed: string[] = [];
  const duplicate = new RecoverableDesignProjectDuplicatePort(
    {
      async get() {
        return undefined;
      },
    },
    {
      async get() {
        return null;
      },
      async copyVisibleHistory() {
        throw new Error("unused");
      },
      async rename() {
        throw new Error("unused");
      },
      async remove(id) {
        removed.push(`chat:${id}`);
      },
    },
    {
      async prepareSelectedCopy() {
        return [];
      },
      async commit() {},
      async deleteChat(id) {
        removed.push(`artifacts:${id}`);
      },
    },
    journal,
  );
  const record = await journal.create({
    version: 1,
    kind: "duplicate",
    operationId: designProjectLifecycleOperationId("duplicate", "project:copy"),
    revision: 0,
    stage: "preparing",
    sourceProjectId: sourceProject.id,
    sourceProjectRevision: sourceProject.revision,
    targetProjectId: "project:copy",
    targetChatId: "chat:copy",
    startedAt: 1,
    updatedAt: 1,
  });
  assert.equal(record.kind, "duplicate");
  await duplicate.recover(record as Extract<typeof record, { kind: "duplicate" }>);
  assert.deepEqual(removed, ["chat:chat:copy", "artifacts:chat:copy"]);
  assert.deepEqual(await journal.list(), []);
});

test("ambiguous duplicate publication retains its installed row, backing chat, and journal", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const chats = new Map<string, Chat>();
  let failPublication = false;
  const data = new DataStore<DesignProjectDatabaseV1>(
    "design-projects.json",
    emptyDesignProjectDatabase(),
    () => root,
    {
      normalize: (value) => parseDesignProjectDatabaseV1(value) ?? emptyDesignProjectDatabase(),
      isSafe: (value) => parseDesignProjectDatabaseV1(value) !== undefined,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      rejectExternalChanges: true,
      reloadBeforeWrite: true,
      async afterDestinationPublish() {
        if (!failPublication) return;
        failPublication = false;
        throw new Error("injected directory sync failure");
      },
    },
  );
  let projects!: DesignProjectStore;
  const duplicate = new RecoverableDesignProjectDuplicatePort(
    {
      get(id) {
        return projects.get(id);
      },
    },
    {
      async get(id) {
        return structuredClone(chats.get(id) ?? null);
      },
      async copyVisibleHistory(input) {
        const source = chats.get(input.sourceChatId);
        if (!source || !input.targetChatId) throw new Error("missing test chat");
        const copy = { ...structuredClone(source), id: input.targetChatId };
        await input.beforeInstall?.(copy);
        chats.set(copy.id, copy);
        return copy;
      },
      async rename(id, title) {
        const chat = chats.get(id);
        if (!chat) throw new Error("missing test chat");
        chat.title = title;
        return structuredClone(chat);
      },
      async remove(id) {
        chats.delete(id);
      },
    },
    {
      async prepareSelectedCopy() {
        return [];
      },
      async commit() {},
      async deleteChat() {},
    },
    journal,
    () => 10,
  );
  let id = 0;
  projects = new DesignProjectStore({
    dataStore: data,
    duplicatePort: duplicate,
    mintProjectId: () => `project:${++id}`,
    now: () => 10,
  });
  await projects.initialize();
  chats.set("chat:ambiguous-source", {
    id: "chat:ambiguous-source",
    title: "Ambiguous source",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  });
  const source = await projects.create({
    chatId: "chat:ambiguous-source",
    title: "Ambiguous source",
    connectionState: "prototype-only",
  });
  const coordinator = createDesignProjectLifecycleCoordinator({
    projectStore: projects,
    duplicatePort: duplicate,
    journal,
    cascade: {
      async deleteChat() {},
      async deleteComments() {},
      async deleteDesignerActions() {},
      async deleteReferenceAssets() {},
    },
  });
  failPublication = true;

  await assert.rejects(
    coordinator.duplicate({ id: source.id, expectedRevision: source.revision }),
    DesignProjectPublicationUncertainError,
  );

  const pending = (await journal.list())[0];
  assert.equal(pending?.kind, "duplicate");
  if (!pending || pending.kind !== "duplicate") throw new Error("missing duplicate journal");
  const installed = await projects.getByChatId(pending.targetChatId);
  assert.equal(installed?.title, "Ambiguous source Copy");
  assert.equal(chats.has(pending.targetChatId), true);
});

test("ambiguous delete publication uses fresh disk authority and resumes its cascade after restart", async (t) => {
  const root = await temporaryRoot(t);
  let failPublication = false;
  const data = new DataStore<DesignProjectDatabaseV1>(
    "design-projects.json",
    emptyDesignProjectDatabase(),
    () => root,
    {
      normalize: (value) => parseDesignProjectDatabaseV1(value) ?? emptyDesignProjectDatabase(),
      isSafe: (value) => parseDesignProjectDatabaseV1(value) !== undefined,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      rejectExternalChanges: true,
      reloadBeforeWrite: true,
      async afterDestinationPublish() {
        if (!failPublication) return;
        failPublication = false;
        throw new Error("injected directory sync failure");
      },
    },
  );
  const projects = new DesignProjectStore({
    dataStore: data,
    mintProjectId: () => "project:ambiguous-delete",
    now: () => 10,
  });
  await projects.initialize();
  const project = await projects.create({
    chatId: "chat:ambiguous-delete",
    title: "Ambiguous delete",
    connectionState: "prototype-only",
  });
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const duplicateFor = (
    projectStore: DesignProjectStore,
    lifecycleJournal: DesignProjectLifecycleJournalStore,
  ) =>
    new RecoverableDesignProjectDuplicatePort(
      projectStore,
      {
        async get() {
          return null;
        },
        async copyVisibleHistory() {
          throw new Error("unused");
        },
        async rename() {
          throw new Error("unused");
        },
        async remove() {},
      },
      {
        async prepareSelectedCopy() {
          return [];
        },
        async commit() {},
        async deleteChat() {},
      },
      lifecycleJournal,
    );
  const events: string[] = [];
  let failChat = true;
  const cascade = {
    async deleteComments() {
      events.push("comments:delete");
    },
    async deleteDesignerActions() {
      events.push("actions:delete");
    },
    async deleteChat() {
      events.push("chat:delete");
      if (failChat) throw new Error("injected chat failure");
    },
    async deleteReferenceAssets() {
      events.push("assets:delete");
    },
  };
  const coordinator = createDesignProjectLifecycleCoordinator({
    projectStore: projects,
    duplicatePort: duplicateFor(projects, journal),
    journal,
    cascade,
  });
  const plan = await projects.planDelete({ id: project.id, expectedRevision: project.revision });
  failPublication = true;

  await assert.rejects(coordinator.deletePlan(plan), /injected chat failure/u);
  assert.equal(await projects.get(project.id), undefined);
  const disk = parseDesignProjectDatabaseV1(
    JSON.parse(await readFile(join(root, "design-projects.json"), "utf8")),
  );
  assert.equal(
    disk?.projects.some(({ id }) => id === project.id),
    false,
  );
  assert.equal((await journal.list())[0]?.kind, "delete");
  assert.deepEqual(events, ["comments:delete", "actions:delete", "chat:delete"]);

  const restartedProjects = new DesignProjectStore({ root: () => root });
  await restartedProjects.initialize();
  const restartedJournal = new DesignProjectLifecycleJournalStore(() => root);
  failChat = false;
  const restarted = createDesignProjectLifecycleCoordinator({
    projectStore: restartedProjects,
    duplicatePort: duplicateFor(restartedProjects, restartedJournal),
    journal: restartedJournal,
    cascade,
  });
  await restarted.recover();
  assert.deepEqual(events.slice(-4), [
    "comments:delete",
    "actions:delete",
    "chat:delete",
    "assets:delete",
  ]);
  assert.deepEqual(await restartedJournal.list(), []);
});

test("delete commits the project row first, retains recovery on failure, and rolls forward after restart", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const projects = new Map<string, DesignProjectSnapshotV1>([[sourceProject.id, sourceProject]]);
  const plan = deletePlan();
  const events: string[] = [];
  let failChat = true;
  const projectStore = {
    async duplicate() {
      throw new Error("unused");
    },
    async planDelete() {
      return structuredClone(plan);
    },
    async delete() {
      events.push("project:delete");
      projects.delete(plan.projectId);
      return structuredClone(plan);
    },
    async get(id: string) {
      return structuredClone(projects.get(id));
    },
    async getByChatId(chatId: string) {
      return structuredClone([...projects.values()].find((project) => project.chatId === chatId));
    },
    async list() {
      return [];
    },
  } as unknown as DesignProjectStore;
  const duplicate = new RecoverableDesignProjectDuplicatePort(
    projectStore,
    {
      async get() {
        return null;
      },
      async copyVisibleHistory() {
        throw new Error("unused");
      },
      async rename() {
        throw new Error("unused");
      },
      async remove() {},
    },
    {
      async prepareSelectedCopy() {
        return [];
      },
      async commit() {},
      async deleteChat() {},
    },
    journal,
  );
  const cascade = {
    async deleteComments() {
      events.push("comments:delete");
    },
    async deleteDesignerActions() {
      events.push("actions:delete");
    },
    async deleteChat() {
      events.push("chat:delete");
      if (failChat) throw new Error("injected chat failure");
    },
    async deleteReferenceAssets() {
      events.push("assets:delete");
    },
  };
  const first = createDesignProjectLifecycleCoordinator({
    projectStore,
    duplicatePort: duplicate,
    journal,
    cascade,
    now: () => 10,
  });
  await assert.rejects(first.deletePlan(plan), /injected chat failure/u);
  assert.equal(projects.has(plan.projectId), false);
  assert.equal((await journal.list())[0]?.kind, "delete");
  assert.deepEqual(events, ["project:delete", "comments:delete", "actions:delete", "chat:delete"]);

  failChat = false;
  const restarted = createDesignProjectLifecycleCoordinator({
    projectStore,
    duplicatePort: duplicate,
    journal,
    cascade,
  });
  await restarted.recover();
  assert.deepEqual(events.slice(-4), [
    "comments:delete",
    "actions:delete",
    "chat:delete",
    "assets:delete",
  ]);
  assert.deepEqual(await journal.list(), []);
});

test("ordinary chat deletion cannot bypass a Design Project cascade confirmation", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const plan = deletePlan();
  let project: DesignProjectSnapshotV1 | undefined = sourceProject;
  let ordinaryDeletes = 0;
  const projectStore = {
    async duplicate() {
      throw new Error("unused");
    },
    async planDelete() {
      return plan;
    },
    async delete() {
      project = undefined;
      return plan;
    },
    async get() {
      return project;
    },
    async getByChatId(chatId: string) {
      return project?.chatId === chatId ? project : undefined;
    },
    async list() {
      return [];
    },
  } as unknown as DesignProjectStore;
  const duplicate = new RecoverableDesignProjectDuplicatePort(
    projectStore,
    {
      async get() {
        return null;
      },
      async copyVisibleHistory() {
        throw new Error("unused");
      },
      async rename() {
        throw new Error("unused");
      },
      async remove() {},
    },
    {
      async prepareSelectedCopy() {
        return [];
      },
      async commit() {},
      async deleteChat() {},
    },
    journal,
  );
  const coordinator = createDesignProjectLifecycleCoordinator({
    projectStore,
    duplicatePort: duplicate,
    journal,
    cascade: {
      async deleteChat() {},
      async deleteComments() {},
      async deleteDesignerActions() {},
      async deleteReferenceAssets() {},
    },
  });
  const request = {
    chatId: sourceProject.chatId,
    async deleteOrdinaryChat() {
      ordinaryDeletes += 1;
    },
  };
  await assert.rejects(
    coordinator.routeChatDeletion(request),
    (error: unknown) =>
      error instanceof DesignProjectDeletionConfirmationRequiredError &&
      error.plan.projectId === sourceProject.id,
  );
  assert.equal(ordinaryDeletes, 0);
  await coordinator.routeChatDeletion({
    ...request,
    confirmation: { projectId: sourceProject.id, expectedRevision: sourceProject.revision },
  });
  assert.equal(project, undefined);
  assert.equal(ordinaryDeletes, 0);
});

test("durable action recovery blocks project deletion before the project row commit", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const plan = deletePlan();
  let deleteCalls = 0;
  const coordinator = createDesignProjectLifecycleCoordinator({
    projectStore: {
      async delete() {
        deleteCalls += 1;
        return plan;
      },
    } as unknown as DesignProjectStore,
    duplicatePort: {} as RecoverableDesignProjectDuplicatePort,
    journal,
    cascade: {
      async prepareDesignerActions() {
        throw new Error("resolve durable source recovery first");
      },
      async deleteChat() {},
      async deleteComments() {},
      async deleteDesignerActions() {},
      async deleteReferenceAssets() {},
    },
  });
  await assert.rejects(coordinator.deletePlan(plan), /resolve durable source recovery first/u);
  assert.equal(deleteCalls, 0);
  assert.deepEqual(await journal.list(), []);
});

test("a stale delete plan leaves preflighted durable actions unchanged", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const plan = deletePlan();
  let durableActionState = "prepared";
  const coordinator = createDesignProjectLifecycleCoordinator({
    projectStore: {
      async delete() {
        throw new Error("delete plan changed");
      },
      async reconcileDeletePublication() {
        return "present" as const;
      },
      async get() {
        return sourceProject;
      },
    } as unknown as DesignProjectStore,
    duplicatePort: {} as RecoverableDesignProjectDuplicatePort,
    journal,
    cascade: {
      async prepareDesignerActions() {
        assert.equal(durableActionState, "prepared");
      },
      async deleteDesignerActions() {
        durableActionState = "removed";
      },
      async deleteChat() {},
      async deleteComments() {},
      async deleteReferenceAssets() {},
    },
  });
  await assert.rejects(coordinator.deletePlan(plan), /delete plan changed/u);
  assert.equal(durableActionState, "prepared");
  assert.deepEqual(await journal.list(), []);
});

test("an uncertain delete publication retains its lifecycle recovery authority", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DesignProjectLifecycleJournalStore(() => root);
  const plan = deletePlan();
  let cascadeCalls = 0;
  const coordinator = createDesignProjectLifecycleCoordinator({
    projectStore: {
      async delete() {
        throw new Error("injected unknown publication");
      },
      async reconcileDeletePublication() {
        return "uncertain" as const;
      },
    } as unknown as DesignProjectStore,
    duplicatePort: {} as RecoverableDesignProjectDuplicatePort,
    journal,
    cascade: {
      async deleteDesignerActions() {
        cascadeCalls += 1;
      },
      async deleteChat() {
        cascadeCalls += 1;
      },
      async deleteComments() {
        cascadeCalls += 1;
      },
      async deleteReferenceAssets() {
        cascadeCalls += 1;
      },
    },
  });

  await assert.rejects(coordinator.deletePlan(plan), /injected unknown publication/u);
  assert.equal(cascadeCalls, 0);
  const pending = (await journal.list())[0];
  assert.equal(pending?.kind, "delete");
  assert.equal(pending?.stage, "planned");

  await assert.rejects(coordinator.recover(), /publication is still uncertain/u);
  assert.equal(cascadeCalls, 0);
  assert.equal((await journal.list())[0]?.operationId, pending?.operationId);
});

test("restart-safe chat cascade skips an already absent payload", async () => {
  let present = true;
  let removes = 0;
  const remove = createIdempotentDesignProjectChatDelete({
    chats: {
      async get() {
        return present ? sourceChat : null;
      },
    },
    application: {
      async remove() {
        removes += 1;
        present = false;
      },
    },
  });
  await remove(sourceChat.id);
  await remove(sourceChat.id);
  assert.equal(removes, 1);
});
