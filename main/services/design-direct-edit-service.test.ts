import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import type { DesignerActionV1 } from "../../renderer/shared/source-designer.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type {
  DesignDirectEditProofV1,
  DesignDirectEditTargetV1,
} from "./design-direct-edit-core.js";
import {
  DesignDirectEditService,
  type DesignDirectEditArtifactPort,
  type DesignDirectEditMessagePort,
} from "./design-direct-edit-service.js";
import {
  DesignProjectRevisionConflictError,
  DesignProjectStore,
} from "./design-project-store.js";
import { DesignGeneratedRevisionService } from "./design-generated-revision-service.js";
import { GenerativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import type { ResolvedSourceSelection } from "./source-designer-actions.js";

const HTML =
  '<main><section data-aiden-id="hero" style="padding: 8px; color: var(--surface-primary)">Hello</section></main>';
const HASH = createHash("sha256").update(HTML).digest("hex");
const PROOF: DesignDirectEditProofV1 = {
  selectorMatchCount: 1,
  componentMatchCount: 1,
  literalDefinitionMatchCount: 1,
  computedClass: false,
  dynamicValue: false,
  localizedText: false,
  richText: false,
  semanticColorTokens: ["--surface-primary", "--surface-raised"],
};

async function stores(t: test.TestContext, connected = false) {
  const root = await mkdtemp(join(tmpdir(), "aiden-direct-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = new DesignProjectStore({
    root: () => root,
    now: () => 10,
    mintProjectId: () => "project:one",
  });
  const artifacts = new GenerativeUiArtifactStore({ root: () => root, now: () => 20 });
  await projects.initialize();
  await artifacts.initialize();
  const project = await projects.create({
    chatId: "chat:one",
    title: "Checkout",
    connectionState: connected ? "connected" : "prototype-only",
    ...(connected ? { workspaceId: "workspace:one" } : {}),
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:one",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          lineageId: "lineage:one",
          artifactMediaIds: ["design:base"],
          activeMediaId: "design:base",
          x: 0,
          y: 0,
        },
        ...(connected
          ? [
              {
                id: "source-preview:one",
                kind: "source-preview" as const,
                canonicalOrigin: "connected-app" as const,
                x: 480,
                y: 0,
              },
            ]
          : []),
      ],
    },
  });
  const artifact: ChatHtmlArtifactV1 = {
    version: 1,
    kind: "html",
    id: HASH,
    title: "Checkout",
    mimeType: "text/html",
    size: Buffer.byteLength(HTML),
    mediaId: "design:base",
  };
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "base-generation",
    artifact,
    html: HTML,
  });
  await artifacts.commit(project.chatId, [artifact.mediaId]);
  return { projects, artifacts, project };
}

function prototypeTarget(): Extract<DesignDirectEditTargetV1, { origin: "prototype" }> {
  return {
    origin: "prototype",
    projectId: "project:one",
    lineageId: "lineage:one",
    mediaId: "design:base",
    artifactId: HASH,
    selection: {
      selector: '[data-aiden-id="hero"]',
      tagName: "section",
      elementId: "hero",
    },
    proof: PROOF,
  };
}

function messagePort(messages: ChatHtmlArtifactV1[]): DesignDirectEditMessagePort {
  return {
    async ensureArtifactMessage({ artifact }) {
      const prior = messages.find(({ mediaId }) => mediaId === artifact.mediaId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(artifact)) {
        throw new Error("conflicting chat artifact");
      }
      if (!prior) messages.push(artifact);
    },
  };
}

function artifactPort(
  artifacts: GenerativeUiArtifactStore,
  options: { failCommitOnce?: boolean } = {},
): DesignDirectEditArtifactPort {
  let failCommit = options.failCommitOnce === true;
  return {
    artifactFor: (chatId, mediaId) => artifacts.artifactFor(chatId, mediaId),
    async commit(chatId, mediaIds) {
      if (failCommit) {
        failCommit = false;
        throw new Error("simulated commit failure");
      }
      await artifacts.commit(chatId, mediaIds);
    },
    committedRecoverySourceFor: (chatId, mediaId) =>
      artifacts.committedRecoverySourceFor(chatId, mediaId),
    designPublicationRecords: (states, input) => artifacts.designPublicationRecords(states, input),
    discardPending: (input) => artifacts.discardPending(input),
    htmlFor: (chatId, mediaId) => artifacts.htmlFor(chatId, mediaId),
    setDesignPublicationState: (chatId, mediaIds, from, to) =>
      artifacts.setDesignPublicationState(chatId, mediaIds, from, to),
    stage: (input) => artifacts.stage(input),
  };
}

test("one prototype gesture creates and replays one immutable artifact revision", async (t) => {
  const { projects, artifacts } = await stores(t);
  const messages: ChatHtmlArtifactV1[] = [];
  const service = new DesignDirectEditService({
    projects,
    artifacts,
    messages: messagePort(messages),
    actions: {
      async resolve() {
        throw new Error("unused");
      },
      propose() {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return ["--surface-primary", "--surface-raised"];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
    now: () => 30,
  });
  const input = {
    gestureId: "gesture:one",
    target: prototypeTarget(),
    edit: { kind: "spacing", property: "padding", value: "16px" } as const,
  };
  const first = await service.applyPrototype(input);
  const replay = await service.applyPrototype(input);
  assert.equal(first.artifact.mediaId, replay.artifact.mediaId);
  assert.notEqual(first.artifact.mediaId, "design:base");
  assert.equal(messages.length, 1);
  assert.equal(first.project.canvas.nodes[0]?.artifactMediaIds?.length, 2);
  assert.equal(first.project.canvas.nodes[0]?.activeMediaId, first.artifact.mediaId);
  assert.match(
    (await artifacts.committedSourceFor("chat:one", first.artifact.mediaId))?.html ?? "",
    /padding: 16px/u,
  );
  await assert.rejects(
    service.applyPrototype({ ...input, gestureId: "gesture:new-stale-edit" }),
    /selected prototype revision is stale/iu,
  );
  assert.equal((await projects.get("project:one"))?.canvas.nodes[0]?.artifactMediaIds?.length, 2);
  const undone = await service.undoPrototype({
    undoId: first.undoId,
    projectId: "project:one",
    lineageId: "lineage:one",
    editedMediaId: first.artifact.mediaId,
    revertMediaId: "design:base",
  });
  assert.notEqual(undone.artifact.mediaId, first.artifact.mediaId);
  assert.notEqual(undone.artifact.mediaId, "design:base");
  assert.equal(undone.artifact.id, HASH);
  assert.equal(undone.project.canvas.nodes[0]?.activeMediaId, undone.artifact.mediaId);
  assert.equal(undone.project.canvas.nodes[0]?.artifactMediaIds?.length, 3);
  assert.equal(
    (await artifacts.committedSourceFor("chat:one", undone.artifact.mediaId))?.html,
    HTML,
  );
  assert.equal(messages.length, 2);
  assert.equal(
    (
      await service.undoPrototype({
      undoId: first.undoId,
      projectId: "project:one",
      lineageId: "lineage:one",
      editedMediaId: first.artifact.mediaId,
      revertMediaId: "design:base",
      })
    ).artifact.mediaId,
    undone.artifact.mediaId,
  );
});

test("prototype undo rejects an unrelated deterministic identity and never selects old bytes", async (t) => {
  const { projects, artifacts } = await stores(t);
  const service = new DesignDirectEditService({
    projects,
    artifacts,
    messages: messagePort([]),
    actions: {
      async resolve() {
        throw new Error("unused");
      },
      propose() {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  });
  assert.throws(
    () =>
      service.undoPrototype({
      undoId: `undo:${"a".repeat(64)}`,
      projectId: "project:one",
      lineageId: "lineage:one",
      editedMediaId: "design:base",
      revertMediaId: "design:base",
    }),
    /not owned by this direct-edit undo/iu,
  );
  assert.equal((await projects.get("project:one"))?.canvas.nodes[0]?.activeMediaId, "design:base");
});

test("prototype source hash and authoritative semantic tokens fail closed", async (t) => {
  const { projects, artifacts } = await stores(t);
  const service = new DesignDirectEditService({
    projects,
    artifacts,
    messages: messagePort([]),
    actions: {
      async resolve() {
        throw new Error("unused");
      },
      propose() {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return ["--surface-primary"];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  });
  await assert.rejects(
    service.applyPrototype({
      gestureId: "gesture:bad-hash",
      target: { ...prototypeTarget(), artifactId: "a".repeat(64) },
      edit: { kind: "spacing", property: "padding", value: "16px" },
    }),
    /source hash/iu,
  );
  await assert.rejects(
    service.applyPrototype({
      gestureId: "gesture:bad-token",
      target: prototypeTarget(),
      edit: { kind: "color-token", property: "color", token: "--surface-raised" },
    }),
    /current design-system snapshot/iu,
  );
});

test("an unknown project publication outcome keeps committed bytes eligible without advancing the project", async (t) => {
  const { projects, artifacts, project } = await stores(t);
  const service = new DesignDirectEditService({
    projects: {
      get: (id) => projects.get(id),
      async publishGeneratedRevisions() {
        throw new Error("simulated CAS failure");
      },
    },
    artifacts,
    messages: messagePort([]),
    actions: {
      async resolve() {
        throw new Error("unused");
      },
      propose() {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  });
  await assert.rejects(
    service.applyPrototype({
      gestureId: "gesture:cas",
      target: prototypeTarget(),
      edit: { kind: "spacing", property: "padding", value: "16px" },
    }),
    /simulated CAS failure/u,
  );
  assert.equal(await artifacts.hasPending(project.chatId), false);
  assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, "design:base");
  assert.equal(
    (await artifacts.designPublicationRecords(["eligible"], { chatId: project.chatId })).length,
    1,
  );
});

test("a semantic direct-edit publication conflict is suppressed instead of retried at startup", async (t) => {
  const { projects, artifacts, project } = await stores(t);
  const service = new DesignDirectEditService({
    projects: {
      get: (id) => projects.get(id),
      async publishGeneratedRevisions() {
        throw new DesignProjectRevisionConflictError(project.revision);
      },
    },
    artifacts,
    messages: messagePort([]),
    actions: {
      async resolve() {
        throw new Error("unused");
      },
      propose() {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  });
  await assert.rejects(
    service.applyPrototype({
      gestureId: "gesture:semantic-conflict",
      target: prototypeTarget(),
      edit: { kind: "spacing", property: "padding", value: "16px" },
    }),
    DesignProjectRevisionConflictError,
  );
  assert.equal(
    (await artifacts.designPublicationRecords(["suppressed"], { chatId: project.chatId })).length,
    1,
  );
});

for (const failpoint of ["message", "commit"] as const) {
  test(`prototype publication retries deterministically after a ${failpoint} barrier failure`, async (t) => {
    const { projects, artifacts, project } = await stores(t);
    const messages: ChatHtmlArtifactV1[] = [];
    let failMessage = failpoint === "message";
    const durableMessages = messagePort(messages);
    const service = new DesignDirectEditService({
      projects,
      artifacts: artifactPort(artifacts, { failCommitOnce: failpoint === "commit" }),
      messages: {
        async ensureArtifactMessage(input) {
          if (failMessage) {
            failMessage = false;
            throw new Error("simulated message failure");
          }
          await durableMessages.ensureArtifactMessage(input);
        },
      },
      actions: {
        async resolve() {
          throw new Error("unused");
        },
        propose() {
          throw new Error("unused");
        },
      },
      async semanticColorTokens() {
        return [];
      },
      async proveConnectedComponentSingleUse() {
        return true;
      },
    });
    const input = {
      gestureId: `gesture:${failpoint}`,
      target: prototypeTarget(),
      edit: { kind: "spacing", property: "padding", value: "16px" } as const,
    };
    await assert.rejects(service.applyPrototype(input), new RegExp(`simulated ${failpoint}`, "u"));
    assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, "design:base");
    const [eligible] = await artifacts.designPublicationRecords(["eligible"], {
      chatId: project.chatId,
    });
    assert.ok(eligible);
    assert.equal(
      Boolean(await artifacts.committedSourceFor(project.chatId, eligible.artifact.mediaId)),
      false,
    );

    const result = await service.applyPrototype(input);
    assert.equal(result.artifact.mediaId, eligible.artifact.mediaId);
    assert.equal(result.project.canvas.nodes[0]?.activeMediaId, eligible.artifact.mediaId);
    assert.equal(messages.length, 1);
    assert.equal(
      (
        await artifacts.designPublicationRecords(["published"], {
          chatId: project.chatId,
          mediaIds: [eligible.artifact.mediaId],
        })
      ).length,
      1,
    );
  });
}

test("prototype publication resumes idempotently after project publication response loss", async (t) => {
  const { projects, artifacts, project } = await stores(t);
  const messages: ChatHtmlArtifactV1[] = [];
  let loseResponse = true;
  const service = new DesignDirectEditService({
    projects: {
      get: (id) => projects.get(id),
      async publishGeneratedRevisions(input) {
        const published = await projects.publishGeneratedRevisions(input);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("simulated response loss after project publication");
        }
        return published;
      },
    },
    artifacts,
    messages: messagePort(messages),
    actions: {
      async resolve() {
        throw new Error("unused");
      },
      propose() {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  });
  const input = {
    gestureId: "gesture:lost-project-response",
    target: prototypeTarget(),
    edit: { kind: "spacing", property: "padding", value: "16px" } as const,
  };
  await assert.rejects(service.applyPrototype(input), /response loss after project publication/u);
  const afterLoss = (await projects.get(project.id))!;
  const mediaId = afterLoss.canvas.nodes[0]?.activeMediaId;
  assert.notEqual(mediaId, "design:base");
  assert.ok(mediaId);
  assert.ok(await artifacts.committedSourceFor(project.chatId, mediaId));
  assert.equal(messages.length, 1);
  assert.equal(
    (
      await artifacts.designPublicationRecords(["eligible"], {
        chatId: project.chatId,
        mediaIds: [mediaId],
      })
    ).length,
    1,
  );

  const replay = await service.applyPrototype(input);
  assert.equal(replay.artifact.mediaId, mediaId);
  assert.match(replay.undoId, /^undo:[a-f0-9]{64}$/u);
  assert.equal(replay.project.canvas.nodes[0]?.artifactMediaIds?.length, 2);
  assert.equal(messages.length, 1);
  assert.equal(
    (
      await artifacts.designPublicationRecords(["published"], {
        chatId: project.chatId,
        mediaIds: [mediaId],
      })
    ).length,
    1,
  );
  const undone = await service.undoPrototype({
    undoId: replay.undoId,
    projectId: project.id,
    lineageId: "lineage:one",
    editedMediaId: replay.artifact.mediaId,
    revertMediaId: "design:base",
  });
  assert.notEqual(undone.artifact.mediaId, replay.artifact.mediaId);
  assert.equal(undone.project.canvas.nodes[0]?.artifactMediaIds?.length, 3);
});

test("prototype undo resumes idempotently after project publication response loss", async (t) => {
  const { projects, artifacts, project } = await stores(t);
  const messages: ChatHtmlArtifactV1[] = [];
  const dependencies = {
    artifacts,
    messages: messagePort(messages),
    actions: {
      async resolve(): Promise<never> {
        throw new Error("unused");
      },
      propose(): never {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  };
  const initial = await new DesignDirectEditService({ projects, ...dependencies }).applyPrototype({
    gestureId: "gesture:undo-response-loss",
    target: prototypeTarget(),
    edit: { kind: "spacing", property: "padding", value: "16px" },
  });
  let loseResponse = true;
  const service = new DesignDirectEditService({
    ...dependencies,
    projects: {
      get: (id) => projects.get(id),
      async publishGeneratedRevisions(input) {
        const published = await projects.publishGeneratedRevisions(input);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("simulated undo response loss");
        }
        return published;
      },
    },
  });
  const input = {
    undoId: initial.undoId,
    projectId: project.id,
    lineageId: "lineage:one",
    editedMediaId: initial.artifact.mediaId,
    revertMediaId: "design:base",
  };
  await assert.rejects(service.undoPrototype(input), /undo response loss/u);
  const afterLoss = (await projects.get(project.id))!;
  const mediaId = afterLoss.canvas.nodes[0]?.activeMediaId;
  assert.ok(mediaId);
  assert.notEqual(mediaId, initial.artifact.mediaId);
  assert.ok(await artifacts.committedSourceFor(project.chatId, mediaId));

  const replay = await service.undoPrototype(input);
  assert.equal(replay.artifact.mediaId, mediaId);
  assert.equal(replay.project.canvas.nodes[0]?.artifactMediaIds?.length, 3);
  assert.equal(messages.length, 2);
  assert.equal(
    (
      await artifacts.designPublicationRecords(["published"], {
        chatId: project.chatId,
        mediaIds: [mediaId],
      })
    ).length,
    1,
  );
});

test("startup reconciliation completes interrupted direct edits and direct-edit reverts", async (t) => {
  const { projects, artifacts, project } = await stores(t);
  const messages: ChatHtmlArtifactV1[] = [];
  const common = {
    messages: messagePort(messages),
    actions: {
      async resolve(): Promise<never> {
        throw new Error("unused");
      },
      propose(): never {
        throw new Error("unused");
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  };
  const editService = new DesignDirectEditService({
    projects,
    artifacts: artifactPort(artifacts, { failCommitOnce: true }),
    ...common,
  });
  const editInput = {
    gestureId: "gesture:startup-recovery",
    target: prototypeTarget(),
    edit: { kind: "spacing", property: "padding", value: "16px" } as const,
  };
  await assert.rejects(editService.applyPrototype(editInput), /simulated commit failure/u);
  const [editedArtifact] = messages;
  assert.ok(editedArtifact);
  assert.equal((await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId, "design:base");
  const revisions = new DesignGeneratedRevisionService({ projects, artifacts });
  await revisions.reconcileAtStartup([
    { id: project.chatId, messages: [{ role: "assistant", htmlArtifacts: messages }] },
  ]);
  assert.equal(
    (await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId,
    editedArtifact.mediaId,
  );
  assert.ok(await artifacts.committedSourceFor(project.chatId, editedArtifact.mediaId));

  const undoService = new DesignDirectEditService({
    projects,
    artifacts: artifactPort(artifacts, { failCommitOnce: true }),
    ...common,
  });
  const completedEdit = await editService.applyPrototype(editInput);
  await assert.rejects(
    undoService.undoPrototype({
      undoId: completedEdit.undoId,
      projectId: project.id,
      lineageId: "lineage:one",
      editedMediaId: editedArtifact.mediaId,
      revertMediaId: "design:base",
    }),
    /simulated commit failure/u,
  );
  const revertArtifact = messages[1];
  assert.ok(revertArtifact);
  assert.equal(
    (await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId,
    editedArtifact.mediaId,
  );
  await revisions.reconcileAtStartup([
    { id: project.chatId, messages: [{ role: "assistant", htmlArtifacts: messages }] },
  ]);
  assert.equal(
    (await projects.get(project.id))?.canvas.nodes[0]?.activeMediaId,
    revertArtifact.mediaId,
  );
  assert.ok(await artifacts.committedSourceFor(project.chatId, revertArtifact.mediaId));
  assert.equal(
    (await artifacts.designPublicationRecords(["published"], { chatId: project.chatId })).length,
    2,
  );
});

test("one connected gesture produces one pending Designer Action from the live binding", async (t) => {
  const { projects, artifacts } = await stores(t, true);
  const source = `export function App() { return <section data-aiden-id="hero" style={{ padding: "8px" }}>Hello</section>; }`;
  const start = source.indexOf("<section");
  const end = source.indexOf("</section>") + "</section>".length;
  const snippet = source.slice(start, end);
  const binding: ResolvedSourceSelection = {
    version: 1,
    id: "selection:one",
    projectId: "project:one",
    sessionId: "session:one",
    workspaceId: "workspace:one",
    path: "src/App.tsx",
    sourceVersion: createHash("sha256").update(source).digest("hex"),
    start,
    end,
    lineNumber: 1,
    columnNumber: 32,
    snippet,
    selection: {
      version: 1,
      tagName: "section",
      label: "Hero",
      selector: '[data-aiden-id="hero"]',
      elementId: "hero",
    },
    ownerDocumentId: "document:one",
    root: "/workspace",
    source,
    createdAt: 1,
  };
  const target: Extract<DesignDirectEditTargetV1, { origin: "connected-app" }> = {
    origin: "connected-app",
    projectId: "project:one",
    lineageId: "source-preview:one",
    mediaId: binding.sourceVersion,
    workspaceId: "workspace:one",
    path: binding.path,
    sourceVersion: binding.sourceVersion,
    start,
    end,
    preimage: snippet,
    preimageHash: createHash("sha256").update(snippet).digest("hex"),
    selection: {
      selector: binding.selection.selector,
      tagName: binding.selection.tagName,
      elementId: binding.selection.elementId,
    },
    proof: PROOF,
  };
  const owner: ChatGenerationOwner = {
    id: 1,
    documentId: "document:one",
    isDestroyed: () => false,
    send: () => undefined,
    onInvalidated: () => () => undefined,
  };
  let proposed = 0;
  const service = new DesignDirectEditService({
    projects,
    artifacts,
    messages: messagePort([]),
    actions: {
      async resolve() {
        return binding;
      },
      propose(input): DesignerActionV1 {
        proposed += 1;
        assert.match(input.replacement, /padding: "16px"/u);
        assert.match(input.actionId ?? "", /^action_[a-f0-9]{64}$/u);
        return {
          version: 1,
          id: "action:one",
          projectId: binding.projectId,
          chatId: input.chatId,
          workspaceId: binding.workspaceId,
          status: "pending",
          label: input.label,
          path: binding.path,
          selectionLabel: binding.selection.label,
          before: binding.snippet,
          after: input.replacement,
          createdAt: 1,
        };
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return true;
    },
  });
  const request = {
    owner,
    chatId: "chat:one",
    sourceSelectionId: binding.id,
    gestureId: "gesture:connected",
    target,
    edit: { kind: "spacing", property: "padding", value: "16px" } as const,
  };
  const first = await service.applyConnected(request);
  const replay = await service.applyConnected(request);
  assert.equal(first.action.id, replay.action.id);
  assert.equal(first.action.status, "pending");
  assert.equal(proposed, 1);

  const shared = new DesignDirectEditService({
    projects,
    artifacts,
    messages: messagePort([]),
    actions: {
      async resolve() {
        return binding;
      },
      propose() {
        assert.fail("a shared component must not produce a Designer Action");
      },
    },
    async semanticColorTokens() {
      return [];
    },
    async proveConnectedComponentSingleUse() {
      return false;
    },
  });
  await assert.rejects(
    shared.applyConnected({ ...request, gestureId: "gesture:shared" }),
    /ambiguous or shared component/iu,
  );
});
