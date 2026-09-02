import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import {
  DesignArtifactRecoveryService,
  recoverableHtmlFromJournal,
  type DesignArtifactRecoveryDependencies,
  type DesignArtifactRecoverySource,
} from "./design-artifact-recovery.js";
import { OMITTED_DESIGN_HTML_SENTINEL, validateGenerativeUiHtml } from "./generative-ui-html.js";
import type { PiSessionEntry } from "./pi-session-port.js";
import type { DesignGeneratedRevisionOwnershipV1 } from "./design-generated-revision-contract.js";
import { DesignGeneratedRevisionService } from "./design-generated-revision-service.js";
import { inspectDesignProjectHealth } from "./design-project-health.js";
import { DesignProjectStore } from "./design-project-store.js";
import { GenerativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { designArtifactRecoveryFingerprint } from "./generative-ui-artifact-store.js";
import { latestActiveDesignArtifact } from "./design-generation-context.js";

const VALID_HTML = "<!doctype html><html><body><main>Provably valid</main></body></html>";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(mediaId: string, html: string, parent?: string): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id: digest(html),
    title: "Checkout",
    mimeType: "text/html",
    size: Buffer.byteLength(html, "utf8"),
    mediaId,
    ...(parent ? { revisionOfMediaId: parent } : {}),
  };
}

function fixtureProject(mediaId: string): DesignProjectSnapshotV1 {
  return {
    version: 1,
    id: "project:recovery",
    revision: 3,
    title: "Recovery",
    chatId: "chat:recovery",
    connectionState: "prototype-only",
    createdAt: 1,
    updatedAt: 3,
    referenceAssetIds: [],
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:recovery",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          lineageId: "lineage:recovery",
          artifactMediaIds: [mediaId],
          activeMediaId: mediaId,
          x: 0,
          y: 0,
        },
      ],
    },
  };
}

function messageEntry(seq: number, message: unknown): PiSessionEntry {
  return {
    type: "message",
    id: `entry-${seq}`,
    seq,
    parentId: seq === 0 ? null : `entry-${seq - 1}`,
    timestamp: seq,
    message,
  } as unknown as PiSessionEntry;
}

function userEntry(seq: number, content: string): PiSessionEntry {
  return messageEntry(seq, { role: "user", content, timestamp: seq });
}

function assistantEntry(seq: number, content: unknown[]): PiSessionEntry {
  return messageEntry(seq, {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: seq,
  });
}

function toolResultEntry(seq: number, toolCallId: string, isError = false): PiSessionEntry {
  return messageEntry(seq, {
    role: "toolResult",
    toolCallId,
    toolName: "render_artifact",
    content: [{ type: "text", text: isError ? "Rejected" : "Rendered Design artifact." }],
    isError,
    timestamp: seq,
  });
}

function toolCall(id: string, html: string) {
  return { type: "toolCall", id, name: "render_artifact", arguments: { title: "Checkout", html } };
}

type StoredRecoveryRecord = DesignArtifactRecoverySource & {
  committed: boolean;
  createdAt: number;
  designOwnership?: DesignGeneratedRevisionOwnershipV1;
};

function harness(options: {
  html?: string;
  entries?: PiSessionEntry[];
  journalError?: Error;
  failOnceAt?: "candidate" | "eligible" | "committed" | "project-published";
  priorHtml?: string;
}) {
  const generationId = "generation-1";
  const callId = "call-first";
  const mediaId = `design:${digest(`${generationId}:html\0${callId}`)}`;
  let project = fixtureProject(mediaId);
  const records = new Map<string, StoredRecoveryRecord>();
  if (options.priorHtml) {
    const priorMediaId = "design:prior-valid";
    project.canvas.nodes[0]!.artifactMediaIds = [priorMediaId, mediaId];
    records.set(priorMediaId, {
      chatId: project.chatId,
      generationId: "generation-prior",
      artifact: artifact(priorMediaId, options.priorHtml),
      html: options.priorHtml,
      committed: true,
      createdAt: 50,
    });
  }
  if (options.html !== undefined) {
    records.set(mediaId, {
      chatId: project.chatId,
      generationId,
      artifact: artifact(mediaId, options.html),
      html: options.html,
      committed: true,
      createdAt: 50,
    });
  }
  let messageCount = 0;
  let failed = false;
  const failOnce = (point: NonNullable<typeof options.failOnceAt>) => {
    if (!failed && options.failOnceAt === point) {
      failed = true;
      throw new Error(`failpoint:${point}`);
    }
  };
  const dependencies: DesignArtifactRecoveryDependencies = {
    projects: {
      async get(id) {
        return id === project.id ? structuredClone(project) : undefined;
      },
      async removeMissingGeneratedArtboard(input) {
        assert.equal(input.projectId, project.id);
        assert.equal(input.expectedRevision, project.revision);
        const before = project;
        project = {
          ...project,
          revision: project.revision + 1,
          canvas: {
            ...project.canvas,
            nodes: project.canvas.nodes.filter(
              (node) =>
                node.lineageId !== input.lineageId || node.activeMediaId !== input.activeMediaId,
            ),
          },
        };
        assert.notDeepEqual(project, before);
        return structuredClone(project);
      },
      async removeMissingGeneratedRevision(input) {
        assert.equal(input.projectId, project.id);
        assert.equal(input.expectedRevision, project.revision);
        project = {
          ...project,
          revision: project.revision + 1,
          canvas: {
            ...project.canvas,
            nodes: project.canvas.nodes.map((node) =>
              node.lineageId === input.lineageId &&
              node.activeMediaId === input.expectedActiveMediaId
                ? {
                    ...node,
                    artifactMediaIds: node.artifactMediaIds?.filter(
                      (mediaId) => mediaId !== input.missingMediaId,
                    ),
                  }
                : node,
            ),
          },
        };
        return structuredClone(project);
      },
    },
    artifacts: {
      async committedRecoverySourceFor(chatId, id) {
        const source = records.get(id);
        return source?.chatId === chatId && source.committed ? structuredClone(source) : undefined;
      },
      async stage(input) {
        records.set(input.artifact.mediaId, {
          chatId: input.chatId,
          generationId: input.generationId,
          ...(input.model ? { model: input.model } : {}),
          artifact: structuredClone(input.artifact),
          html: input.html,
          committed: false,
          createdAt: 50,
          designPublication: "candidate",
          ...(input.designOwnership ? { designOwnership: input.designOwnership } : {}),
        });
        return "inserted";
      },
      async stageRecoveryReplacement(input) {
        records.set(input.artifact.mediaId, {
          chatId: input.chatId,
          generationId: input.generationId,
          ...(input.model ? { model: input.model } : {}),
          artifact: structuredClone(input.artifact),
          html: input.html,
          committed: false,
          createdAt: 50,
          designPublication: "candidate",
          designOwnership: input.designOwnership,
        });
        return "inserted";
      },
      async commit(_chatId, mediaIds) {
        for (const id of mediaIds) records.get(id)!.committed = true;
        failOnce("committed");
      },
      async designPublicationRecords(states, input) {
        return [...records.values()]
          .filter(
            (record) =>
              record.designPublication !== undefined &&
              states.includes(record.designPublication) &&
              (input?.chatId === undefined || record.chatId === input.chatId) &&
              (input?.mediaIds === undefined || input.mediaIds.includes(record.artifact.mediaId)),
          )
          .map((record) => structuredClone(record)) as never;
      },
      async setDesignPublicationState(_chatId, mediaIds, from, to) {
        for (const id of mediaIds) {
          const record = records.get(id)!;
          assert.equal(from.includes(record.designPublication!), true);
          record.designPublication = to;
        }
      },
      async withMissingArtifactGuard(_chatId, id, operation) {
        if (records.has(id)) return { status: "artifact-present" };
        return { status: "completed", value: await operation() };
      },
      async withDamagedArtifactGuard(input, operation) {
        const source = records.get(input.mediaId);
        if (
          !source ||
          !source.committed ||
          designArtifactRecoveryFingerprint(source) !== input.expectedFingerprint
        ) {
          return { status: "artifact-changed" };
        }
        try {
          if (source.artifact.id === digest(source.html)) {
            validateGenerativeUiHtml(source.html);
            if (input.allowValidContent !== true) return { status: "artifact-valid" };
          }
        } catch {
          // The exact invalid record remains eligible for the project repair.
        }
        return { status: "completed", value: await operation() };
      },
    },
    messages: {
      async ensureArtifactMessage() {
        messageCount += 1;
      },
    },
    revisions: {
      async markSuccessfulCandidate(_chatId, mediaIds) {
        failOnce("candidate");
        for (const id of mediaIds) records.get(id)!.designPublication = "eligible";
        failOnce("eligible");
      },
      async publishEligible(_chatId, mediaIds) {
        const staged = records.get(mediaIds[0]!)!;
        const lineageId = staged.designOwnership?.lineageId;
        const node = project.canvas.nodes.find(
          (candidate) => candidate.kind === "artboard" && candidate.lineageId === lineageId,
        )!;
        if (!node.artifactMediaIds?.includes(staged.artifact.mediaId)) {
          project = {
            ...project,
            revision: project.revision + 1,
            canvas: {
              ...project.canvas,
              nodes: project.canvas.nodes.map((candidate) =>
                candidate === node
                  ? {
                      ...node,
                      artifactMediaIds: [...(node.artifactMediaIds ?? []), staged.artifact.mediaId],
                      activeMediaId: staged.artifact.mediaId,
                    }
                  : candidate,
              ),
            },
          };
        }
        failOnce("project-published");
        staged.designPublication = "published";
      },
    },
    async openJournal() {
      if (options.journalError) throw options.journalError;
      return {
        async getBranch() {
          return options.entries ?? [];
        },
      };
    },
    now: () => 50,
  };
  return {
    callId,
    mediaId,
    records,
    dependencies,
    getProject: () => project,
    getMessageCount: () => messageCount,
    addValidLegacyActiveRevision() {
      const activeMediaId = "design:legacy-active";
      project.canvas.nodes[0]!.artifactMediaIds = [mediaId, activeMediaId];
      project.canvas.nodes[0]!.activeMediaId = activeMediaId;
      records.set(activeMediaId, {
        chatId: project.chatId,
        generationId: "direct-edit:legacy-active",
        artifact: artifact(activeMediaId, VALID_HTML),
        html: VALID_HTML,
        committed: true,
        createdAt: 50,
      });
      return activeMediaId;
    },
    addBrokenArtboard(input: { lineageId: string; mediaId: string; generationId: string }) {
      project = {
        ...project,
        revision: project.revision + 1,
        canvas: {
          ...project.canvas,
          nodes: [
            ...project.canvas.nodes,
            {
              id: `node:${input.lineageId}`,
              kind: "artboard",
              canonicalOrigin: "generated-artifact",
              lineageId: input.lineageId,
              artifactMediaIds: [input.mediaId],
              activeMediaId: input.mediaId,
              x: 800,
              y: 0,
            },
          ],
        },
      };
      records.set(input.mediaId, {
        chatId: project.chatId,
        generationId: input.generationId,
        artifact: artifact(input.mediaId, OMITTED_DESIGN_HTML_SENTINEL),
        html: OMITTED_DESIGN_HTML_SENTINEL,
        committed: true,
        createdAt: 50,
      });
    },
  };
}

test("omitted HTML is recoverable only from a valid tool call in its exact journal turn", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL });
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [
        userEntry(0, "Create it"),
        assistantEntry(1, [toolCall(setup.callId, VALID_HTML)]),
        toolResultEntry(2, setup.callId),
        assistantEntry(3, [toolCall("call-replacement", OMITTED_DESIGN_HTML_SENTINEL)]),
        toolResultEntry(4, "call-replacement"),
      ];
    },
  });
  const service = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await service.inspect("project:recovery");
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.reason, "omitted-html");
  const result = await service.recover("project:recovery", plan.expectedRevision);
  assert.equal(result.status, "recovered");
  assert.equal(setup.getMessageCount(), 1);
  const node = setup.getProject().canvas.nodes[0]!;
  assert.equal(node.artifactMediaIds?.[0], setup.mediaId, "damaged history remains immutable");
  assert.notEqual(node.activeMediaId, setup.mediaId);
  assert.equal(setup.records.get(node.activeMediaId!)?.html, VALID_HTML);
});

test("valid journal bytes repair metadata-only corruption but do not replace a valid row", async () => {
  const setup = harness({ html: VALID_HTML });
  const source = setup.records.get(setup.mediaId)!;
  source.artifact.id = "0".repeat(64);
  const entries = [
    assistantEntry(0, [toolCall(setup.callId, VALID_HTML)]),
    toolResultEntry(1, setup.callId),
  ];
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return entries;
    },
  });

  const service = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await service.inspect("project:recovery");
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.reason, "corrupt-artifact");
  const result = await service.recover("project:recovery", plan.expectedRevision);
  assert.equal(result.status, "recovered");
  const recovered = setup.records.get(setup.getProject().canvas.nodes[0]!.activeMediaId!)!;
  assert.equal(recovered.html, VALID_HTML);
  assert.equal(recovered.artifact.id, digest(VALID_HTML));

  const validSource = { ...source, artifact: artifact(setup.mediaId, VALID_HTML) };
  assert.equal(recoverableHtmlFromJournal(entries, validSource), undefined);
});

test("an exact eligible active revision finalizes a post-project publication idempotently", async () => {
  const setup = harness({ html: VALID_HTML });
  const source = setup.records.get(setup.mediaId)!;
  source.designPublication = "eligible";
  source.designOwnership = {
    version: 1,
    kind: "revision",
    projectId: setup.getProject().id,
    lineageId: "lineage:recovery",
    baseMediaId: "design:base",
  };
  const before = structuredClone(setup.getProject());
  const service = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await service.inspect("project:recovery");
  assert.equal(plan.status, "recoverable");
  assert.match(plan.message, /publication marker is incomplete/iu);
  const result = await service.recover("project:recovery", plan.expectedRevision);
  assert.equal(result.status, "recovered");
  assert.equal(source.designPublication, "published");
  assert.deepEqual(setup.getProject(), before, "the already-published project snapshot is unchanged");
  const retry = await service.recover("project:recovery", plan.expectedRevision);
  assert.equal(retry.status, "recovered");
  assert.deepEqual(setup.getProject(), before);
});

test("an unattached eligible revision is not published by project recovery", async () => {
  const setup = harness({ html: VALID_HTML });
  const pendingMediaId = "design:eligible-but-unattached";
  setup.records.set(pendingMediaId, {
    chatId: setup.getProject().chatId,
    generationId: "generation:unattached",
    artifact: artifact(pendingMediaId, VALID_HTML),
    html: VALID_HTML,
    committed: true,
    createdAt: 50,
    designPublication: "eligible",
    designOwnership: {
      version: 1,
      kind: "revision",
      projectId: setup.getProject().id,
      lineageId: "lineage:recovery",
      baseMediaId: setup.mediaId,
    },
  });
  await assert.rejects(
    new DesignArtifactRecoveryService(setup.dependencies).inspect("project:recovery"),
    /does not have a damaged/iu,
  );
  assert.equal(setup.records.get(pendingMediaId)?.designPublication, "eligible");
});

for (const metadataDamage of ["suppressed", "ownership-mismatch"] as const) {
  test(`byte-valid ${metadataDamage} content is removed without publishing it`, async () => {
    const setup = harness({ html: VALID_HTML });
    const source = setup.records.get(setup.mediaId)!;
    source.designPublication = metadataDamage === "suppressed" ? "suppressed" : "published";
    source.designOwnership = {
      version: 1,
      kind: "revision",
      projectId:
        metadataDamage === "ownership-mismatch" ? "project:other" : setup.getProject().id,
      lineageId: "lineage:recovery",
      baseMediaId: "design:base",
    };
    const service = new DesignArtifactRecoveryService(setup.dependencies);
    const plan = await service.inspect("project:recovery");
    assert.equal(plan.operation, "remove-missing-artboard");
    const result = await service.recover("project:recovery", plan.expectedRevision);
    assert.equal(result.status, "regenerate");
    assert.equal(setup.getProject().canvas.nodes.length, 0);
    assert.equal(
      source.designPublication,
      metadataDamage === "suppressed" ? "suppressed" : "published",
      "recovery never changes the untrusted source publication state",
    );
  });
}

test("a successful later same-title call never authorizes revision recovery", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL });
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [
        userEntry(0, "Create it"),
        assistantEntry(1, [toolCall(setup.callId, OMITTED_DESIGN_HTML_SENTINEL)]),
        toolResultEntry(2, setup.callId, true),
        userEntry(3, "Try again"),
        assistantEntry(4, [toolCall("unrelated", VALID_HTML)]),
        toolResultEntry(5, "unrelated"),
      ];
    },
  });
  const plan = await new DesignArtifactRecoveryService(setup.dependencies).inspect(
    "project:recovery",
  );
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.reason, "no-valid-journal-revision");
  assert.equal(plan.operation, "remove-missing-artboard");
});

test("a media-owning call without its tool result permits only broken-artboard removal", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL });
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [userEntry(0, "Create it"), assistantEntry(1, [toolCall(setup.callId, VALID_HTML)])];
    },
  });
  const plan = await new DesignArtifactRecoveryService(setup.dependencies).inspect(
    "project:recovery",
  );
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.operation, "remove-missing-artboard");
});

test("a rejected media-owning call permits only broken-artboard removal", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL });
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [
        userEntry(0, "Create it"),
        assistantEntry(1, [toolCall(setup.callId, VALID_HTML)]),
        toolResultEntry(2, setup.callId, true),
      ];
    },
  });
  const plan = await new DesignArtifactRecoveryService(setup.dependencies).inspect(
    "project:recovery",
  );
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.operation, "remove-missing-artboard");
});

test("missing artifact bytes with no valid prior revision are explicitly removed before regeneration", async () => {
  let opened = false;
  const setup = harness({});
  setup.dependencies.openJournal = async () => {
    opened = true;
    return {
      async getBranch() {
        return [];
      },
    };
  };
  const plan = await new DesignArtifactRecoveryService(setup.dependencies).inspect(
    "project:recovery",
  );
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.reason, "missing-artifact");
  assert.equal(plan.operation, "remove-missing-artboard");
  assert.equal(opened, false);
  const result = await new DesignArtifactRecoveryService(setup.dependencies).recover(
    "project:recovery",
    plan.expectedRevision,
  );
  assert.equal(result.status, "regenerate");
  assert.equal(
    result.status === "regenerate" ? result.plan.operation : undefined,
    "open-to-regenerate",
  );
  assert.match(result.status === "regenerate" ? result.plan.message : "", /was removed/iu);
  assert.deepEqual(result.status === "regenerate" ? result.project : undefined, setup.getProject());
  assert.equal(setup.getProject().canvas.nodes.length, 0);
  assert.deepEqual(
    await inspectDesignProjectHealth(setup.getProject(), {
      artifactSource: async (_chatId, mediaId) => setup.records.get(mediaId),
      hasReferenceAsset: async () => true,
    }),
    { health: "ready" },
  );
});

for (const repairKind of ["artboard", "history"] as const) {
  test(`${repairKind} removal preserves an exact artifact whose commit is still pending`, async () => {
    const setup = harness({});
    if (repairKind === "history") setup.addValidLegacyActiveRevision();
    setup.records.set(setup.mediaId, {
      chatId: setup.getProject().chatId,
      generationId: "reconciling-generation",
      artifact: artifact(setup.mediaId, VALID_HTML),
      html: VALID_HTML,
      committed: false,
      createdAt: 50,
    });
    const service = new DesignArtifactRecoveryService(setup.dependencies);
    const plan = await service.inspect("project:recovery");
    assert.equal(
      plan.operation,
      repairKind === "history" ? "remove-missing-history" : "remove-missing-artboard",
    );
    const result = await service.recover("project:recovery", plan.expectedRevision);
    assert.equal(result.status, "conflict");
    assert.equal(
      setup.getProject().canvas.nodes[0]?.artifactMediaIds?.includes(setup.mediaId),
      true,
      "the pending revision remains in its exact lineage",
    );
  });
}

test("a missing active artifact recovers from the nearest valid prior lineage revision", async () => {
  const setup = harness({ priorHtml: VALID_HTML });
  const service = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await service.inspect("project:recovery");
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.operation, "recover-revision");
  const result = await service.recover("project:recovery", plan.expectedRevision);
  assert.equal(result.status, "recovered");
  const node = setup.getProject().canvas.nodes[0]!;
  assert.deepEqual(node.artifactMediaIds?.slice(0, 2), ["design:prior-valid", setup.mediaId]);
  assert.equal(setup.records.get(node.activeMediaId!)?.html, VALID_HTML);
  assert.equal(setup.records.get(node.activeMediaId!)?.artifact.revisionOfMediaId, setup.mediaId);
  assert.deepEqual(
    await inspectDesignProjectHealth(setup.getProject(), {
      artifactSource: async (_chatId, mediaId) => setup.records.get(mediaId),
      hasReferenceAsset: async () => true,
    }),
    { health: "ready" },
  );
});

test("a corrupt active artifact falls back to valid published lineage history", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL, priorHtml: VALID_HTML });
  const service = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await service.inspect("project:recovery");
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.operation, "recover-revision");
  const result = await service.recover("project:recovery", plan.expectedRevision);
  assert.equal(result.status, "recovered");
  const node = setup.getProject().canvas.nodes[0]!;
  assert.deepEqual(node.artifactMediaIds?.slice(0, 2), ["design:prior-valid", setup.mediaId]);
  assert.equal(setup.records.get(node.activeMediaId!)?.html, VALID_HTML);
  assert.equal(setup.records.has(setup.mediaId), true, "recoverable history remains immutable");
});

test("a real legacy lineage prunes a missing historical ID while preserving its valid unlinked active revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-legacy-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = new DesignProjectStore({
    root: () => root,
    now: () => 10,
    mintProjectId: () => "project:legacy-recovery",
  });
  const artifacts = new GenerativeUiArtifactStore({ root: () => root, now: () => 11 });
  await projects.initialize();
  await artifacts.initialize();
  const missingMediaId = "design:legacy-missing";
  const activeMediaId = "design:legacy-active";
  const project = await projects.create({
    chatId: "chat:legacy-recovery",
    title: "Legacy recovery",
    connectionState: "prototype-only",
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:legacy-recovery",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          lineageId: "lineage:legacy-recovery",
          artifactMediaIds: [missingMediaId, activeMediaId],
          activeMediaId,
          x: 0,
          y: 0,
        },
      ],
    },
  });
  const active = artifact(activeMediaId, VALID_HTML);
  assert.equal(active.revisionOfMediaId, undefined, "legacy direct edits had no parent link");
  await artifacts.stage({
    chatId: project.chatId,
    generationId: "direct-edit:legacy",
    artifact: active,
    html: VALID_HTML,
  });
  await artifacts.commit(project.chatId, [activeMediaId]);
  const revisions = new DesignGeneratedRevisionService({ projects, artifacts });
  const service = new DesignArtifactRecoveryService({
    projects,
    artifacts,
    messages: {
      async ensureArtifactMessage() {
        assert.fail("historical membership repair must not create a replacement artifact message");
      },
    },
    revisions,
    async openJournal() {
      assert.fail("historical membership repair must not inspect the Pi journal");
    },
  });
  const plan = await service.inspect(project.id);
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.operation, "remove-missing-history");
  assert.match(plan.message, /older local history entry/iu);
  const result = await service.recover(project.id, plan.expectedRevision);
  assert.equal(result.status, "recovered");
  assert.equal(
    result.status === "recovered" ? result.operation : undefined,
    "remove-missing-history",
  );
  const repaired = result.status === "recovered" ? result.project : undefined;
  assert.deepEqual(repaired?.canvas.nodes[0]?.artifactMediaIds, [activeMediaId]);
  assert.equal(repaired?.canvas.nodes[0]?.activeMediaId, activeMediaId);
  assert.equal((await artifacts.designPublicationRecords(["published"])).length, 0);
  assert.deepEqual(
    await inspectDesignProjectHealth(repaired!, {
      artifactSource: (chatId, mediaId) => artifacts.committedRecoverySourceFor(chatId, mediaId),
      hasReferenceAsset: async () => true,
    }),
    { health: "ready" },
  );
});

test("a sole corrupt active artifact is removed so the next generation has no poisoned context", async () => {
  const setup = harness({ html: "<script src='https://example.com/bad.js'></script>" });
  const service = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await service.inspect("project:recovery");
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.reason, "no-valid-journal-revision");
  assert.equal(plan.operation, "remove-missing-artboard");
  const result = await service.recover("project:recovery", plan.expectedRevision);
  assert.equal(result.status, "regenerate");
  const repaired = result.status === "regenerate" ? result.project : undefined;
  assert.ok(repaired);
  assert.equal(repaired.canvas.nodes.length, 0);
  assert.equal(
    latestActiveDesignArtifact(
      { messages: [{ role: "assistant", htmlArtifacts: [artifact(setup.mediaId, VALID_HTML)] }] },
      repaired,
    ),
    undefined,
    "the next Design generation cannot select the removed corrupt revision as auto-context",
  );
  assert.deepEqual(
    await inspectDesignProjectHealth(repaired, {
      artifactSource: async (_chatId, mediaId) => setup.records.get(mediaId),
      hasReferenceAsset: async () => true,
    }),
    { health: "ready" },
  );
});

test("journal failures remain private and offer a bounded explicit removal repair", async () => {
  const setup = harness({
    html: OMITTED_DESIGN_HTML_SENTINEL,
    journalError: new Error("/private/path/pi-session.jsonl could not be opened"),
  });
  const plan = await new DesignArtifactRecoveryService(setup.dependencies).inspect(
    "project:recovery",
  );
  assert.equal(plan.status, "recoverable");
  assert.equal(plan.reason, "journal-unavailable");
  assert.equal(plan.operation, "remove-missing-artboard");
  assert.doesNotMatch(JSON.stringify(plan), /\/private\/path|jsonl/iu);
});

test("a recovered immutable descendant remains healthy after service restart", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL });
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [
        userEntry(0, "Create it"),
        assistantEntry(1, [toolCall(setup.callId, VALID_HTML)]),
        toolResultEntry(2, setup.callId),
      ];
    },
  });
  const first = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await first.inspect("project:recovery");
  assert.equal(
    (await first.recover("project:recovery", plan.expectedRevision)).status,
    "recovered",
  );
  const restarted = new DesignArtifactRecoveryService(setup.dependencies);
  await assert.rejects(restarted.inspect("project:recovery"), /does not have a damaged/iu);
});

test("generation reconciliation preserves a quota-pruned exact recovery candidate", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL, failOnceAt: "candidate" });
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [
        assistantEntry(0, [toolCall(setup.callId, VALID_HTML)]),
        toolResultEntry(1, setup.callId),
      ];
    },
  });
  const stageRecoveryReplacement = setup.dependencies.artifacts.stageRecoveryReplacement;
  setup.dependencies.artifacts.stageRecoveryReplacement = async (input) => {
    const result = await stageRecoveryReplacement(input);
    setup.records.delete(input.damagedMediaId);
    return result;
  };
  const first = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await first.inspect("project:recovery");
  await assert.rejects(first.recover("project:recovery", plan.expectedRevision), /failpoint/iu);
  assert.equal(setup.records.has(setup.mediaId), false);

  const generationReconciliation = new DesignGeneratedRevisionService({
    artifacts: setup.dependencies.artifacts,
    projects: {
      async publishGeneratedRevisions() {
        assert.fail("a recovery candidate must not be published by generation reconciliation");
      },
    },
  });
  await generationReconciliation.reconcileAtStartup([]);
  await generationReconciliation.reconcilePersistedChat({
    id: setup.getProject().chatId,
    messages: [],
  });
  assert.equal(
    [...setup.records.values()].find(({ generationId }) =>
      generationId.startsWith("journal-recovery:"),
    )?.designPublication,
    "candidate",
  );

  const restarted = new DesignArtifactRecoveryService(setup.dependencies);
  const retryPlan = await restarted.inspect("project:recovery");
  assert.equal(retryPlan.status, "recoverable");
  const result = await restarted.recover("project:recovery", retryPlan.expectedRevision);
  assert.equal(result.status, "recovered");
  assert.equal(setup.records.get(setup.getProject().canvas.nodes[0]!.activeMediaId!)?.html, VALID_HTML);
});

test("a completed recovery for artboard A never shadows a later recovery for broken artboard B", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL });
  const generationB = "generation:b";
  const callB = "call-b";
  const mediaB = `design:${digest(`${generationB}:html\0${callB}`)}`;
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [
        assistantEntry(0, [toolCall(setup.callId, VALID_HTML)]),
        toolResultEntry(1, setup.callId),
        assistantEntry(2, [toolCall(callB, VALID_HTML.replace("valid", "valid B"))]),
        toolResultEntry(3, callB),
      ];
    },
  });
  const service = new DesignArtifactRecoveryService(setup.dependencies);
  const planA = await service.inspect("project:recovery");
  const resultA = await service.recover("project:recovery", planA.expectedRevision);
  assert.equal(resultA.status, "recovered");
  assert.equal(resultA.status === "recovered" ? resultA.operation : undefined, "recover-revision");
  const afterA = setup.getProject();
  const activeA = afterA.canvas.nodes.find(
    ({ lineageId }) => lineageId === "lineage:recovery",
  )?.activeMediaId;
  assert.notEqual(activeA, setup.mediaId);
  setup.addBrokenArtboard({ lineageId: "lineage:b", mediaId: mediaB, generationId: generationB });

  const planB = await service.inspect("project:recovery");
  const resultB = await service.recover("project:recovery", planB.expectedRevision);
  assert.equal(resultB.status, "recovered");
  const afterB = setup.getProject();
  assert.equal(
    afterB.canvas.nodes.find(({ lineageId }) => lineageId === "lineage:recovery")?.activeMediaId,
    activeA,
  );
  assert.notEqual(
    afterB.canvas.nodes.find(({ lineageId }) => lineageId === "lineage:b")?.activeMediaId,
    mediaB,
  );
  assert.equal(setup.getMessageCount(), 2);
});

for (const failOnceAt of ["eligible", "committed", "project-published"] as const) {
  test(`recovery resumes idempotently after the ${failOnceAt} durability boundary`, async () => {
    const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL, failOnceAt });
    setup.dependencies.openJournal = async () => ({
      async getBranch() {
        return [
          userEntry(0, "Create it"),
          assistantEntry(1, [toolCall(setup.callId, VALID_HTML)]),
          toolResultEntry(2, setup.callId),
        ];
      },
    });
    const first = new DesignArtifactRecoveryService(setup.dependencies);
    const plan = await first.inspect("project:recovery");
    await assert.rejects(first.recover("project:recovery", plan.expectedRevision), /failpoint/iu);
    const restarted = new DesignArtifactRecoveryService(setup.dependencies);
    const result = await restarted.recover("project:recovery", plan.expectedRevision);
    assert.equal(result.status, "recovered");
    const node = setup.getProject().canvas.nodes[0]!;
    assert.equal(node.artifactMediaIds?.length, 2);
    assert.equal(setup.records.get(node.activeMediaId!)?.designPublication, "published");
  });
}

test("a suppressed recovery candidate is never republished", async () => {
  const setup = harness({ html: OMITTED_DESIGN_HTML_SENTINEL, failOnceAt: "eligible" });
  setup.dependencies.openJournal = async () => ({
    async getBranch() {
      return [
        userEntry(0, "Create it"),
        assistantEntry(1, [toolCall(setup.callId, VALID_HTML)]),
        toolResultEntry(2, setup.callId),
      ];
    },
  });
  const first = new DesignArtifactRecoveryService(setup.dependencies);
  const plan = await first.inspect("project:recovery");
  await assert.rejects(first.recover("project:recovery", plan.expectedRevision), /failpoint/iu);
  const partial = [...setup.records.values()].find(({ designPublication }) =>
    Boolean(designPublication),
  )!;
  partial.designPublication = "suppressed";
  const restarted = new DesignArtifactRecoveryService(setup.dependencies);
  const retryPlan = await restarted.inspect("project:recovery");
  assert.equal(retryPlan.operation, "remove-missing-artboard");
  const result = await restarted.recover("project:recovery", retryPlan.expectedRevision);
  assert.equal(result.status, "regenerate");
  assert.equal(partial.designPublication, "suppressed");
});
