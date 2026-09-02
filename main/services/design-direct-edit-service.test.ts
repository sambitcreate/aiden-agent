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
  type DesignDirectEditMessagePort,
} from "./design-direct-edit-service.js";
import { DesignProjectStore } from "./design-project-store.js";
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
    (await service.undoPrototype({
      undoId: first.undoId,
      projectId: "project:one",
      lineageId: "lineage:one",
      editedMediaId: first.artifact.mediaId,
      revertMediaId: "design:base",
    })).artifact.mediaId,
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
    () => service.undoPrototype({
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

test("a failed project CAS discards only the newly staged prototype bytes", async (t) => {
  const { projects, artifacts, project } = await stores(t);
  const service = new DesignDirectEditService({
    projects: {
      get: (id) => projects.get(id),
      async update() {
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
