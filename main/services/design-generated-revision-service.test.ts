import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import {
  DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
  newArtboardOwnership,
} from "./design-generated-revision-contract.js";
import { DesignGeneratedRevisionService } from "./design-generated-revision-service.js";
import { DesignProjectRevisionConflictError, DesignProjectStore } from "./design-project-store.js";
import { GenerativeUiArtifactStore } from "./generative-ui-artifact-store.js";

const HTML = "<main>generated</main>";

function artifact(mediaId: string, title: string, revisionOfMediaId?: string): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id: `${mediaId}-hash`,
    title,
    mimeType: "text/html",
    size: Buffer.byteLength(HTML, "utf8"),
    mediaId,
    ...(revisionOfMediaId ? { revisionOfMediaId } : {}),
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "aiden-generated-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = new DesignProjectStore({ root: () => root, now: () => 100 });
  const artifacts = new GenerativeUiArtifactStore({ root: () => root, now: () => 101 });
  await projects.initialize();
  await artifacts.initialize();
  const service = new DesignGeneratedRevisionService({ projects, artifacts });
  return { root, projects, artifacts, service };
}

test("a completed new artboard is project/lineage-owned without using its title", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:new",
    title: "Project title",
    connectionState: "prototype-only",
  });
  const first = artifact("design:new-a", "Repeated display title");
  const second = artifact("design:new-b", "Repeated display title");
  for (const item of [first, second]) {
    await artifacts.stage({
      chatId: project.chatId,
      generationId: "generation:new",
      artifact: item,
      html: HTML,
      designOwnership: newArtboardOwnership(project.id, item.mediaId),
    });
  }
  const mediaIds = [first.mediaId, second.mediaId];
  await service.markSuccessfulCandidate(project.chatId, mediaIds);
  await artifacts.commit(project.chatId, mediaIds);
  await service.publishEligible(project.chatId, mediaIds);

  const published = await projects.get(project.id);
  assert.equal(published?.canvas.nodes.length, 2);
  assert.equal(published?.canvas.nodes[0]?.artifactMediaIds?.[0], first.mediaId);
  assert.equal(published?.canvas.nodes[1]?.artifactMediaIds?.[0], second.mediaId);
  assert.notEqual(
    published?.canvas.nodes[0]?.lineageId,
    published?.canvas.nodes[1]?.lineageId,
    "same-title outputs remain distinct new artboards",
  );
  assert.deepEqual(
    (await artifacts.designPublicationRecords(["published"])).map(
      (record) => record.artifact.mediaId,
    ),
    mediaIds,
  );
});

test("a selected artboard advances only from its exact active base", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:selected",
    title: "Selected",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:selected",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: 0,
          y: 0,
          lineageId: "lineage:selected",
          artifactMediaIds: ["design:base"],
          activeMediaId: "design:base",
        },
      ],
    },
  });
  const child = artifact("design:child", "Renamed output", "design:base");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:child",
    artifact: child,
    html: HTML,
    designOwnership: {
      version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
      kind: "revision",
      projectId: project.id,
      lineageId: "lineage:selected",
      baseMediaId: "design:base",
    },
  });
  await service.markSuccessfulCandidate(project.chatId, [child.mediaId]);
  await artifacts.commit(project.chatId, [child.mediaId]);
  await service.publishEligible(project.chatId, [child.mediaId]);
  assert.deepEqual((await projects.get(project.id))?.canvas.nodes[0]?.artifactMediaIds, [
    "design:base",
    "design:child",
  ]);

  const stale = artifact("design:stale", "Another title", "design:base");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:stale",
    artifact: stale,
    html: HTML,
    designOwnership: {
      version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
      kind: "revision",
      projectId: project.id,
      lineageId: "lineage:selected",
      baseMediaId: "design:base",
    },
  });
  await service.markSuccessfulCandidate(project.chatId, [stale.mediaId]);
  await artifacts.commit(project.chatId, [stale.mediaId]);
  await assert.rejects(
    service.publishEligible(project.chatId, [stale.mediaId]),
    DesignProjectRevisionConflictError,
  );
  assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, "design:child");
  assert.equal(
    (await artifacts.designPublicationRecords(["suppressed"]))[0]?.artifact.mediaId,
    stale.mediaId,
  );
});

test("failed candidates are discarded without replacing the last good revision", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:failed",
    title: "Failed",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:failed",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: 0,
          y: 0,
          lineageId: "lineage:failed",
          artifactMediaIds: ["design:good"],
          activeMediaId: "design:good",
        },
      ],
    },
  });
  const failed = artifact("design:failed", "Good", "design:good");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:failed",
    artifact: failed,
    html: HTML,
    designOwnership: {
      version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
      kind: "revision",
      projectId: project.id,
      lineageId: "lineage:failed",
      baseMediaId: "design:good",
    },
  });
  assert.equal(
    (await artifacts.designPublicationRecords(["candidate"]))[0]?.artifact.mediaId,
    failed.mediaId,
  );
  assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, "design:good");
  await service.discardCandidates(project.chatId, "generation:failed", [failed.mediaId]);
  assert.equal(await artifacts.htmlFor(project.chatId, failed.mediaId), undefined);
  assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, "design:good");
});

test("startup publishes only an eligible candidate whose exact chat artifact persisted", async (t) => {
  const { root, projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:crash",
    title: "Crash",
    connectionState: "prototype-only",
  });
  const persisted = artifact("design:crash-persisted", "Persisted");
  const absent = artifact("design:crash-absent", "Absent");
  for (const item of [persisted, absent]) {
    await artifacts.stage({
      chatId: project.chatId,
      generationId: `generation:${item.mediaId}`,
      artifact: item,
      html: HTML,
      designOwnership: newArtboardOwnership(project.id, item.mediaId),
    });
    await service.markSuccessfulCandidate(project.chatId, [item.mediaId]);
  }

  const restartedProjects = new DesignProjectStore({ root: () => root, now: () => 200 });
  const restartedArtifacts = new GenerativeUiArtifactStore({ root: () => root, now: () => 201 });
  await restartedProjects.initialize();
  await restartedArtifacts.initialize();
  const restarted = new DesignGeneratedRevisionService({
    projects: restartedProjects,
    artifacts: restartedArtifacts,
  });
  await restarted.reconcileAtStartup([
    {
      id: project.chatId,
      messages: [{ role: "assistant", htmlArtifacts: [persisted] }],
    },
  ]);
  const recovered = await restartedProjects.get(project.id);
  assert.deepEqual(
    recovered?.canvas.nodes.map((node) => node.activeMediaId),
    [persisted.mediaId],
  );
  assert.equal(
    (await restartedArtifacts.designPublicationRecords(["published"]))[0]?.artifact.mediaId,
    persisted.mediaId,
  );
  assert.equal(await restartedArtifacts.htmlFor(project.chatId, absent.mediaId), undefined);
});

test("startup discards uncommitted eligible rows when any persisted descriptor field differs", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:descriptor-mismatch",
    title: "Descriptor mismatch",
    connectionState: "prototype-only",
  });
  const mutations: Array<(item: ChatHtmlArtifactV1) => ChatHtmlArtifactV1> = [
    (item) => ({ ...item, revisionOfMediaId: "design:different-parent" }),
    (item) => ({ ...item, title: "Different title" }),
    (item) => ({ ...item, mimeType: "application/xhtml+xml" as "text/html" }),
    (item) => ({ ...item, size: item.size + 1 }),
  ];
  const items = mutations.map((_mutation, index) =>
    artifact(`design:descriptor-mismatch-${index}`, `Descriptor ${index}`),
  );
  for (const [index, item] of items.entries()) {
    await artifacts.stage({
      chatId: project.chatId,
      generationId: `generation:descriptor-mismatch-${index}`,
      artifact: item,
      html: HTML,
      designOwnership: newArtboardOwnership(project.id, item.mediaId),
    });
    await service.markSuccessfulCandidate(project.chatId, [item.mediaId]);
  }

  await service.reconcileAtStartup([
    {
      id: project.chatId,
      messages: [
        {
          role: "assistant",
          htmlArtifacts: items.map((item, index) => mutations[index]!(item)),
        },
      ],
    },
  ]);

  assert.deepEqual((await projects.get(project.id))?.canvas.nodes, []);
  assert.deepEqual(await artifacts.designPublicationRecords(["eligible", "suppressed"]), []);
});

test("startup discards interrupted candidates before generic recovery can advertise them", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:interrupted-candidate",
    title: "Interrupted",
    connectionState: "prototype-only",
  });
  const item = artifact("design:interrupted-candidate", "Interrupted");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:interrupted-candidate",
    artifact: item,
    html: HTML,
    designOwnership: newArtboardOwnership(project.id, item.mediaId),
  });

  await service.reconcileAtStartup([]);
  let appended = false;
  await artifacts.recover([{ id: project.chatId, messages: [] }], async () => {
    appended = true;
  });

  assert.equal((await artifacts.designPublicationRecords(["candidate"])).length, 0);
  assert.equal(await artifacts.htmlFor(project.chatId, item.mediaId), undefined);
  assert.equal(appended, false);
  assert.equal((await projects.get(project.id))?.canvas.nodes.length, 0);
});

test("failed candidate cleanup requires exact generation ownership", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:exact-cleanup",
    title: "Exact cleanup",
    connectionState: "prototype-only",
  });
  const item = artifact("design:exact-cleanup", "Exact cleanup");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:owner",
    artifact: item,
    html: HTML,
    designOwnership: newArtboardOwnership(project.id, item.mediaId),
  });
  await assert.rejects(
    service.discardCandidates(project.chatId, "generation:other", [item.mediaId]),
    /not owned/iu,
  );
  assert.equal(await artifacts.htmlFor(project.chatId, item.mediaId), HTML);
  await service.discardCandidates(project.chatId, "generation:owner", [item.mediaId]);
  assert.equal(await artifacts.htmlFor(project.chatId, item.mediaId), undefined);
});

test("startup isolates one failed Design cleanup from later chats", async (t) => {
  const { projects, artifacts } = await fixture(t);
  const failedProject = await projects.create({
    chatId: "chat:cleanup-fails",
    title: "Cleanup fails",
    connectionState: "prototype-only",
  });
  const healthyProject = await projects.create({
    chatId: "chat:cleanup-continues",
    title: "Cleanup continues",
    connectionState: "prototype-only",
  });
  const failed = artifact("design:cleanup-fails", "Cleanup fails");
  const healthy = artifact("design:cleanup-continues", "Cleanup continues");
  for (const [project, item] of [
    [failedProject, failed],
    [healthyProject, healthy],
  ] as const) {
    await artifacts.stage({
      chatId: project.chatId,
      generationId: `generation:${project.id}`,
      artifact: item,
      html: HTML,
      designOwnership: newArtboardOwnership(project.id, item.mediaId),
    });
  }
  const warnings: string[] = [];
  const service = new DesignGeneratedRevisionService({
    projects,
    artifacts: {
      commit: artifacts.commit.bind(artifacts),
      designPublicationRecords: artifacts.designPublicationRecords.bind(artifacts),
      setDesignPublicationState: artifacts.setDesignPublicationState.bind(artifacts),
      discardPending: async (input) => {
        if (input.chatId === failedProject.chatId) throw new Error("cleanup unavailable");
        return artifacts.discardPending(input);
      },
    },
    onWarning: (message) => warnings.push(message),
  });

  await service.reconcileAtStartup([]);

  assert.equal(await artifacts.htmlFor(failedProject.chatId, failed.mediaId), HTML);
  assert.equal(await artifacts.htmlFor(healthyProject.chatId, healthy.mediaId), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /chat:cleanup-fails/u);
});

test("foreground reconciliation never deletes a live generation candidate", async (t) => {
  const { projects, artifacts } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:live-candidate",
    title: "Live candidate",
    connectionState: "prototype-only",
  });
  const item = artifact("design:live-candidate", "Live candidate");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:live",
    artifact: item,
    html: HTML,
    designOwnership: newArtboardOwnership(project.id, item.mediaId),
  });
  const service = new DesignGeneratedRevisionService({
    projects,
    artifacts,
    isGenerationActive: (generationId) => generationId === "generation:live",
  });

  await service.reconcilePersistedChat({ id: project.chatId, messages: [] });

  assert.equal(await artifacts.htmlFor(project.chatId, item.mediaId), HTML);
  assert.equal((await artifacts.designPublicationRecords(["candidate"])).length, 1);
});

test("foreground reconciliation never deletes a live eligible generation before transcript durability", async (t) => {
  const { projects, artifacts } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:live-eligible",
    title: "Live eligible",
    connectionState: "prototype-only",
  });
  const item = artifact("design:live-eligible", "Live eligible");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:live-eligible",
    artifact: item,
    html: HTML,
    designOwnership: newArtboardOwnership(project.id, item.mediaId),
  });
  await artifacts.setDesignPublicationState(
    project.chatId,
    [item.mediaId],
    ["candidate"],
    "eligible",
  );
  const service = new DesignGeneratedRevisionService({
    projects,
    artifacts,
    isGenerationActive: (generationId) => generationId === "generation:live-eligible",
  });

  const result = await service.reconcilePersistedChat({ id: project.chatId, messages: [] });

  assert.deepEqual(result, {});
  assert.equal(await artifacts.htmlFor(project.chatId, item.mediaId), HTML);
  assert.equal((await artifacts.designPublicationRecords(["eligible"])).length, 1);
});

test("foreground reconciliation reports durable eligibility after publication remains unresolved", async (t) => {
  const { projects, artifacts } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:unresolved-eligible",
    title: "Unresolved eligible",
    connectionState: "prototype-only",
  });
  const item = artifact("design:unresolved-eligible", "Unresolved eligible");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:unresolved-eligible",
    artifact: item,
    html: HTML,
    designOwnership: newArtboardOwnership(project.id, item.mediaId),
  });
  await artifacts.setDesignPublicationState(
    project.chatId,
    [item.mediaId],
    ["candidate"],
    "eligible",
  );
  const service = new DesignGeneratedRevisionService({
    projects: {
      async publishGeneratedRevisions() {
        throw new Error("publication unavailable");
      },
    },
    artifacts,
  });

  const result = await service.reconcilePersistedChat({
    id: project.chatId,
    messages: [{ role: "assistant", htmlArtifacts: [item] }],
  });

  assert.deepEqual(result, { designPublication: "retryable" });
  assert.equal((await artifacts.designPublicationRecords(["eligible"])).length, 1);
});

test("foreground reconciliation reports a semantic conflict suppressed during this attempt", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:suppressed-open",
    title: "Suppressed open",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:suppressed-open",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: 0,
          y: 0,
          lineageId: "lineage:suppressed-open",
          artifactMediaIds: ["design:old", "design:current"],
          activeMediaId: "design:current",
        },
      ],
    },
  });
  const item = artifact("design:stale-child", "Stale child", "design:old");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:suppressed-open",
    artifact: item,
    html: HTML,
    designOwnership: {
      version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
      kind: "revision",
      projectId: project.id,
      lineageId: "lineage:suppressed-open",
      baseMediaId: "design:old",
    },
  });
  await service.markSuccessfulCandidate(project.chatId, [item.mediaId]);

  const result = await service.reconcilePersistedChat({
    id: project.chatId,
    messages: [{ role: "assistant", htmlArtifacts: [item] }],
  });

  assert.deepEqual(result, { designPublication: "suppressed" });
  assert.equal((await artifacts.designPublicationRecords(["eligible"])).length, 0);
  assert.equal((await artifacts.designPublicationRecords(["suppressed"])).length, 1);
  assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, "design:current");
  assert.deepEqual(
    await service.reconcilePersistedChat({
      id: project.chatId,
      messages: [{ role: "assistant", htmlArtifacts: [item] }],
    }),
    {},
    "suppression is projected only by the attempt that observes the semantic conflict",
  );
});

test("route re-entry never publishes older eligible history while the Design chat is generating", async (t) => {
  const { projects, artifacts } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:route-reentry",
    title: "Route re-entry",
    connectionState: "prototype-only",
  });
  const older = artifact("design:older-eligible", "Older eligible");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:older",
    artifact: older,
    html: HTML,
    designOwnership: newArtboardOwnership(project.id, older.mediaId),
  });
  await artifacts.setDesignPublicationState(
    project.chatId,
    [older.mediaId],
    ["candidate"],
    "eligible",
  );
  const service = new DesignGeneratedRevisionService({
    projects,
    artifacts,
    isChatGenerationActive: (chatId) => chatId === project.chatId,
  });

  const result = await service.reconcilePersistedChat({
    id: project.chatId,
    messages: [{ role: "assistant", htmlArtifacts: [older] }],
  });

  assert.deepEqual(result, {});
  assert.equal((await projects.get(project.id))?.canvas.nodes.length, 0);
  assert.equal((await artifacts.designPublicationRecords(["eligible"])).length, 1);
});

test("unknown project-store failure keeps eligibility for deterministic retry", async (t) => {
  const { projects, artifacts } = await fixture(t);
  const project = await projects.create({
    chatId: "chat:retry",
    title: "Retry",
    connectionState: "prototype-only",
  });
  const item = artifact("design:retry", "Retry");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:retry",
    artifact: item,
    html: HTML,
    designOwnership: newArtboardOwnership(project.id, item.mediaId),
  });
  const failing = new DesignGeneratedRevisionService({
    projects: {
      async publishGeneratedRevisions() {
        throw new Error("unknown durable outcome");
      },
    },
    artifacts,
  });
  await failing.markSuccessfulCandidate(project.chatId, [item.mediaId]);
  await assert.rejects(failing.publishEligible(project.chatId, [item.mediaId]), /unknown durable/u);
  assert.equal((await artifacts.designPublicationRecords(["eligible"])).length, 1);

  const retry = new DesignGeneratedRevisionService({ projects, artifacts });
  await retry.publishEligible(project.chatId, [item.mediaId]);
  assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, item.mediaId);
});

test("retry after project publication does not roll a newer active revision backward", async (t) => {
  const { projects, artifacts, service } = await fixture(t);
  let project = await projects.create({
    chatId: "chat:idempotent",
    title: "Idempotent",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:idempotent",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: 0,
          y: 0,
          lineageId: "lineage:idempotent",
          artifactMediaIds: ["design:base", "design:published", "design:newer"],
          activeMediaId: "design:newer",
        },
      ],
    },
  });
  const item = artifact("design:published", "Published", "design:base");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "generation:idempotent",
    artifact: item,
    html: HTML,
    designOwnership: {
      version: DESIGN_GENERATED_REVISION_OWNERSHIP_VERSION,
      kind: "revision",
      projectId: project.id,
      lineageId: "lineage:idempotent",
      baseMediaId: "design:base",
    },
  });
  await service.markSuccessfulCandidate(project.chatId, [item.mediaId]);
  await service.publishEligible(project.chatId, [item.mediaId]);
  project = (await projects.get(project.id))!;
  assert.equal(project.canvas.nodes[0]?.activeMediaId, "design:newer");
  assert.equal(project.canvas.nodes[0]?.artifactMediaIds?.length, 3);
});
