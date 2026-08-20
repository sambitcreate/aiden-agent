import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { AuthResult } from "@earendil-works/pi-ai";
import { createWorkflowCoordinatorPlan } from "./scheduler-core.js";
import {
  projectCreateImagesRun,
  type CreateImagesRunEventV1,
  type CreateImagesRunJournalV1,
} from "../../../renderer/shared/create-images/run-contract.js";
import type { WorkflowDocumentV1 } from "../../../renderer/shared/create-images/schema.js";
import type {
  AssetIngestRequest,
  AssetIngestResult,
  AssetMetadataDto,
  ContentAddressedAssetStore,
} from "./asset-store-core.js";
import {
  DeterministicMockImageProvider,
  type MockImageProviderScript,
} from "./mock-image-provider-core.js";
import {
  CreateImagesRunJournalStore,
  type CreateImagesRunJournalDurability,
} from "./run-journal-store.js";
import {
  CreateImagesRunService,
  CREATE_IMAGES_MAX_ACTIVE_RUNS,
  evaluateCreateImagesWorkflowDeletion,
  type CreateImagesRunReferenceAuthority,
  type CreateImagesRunReferenceReservation,
} from "./run-service.js";
import { WorkflowManifestStore } from "./workflow-manifest-store.js";
import { GeminiImageProvider } from "./providers/gemini-image-provider-core.js";
import type { CreateImagesWorkspaceState } from "./workspace-store.js";

const NOW = "2026-08-11T12:00:00.000Z";
const DURABLE_ASSET_ID = "a".repeat(64);

test("workflow deletion requires an authoritative empty run lifecycle", () => {
  const unavailableMessage = (
    decision: ReturnType<typeof evaluateCreateImagesWorkflowDeletion>,
  ): string => {
    assert.equal(decision.status, "unavailable");
    return decision.status === "unavailable" ? decision.message : "";
  };
  const empty = {
    status: "ready" as const,
    authoritative: true as const,
    history: [],
    recoveries: [],
  };
  assert.deepEqual(evaluateCreateImagesWorkflowDeletion(empty), { status: "allowed" });
  assert.deepEqual(evaluateCreateImagesWorkflowDeletion({ status: "not-found" }), {
    status: "not-found",
  });
  assert.match(
    unavailableMessage(
      evaluateCreateImagesWorkflowDeletion({ status: "unavailable", message: "busy" }),
    ),
    /could not be verified safely/u,
  );
  assert.match(
    unavailableMessage(
      evaluateCreateImagesWorkflowDeletion({
        ...empty,
        activeRun: {} as never,
      }),
    ),
    /Stop the active image run/u,
  );
  assert.match(
    unavailableMessage(
      evaluateCreateImagesWorkflowDeletion({
        ...empty,
        latestTerminalRun: {} as never,
      }),
    ),
    /retained run history/u,
  );
  assert.match(
    unavailableMessage(
      evaluateCreateImagesWorkflowDeletion({
        ...empty,
        history: [{} as never],
      }),
    ),
    /retained run history/u,
  );
  assert.match(
    unavailableMessage(
      evaluateCreateImagesWorkflowDeletion({
        ...empty,
        recoveries: [
          {
            status: "unsafe",
            workflowId: "workflow-1",
            runId: "run-1",
            reason: "unsafe-storage",
          },
        ],
      }),
    ),
    /retained run recovery records/u,
  );
});

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-run-service-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

function workflow(outputCount: 1 | 2 | 3 | 4 = 1): WorkflowDocumentV1 {
  return {
    schemaVersion: 1,
    id: "workflow-1",
    title: "Run service",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        id: "prompt-1",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { text: "A tiny durable image" },
      },
      {
        id: "generate-1",
        type: "generate-image",
        position: { x: 100, y: 0 },
        data: {
          providerId: "gemini",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
          imageSize: "1K",
          outputMime: "image/png",
          count: outputCount,
        },
      },
      { id: "output-1", type: "output", position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      {
        id: "edge-prompt",
        source: "prompt-1",
        sourcePort: "text",
        target: "generate-1",
        targetPort: "prompt",
      },
      {
        id: "edge-output",
        source: "generate-1",
        sourcePort: "images",
        target: "output-1",
        targetPort: "images",
      },
    ],
    assetRefs: [],
    settings: { concurrency: 1 },
  };
}

class FakeAssets {
  readonly available = new Map<string, AssetMetadataDto>();
  readonly bytesById = new Map<string, Uint8Array>();
  readonly publicationOrder: string[] = [];
  readonly runReferences = new Map<string, string[]>();
  failIngest = false;
  ingestGate?: Promise<void>;
  ingestStarted = false;

  async ingest(
    source: AsyncIterable<Uint8Array>,
    request: AssetIngestRequest,
  ): Promise<AssetIngestResult> {
    if (this.failIngest) throw new Error("simulated durable asset publication failure");
    this.ingestStarted = true;
    await this.ingestGate;
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for await (const chunk of source) {
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const assetId = createHash("sha256").update(bytes).digest("hex");
    const asset: AssetMetadataDto = {
      assetId,
      mediaType: "image/png",
      byteLength,
      width: Number(request.generationMetadata?.width ?? 1),
      height: Number(request.generationMetadata?.height ?? 1),
      createdAt: NOW,
      origin: request.origin,
      ...(request.generationMetadata
        ? { generationMetadata: structuredClone(request.generationMetadata) }
        : {}),
      referenceCount: 0,
      thumbnailSizes: [],
    };
    this.available.set(assetId, asset);
    this.bytesById.set(assetId, bytes);
    this.publicationOrder.push(assetId);
    return {
      asset,
      deduplicated: false,
      quotaWarning: false,
      totalAssetBytes: [...this.available.values()].reduce(
        (total, candidate) => total + candidate.byteLength,
        0,
      ),
    };
  }

  async getAvailable(assetId: string): Promise<AssetMetadataDto | undefined> {
    return this.available.get(assetId);
  }

  async acquirePreviewLease(assetId: string, ownerId: string) {
    if (!this.available.has(assetId)) throw new Error("asset unavailable");
    return { token: `${ownerId}-${assetId.slice(0, 16)}`, assetId, expiresAt: Date.now() + 60_000 };
  }

  async readPreview(token: string) {
    const assetId = [...this.available.keys()].find((candidate) =>
      token.endsWith(candidate.slice(0, 16)),
    );
    const asset = assetId ? this.available.get(assetId) : undefined;
    const bytes = assetId ? this.bytesById.get(assetId) : undefined;
    if (!asset || !bytes) throw new Error("preview unavailable");
    return { asset, bytes: bytes.slice() };
  }

  async releasePreviewLease(): Promise<boolean> {
    return true;
  }

  async list(): Promise<AssetMetadataDto[]> {
    return [...this.available.values()];
  }

  async replaceReferences(
    owner: { kind: "workflow" | "run"; id: string },
    assetIds: readonly string[],
  ): Promise<void> {
    if (owner.kind === "run") this.runReferences.set(owner.id, [...assetIds]);
  }
}

class FakeReferences implements CreateImagesRunReferenceAuthority {
  readonly reservations: CreateImagesRunReferenceReservation[] = [];
  readonly committed = new Map<string, Set<string>>();
  readonly order: string[] = [];
  reconcileCount = 0;
  onReserve?: (reservation: CreateImagesRunReferenceReservation) => void | Promise<void>;

  async reserveRun(
    runId: string,
    assetIds: readonly string[],
  ): Promise<CreateImagesRunReferenceReservation> {
    const reservation = { runId, next: new Set(assetIds), active: true };
    this.reservations.push(reservation);
    this.order.push(`reserve:${runId}`);
    await this.onReserve?.(reservation);
    return reservation;
  }

  async commitRun(reservation: CreateImagesRunReferenceReservation): Promise<void> {
    reservation.active = false;
    this.committed.set(reservation.runId, new Set(reservation.next));
    this.order.push(`commit:${reservation.runId}`);
  }

  async releaseRunReservations(runId: string): Promise<void> {
    for (const reservation of this.reservations) {
      if (reservation.runId === runId) reservation.active = false;
    }
    this.order.push(`release:${runId}`);
  }

  async reconcileRuns(store: CreateImagesRunJournalStore): Promise<boolean> {
    this.reconcileCount += 1;
    const inventory = await store.referenceInventory();
    this.committed.clear();
    for (const record of inventory.records) {
      this.committed.set(record.runId, new Set(record.assetIds));
    }
    for (const reservation of this.reservations) reservation.active = false;
    return inventory.complete;
  }

  isRunAssetReferenced(runId: string, assetId: string): boolean {
    return (
      (this.committed.get(runId)?.has(assetId) ?? false) ||
      this.reservations.some(
        (reservation) =>
          reservation.active && reservation.runId === runId && reservation.next.has(assetId),
      )
    );
  }
}

interface Harness {
  root: string;
  workflows: WorkflowManifestStore;
  assets: FakeAssets;
  references: FakeReferences;
  journals: CreateImagesRunJournalStore;
  service: CreateImagesRunService;
}

async function harness(
  t: TestContext,
  options: {
    document?: WorkflowDocumentV1;
    script?: MockImageProviderScript;
    createRunId?: () => string;
    onScript?: () => void;
    now?: () => number;
    shutdownTimeoutMs?: number;
    journalDurability?: CreateImagesRunJournalDurability;
    resolveGeminiAuth?: () => Promise<AuthResult>;
    createGeminiProvider?: () => GeminiImageProvider;
    workspaceStatus?: () => Promise<{ configured: boolean; state: CreateImagesWorkspaceState }>;
    workspaceRequired?: boolean;
  } = {},
): Promise<Harness> {
  const root = await temporaryRoot(t);
  const workflows = new WorkflowManifestStore(() => root);
  await workflows.create(options.document ?? workflow());
  const assets = new FakeAssets();
  const references = new FakeReferences();
  const journals = new CreateImagesRunJournalStore(() => root, options.journalDurability);
  let now = Date.parse(NOW);
  const service = new CreateImagesRunService({
    rootResolver: () => root,
    workflows,
    assets: assets as unknown as ContentAddressedAssetStore,
    references,
    journalStore: journals,
    resolveGeminiAuth: options.resolveGeminiAuth,
    createGeminiProvider: options.createGeminiProvider,
    workspaceStatus: options.workspaceStatus,
    workspaceRequired: options.workspaceRequired,
    now: options.now ?? (() => now++),
    createRunId: options.createRunId ?? (() => "run-1"),
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    mockScript: (nodeIds) => {
      options.onScript?.();
      return (
        options.script ?? {
          nodes: Object.fromEntries(
            nodeIds.map((nodeId) => [
              nodeId,
              [
                {
                  outcome: "success" as const,
                  delayMs: 0,
                  width: 8,
                  height: 8,
                  seed: 7,
                },
              ],
            ]),
          ),
        }
      );
    },
  });
  return { root, workflows, assets, references, journals, service };
}

test("does not start provider work when a configured workspace fails the fast preflight", async (t) => {
  let providerStarted = false;
  const context = await harness(t, {
    workspaceStatus: async () => ({ configured: true, state: "drifted" }),
    onScript: () => {
      providerStarted = true;
    },
  });
  const result = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /workspace is not ready/u);
  assert.equal(providerStarted, false);
});

test("does not start provider work before the required first-open workspace is configured", async (t) => {
  let providerStarted = false;
  const context = await harness(t, {
    workspaceRequired: true,
    workspaceStatus: async () => ({ configured: false, state: "ready" }),
    onScript: () => {
      providerStarted = true;
    },
  });
  const result = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /workspace is not ready/u);
  assert.equal(providerStarted, false);
  assert.equal(await context.journals.get("run-1"), undefined);
});

async function waitForJournal(
  store: CreateImagesRunJournalStore,
  runId: string,
  predicate: (journal: CreateImagesRunJournalV1) => boolean,
): Promise<CreateImagesRunJournalV1> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const journal = await store.get(runId);
    if (journal && predicate(journal)) return journal;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${runId}.`);
}

async function waitForTerminal(
  store: CreateImagesRunJournalStore,
  runId: string,
): Promise<CreateImagesRunJournalV1> {
  return waitForJournal(
    store,
    runId,
    (journal) => projectCreateImagesRun(journal).terminal !== undefined,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for run-service state.");
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for async run-service state.");
}

async function seedRestartRun(
  store: CreateImagesRunJournalStore,
  input: {
    runId: string;
    providerJobId?: string;
    durableOutputAssetIds?: string[];
  },
): Promise<CreateImagesRunJournalV1> {
  const plan = createWorkflowCoordinatorPlan(workflow(), { kind: "all" });
  let journal = await store.start(
    {
      runId: input.runId,
      workflowSnapshot: plan.snapshot,
      plan: {
        scope: { kind: "all" },
        orderedNodeIds: [...plan.orderedNodeIds],
        dependencies: Object.fromEntries(
          Object.entries(plan.dependencies).map(([nodeId, values]) => [nodeId, [...values]]),
        ),
      },
      createdAt: NOW,
    },
    () => true,
  );
  const append = async (event: CreateImagesRunEventV1): Promise<void> => {
    journal = await store.append(journal.runId, journal.journalRevision, event);
  };
  const base = () => ({
    workflowId: journal.workflowId,
    workflowRevision: journal.workflowRevision,
    runId: journal.runId,
    sequence: journal.events.length + 1,
    at: NOW,
  });
  await append({ ...base(), type: "run-started" });
  await append({ ...base(), type: "node-started", nodeId: "prompt-1" });
  await append({
    ...base(),
    type: "node-output-published",
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  await append({
    ...base(),
    type: "node-succeeded",
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  await append({ ...base(), type: "node-started", nodeId: "generate-1" });
  await append({
    ...base(),
    type: "node-submission-prepared",
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-restart-node-0001",
    providerId: "local-mock",
    modelId: "deterministic-v1",
  });
  if (input.providerJobId) {
    await append({
      ...base(),
      type: "node-submission-accepted",
      nodeId: "generate-1",
      attempt: 1,
      providerJobId: input.providerJobId,
    });
  }
  if (input.durableOutputAssetIds) {
    await append({
      ...base(),
      type: "node-output-published",
      nodeId: "generate-1",
      outputAssetIds: [...input.durableOutputAssetIds],
    });
  }
  return journal;
}

test("successful runs publish assets before journal success and commit durable references", async (t) => {
  const context = await harness(t);
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const journal = await waitForTerminal(context.journals, started.run.runId);
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.status, "succeeded");
  const generated = projection.nodes["generate-1"];
  assert.equal(generated?.outputAssetIds.length, 1);
  const assetId = generated?.outputAssetIds[0];
  assert.ok(assetId);
  assert.equal(context.assets.available.has(assetId), true);
  assert.equal(context.references.isRunAssetReferenced(journal.runId, assetId), true);
  assert.deepEqual(context.assets.runReferences.get(journal.runId), [assetId]);
  const acceptedIndex = journal.events.findIndex(
    (event) => event.type === "node-submission-accepted",
  );
  const publishedIndex = journal.events.findIndex(
    (event) => event.type === "node-output-published" && event.nodeId === "generate-1",
  );
  const succeededIndex = journal.events.findIndex(
    (event) => event.type === "node-succeeded" && event.nodeId === "generate-1",
  );
  assert.ok(
    acceptedIndex >= 0 && publishedIndex > acceptedIndex && succeededIndex > publishedIndex,
  );
  assert.ok(context.references.reconcileCount >= 2);
});

test("stop durably journals cancellation before terminal node cancellation", async (t) => {
  const context = await harness(t, {
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "success",
            delayMs: 60_000,
            width: 8,
            height: 8,
            seed: 4,
            lateCompletionAfterCancel: true,
          },
        ],
      },
    },
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForJournal(context.journals, started.run.runId, (journal) =>
    journal.events.some((event) => event.type === "node-submission-accepted"),
  );
  const stopping = await context.service.stop("workflow-1", started.run.runId, "user");
  assert.equal(stopping.status, "stopping");
  const journal = await waitForTerminal(context.journals, started.run.runId);
  assert.equal(projectCreateImagesRun(journal).status, "cancelled");
  const cancellationIndex = journal.events.findIndex(
    (event) => event.type === "run-cancel-requested",
  );
  const cancelledNodeIndex = journal.events.findIndex((event) => event.type === "node-cancelled");
  assert.ok(cancellationIndex >= 0 && cancelledNodeIndex > cancellationIndex);
  assert.equal(
    journal.events.some(
      (event) => event.type === "node-output-published" && event.nodeId === "generate-1",
    ),
    false,
  );
});

test("app-quit cancellation remains journal-monotonic when the wall clock rolls backward", async (t) => {
  let now = Date.parse(NOW) + 120_000;
  const context = await harness(t, {
    now: () => now,
    script: {
      nodes: {
        "generate-1": [{ outcome: "success", delayMs: 60_000, width: 8, height: 8 }],
      },
    },
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const beforeRollback = await waitForJournal(context.journals, started.run.runId, (journal) =>
    journal.events.some((event) => event.type === "node-submission-accepted"),
  );
  now = Date.parse(NOW) - 120_000;
  await context.service.stopAll("app-quit");
  const terminal = await waitForTerminal(context.journals, started.run.runId);
  assert.ok(Date.parse(terminal.updatedAt) >= Date.parse(beforeRollback.updatedAt));
  assert.equal(projectCreateImagesRun(terminal).cancellation?.reason, "app-quit");
  let previous = Date.parse(terminal.createdAt);
  for (const event of terminal.events) {
    assert.ok(Date.parse(event.at) >= previous);
    previous = Date.parse(event.at);
  }
});

test("ambiguous submissions become explicit needs-attention terminal history", async (t) => {
  const context = await harness(t, {
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "ambiguous-submit",
            delayMs: 0,
            durableRemoteJob: false,
            error: "connection lost after submission",
          },
        ],
      },
    },
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const journal = await waitForTerminal(context.journals, started.run.runId);
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.status, "needs_attention");
  assert.equal(projection.nodes["generate-1"]?.status, "ambiguous");
  assert.equal(projection.nodes["output-1"]?.status, "blocked");
  assert.equal(JSON.stringify(journal).includes("connection lost"), false);
  assert.equal((await context.service.list("workflow-1")).status, "ready");
});

test("a delayed durable cancellation cannot erase a prepared submission ambiguity", async (t) => {
  const context = await harness(t, {
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "ambiguous-submit",
            delayMs: 60_000,
            durableRemoteJob: false,
          },
        ],
      },
    },
  });
  let releaseCancellation: () => void = () => undefined;
  let markCancellationEntered: () => void = () => undefined;
  const cancellationGate = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const cancellationEntered = new Promise<void>((resolve) => {
    markCancellationEntered = resolve;
  });
  const requestCancellation = context.journals.requestCancellation.bind(context.journals);
  context.journals.requestCancellation = async (...args) => {
    markCancellationEntered();
    await cancellationGate;
    return requestCancellation(...args);
  };

  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForJournal(context.journals, started.run.runId, (journal) =>
    journal.events.some((event) => event.type === "node-submission-prepared"),
  );
  const stopping = context.service.stop("workflow-1", started.run.runId, "app-quit");
  await cancellationEntered;
  const beforeDurableCancel = await context.journals.get(started.run.runId);
  assert.equal(projectCreateImagesRun(beforeDurableCancel!).cancellation, undefined);
  releaseCancellation();
  assert.equal((await stopping).status, "stopping");

  const terminal = await waitForTerminal(context.journals, started.run.runId);
  const projection = projectCreateImagesRun(terminal);
  assert.equal(projection.cancellation?.reason, "app-quit");
  assert.equal(projection.status, "needs_attention");
  assert.equal(projection.nodes["generate-1"]?.status, "ambiguous");
  assert.equal(projection.nodes["output-1"]?.status, "blocked");
  assert.equal(
    terminal.events.some(
      (event) => event.type === "node-cancelled" && event.nodeId === "generate-1",
    ),
    false,
  );
});

test("unresolved ambiguity blocks admission until a CAS-bound audit acknowledgement", async (t) => {
  let runNumber = 0;
  const context = await harness(t, {
    createRunId: () => `ambiguity-${++runNumber}`,
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "ambiguous-submit",
            delayMs: 0,
            durableRemoteJob: false,
            error: "connection lost after submission",
          },
        ],
      },
    },
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const needsAttention = await waitForTerminal(context.journals, started.run.runId);
  await waitForAsync(async () => (await context.service.activeRuns()).length === 0);
  const blocked = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(blocked.status, "unavailable");
  assert.equal(runNumber, 1);

  assert.deepEqual(
    await context.service.resolveRunAmbiguity({
      workflowId: "workflow-1",
      runId: needsAttention.runId,
      expectedJournalRevision: needsAttention.journalRevision + 1,
      resolution: "acknowledge-unresolved-submission",
    }),
    {
      status: "conflict",
      expectedJournalRevision: needsAttention.journalRevision + 1,
      currentJournalRevision: needsAttention.journalRevision,
    },
  );
  const resolved = await context.service.resolveRunAmbiguity({
    workflowId: "workflow-1",
    runId: needsAttention.runId,
    expectedJournalRevision: needsAttention.journalRevision,
    resolution: "acknowledge-unresolved-submission",
  });
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") return;
  assert.equal(resolved.run.status, "needs_attention");
  assert.equal(resolved.run.ambiguityResolution?.kind, "acknowledged-unresolved-submission");
  assert.equal(
    resolved.authoritativeList.history[0]?.ambiguityResolution?.kind,
    "acknowledged-unresolved-submission",
  );
  const acknowledged = await context.journals.get(needsAttention.runId);
  assert.equal(
    acknowledged?.events.filter((candidate) => candidate.type === "run-ambiguity-acknowledged")
      .length,
    1,
  );
  const stale = await context.service.resolveRunAmbiguity({
    workflowId: "workflow-1",
    runId: needsAttention.runId,
    expectedJournalRevision: needsAttention.journalRevision,
    resolution: "acknowledge-unresolved-submission",
  });
  assert.equal(stale.status, "conflict");
  const already = await context.service.resolveRunAmbiguity({
    workflowId: "workflow-1",
    runId: needsAttention.runId,
    expectedJournalRevision: resolved.run.journalRevision,
    resolution: "acknowledge-unresolved-submission",
  });
  assert.equal(already.status, "already-resolved");

  let journalReads = 0;
  const originalGet = context.journals.get.bind(context.journals);
  context.journals.get = async (runId) => {
    journalReads += 1;
    return originalGet(runId);
  };
  const admitted = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  context.journals.get = originalGet;
  assert.equal(admitted.status, "started");
  assert.equal(journalReads, 0);
  if (admitted.status === "started") {
    await waitForTerminal(context.journals, admitted.run.runId);
    await waitForAsync(async () => (await context.service.activeRuns()).length === 0);
  }
});

test("a failed terminal index publication keeps direct run admission closed", async (t) => {
  let rejectIndex = false;
  let runNumber = 0;
  const context = await harness(t, {
    createRunId: () => `dirty-index-${++runNumber}`,
    journalDurability: {
      beforeIndexPublished: async () => {
        if (rejectIndex) throw new Error("simulated terminal index failure");
      },
    },
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "ambiguous-submit",
            delayMs: 25,
            durableRemoteJob: false,
            error: "connection lost after submission",
          },
        ],
      },
    },
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  rejectIndex = true;
  const terminal = await waitForTerminal(context.journals, started.run.runId);
  assert.equal(projectCreateImagesRun(terminal).status, "needs_attention");
  await waitForAsync(async () => (await context.service.activeRuns()).length === 0);
  const blockedWhileDirty = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(blockedWhileDirty.status, "unavailable");
  assert.equal(runNumber, 1);

  rejectIndex = false;
  const blockedAfterRebuild = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(blockedAfterRebuild.status, "unavailable");
  assert.equal(runNumber, 1);
});

test("same-process current and recovery corruption blocks a second workflow run", async (t) => {
  let runNumber = 0;
  const context = await harness(t, {
    createRunId: () => `authority-run-${++runNumber}`,
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForTerminal(context.journals, started.run.runId);
  await waitForAsync(async () => (await context.service.activeRuns()).length === 0);
  const directory = path.join(context.root, "runs", started.run.runId);
  await Promise.all([
    fs.writeFile(path.join(directory, "run.json"), "{broken-current", "utf8"),
    fs.writeFile(path.join(directory, "run.last-known-good.json"), "{broken-recovery", "utf8"),
  ]);

  const blocked = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(blocked.status, "unavailable");
  assert.equal(runNumber, 1);
});

test("same-process future index replacement blocks run allocation and executor launch", async (t) => {
  let runNumber = 0;
  let providerConstructions = 0;
  const context = await harness(t, {
    createRunId: () => `index-identity-run-${++runNumber}`,
    onScript: () => (providerConstructions += 1),
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForTerminal(context.journals, started.run.runId);
  await waitForAsync(async () => (await context.service.activeRuns()).length === 0);
  assert.equal(runNumber, 1);
  assert.equal(providerConstructions, 1);

  const indexPath = path.join(context.root, "run-index.json");
  const replacementPath = path.join(context.root, "run-index.future-replacement.json");
  const futureBytes = '{"version":2,"revision":99,"entries":[],"degraded":[]}\n';
  await fs.writeFile(replacementPath, futureBytes, "utf8");
  await fs.rename(replacementPath, indexPath);

  const blocked = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(blocked.status, "unavailable");
  assert.equal(runNumber, 1);
  assert.equal(providerConstructions, 1);
  assert.equal(await fs.readFile(indexPath, "utf8"), futureBytes);
});

for (const authoritativeFile of [
  "run.json",
  "run.last-known-good.json",
  "run.events.jsonl",
  "run.last-known-good.events.jsonl",
] as const) {
  test(`same-process ${authoritativeFile} tampering blocks executor admission`, async (t) => {
    let runNumber = 0;
    let providerConstructions = 0;
    const context = await harness(t, {
      createRunId: () => `tamper-${authoritativeFile.replace(/\./gu, "-")}-${++runNumber}`,
      onScript: () => (providerConstructions += 1),
    });
    const started = await context.service.start(
      { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
      () => true,
    );
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    await waitForTerminal(context.journals, started.run.runId);
    await waitForAsync(async () => (await context.service.activeRuns()).length === 0);
    assert.equal(providerConstructions, 1);

    const target = path.join(context.root, "runs", started.run.runId, authoritativeFile);
    const before = await fs.stat(target);
    const bytes = await fs.readFile(target);
    bytes[0] = bytes[0] === 0x7b ? 0x5b : bytes[0] === 0x5b ? 0x7b : bytes[0] ^ 1;
    await fs.writeFile(target, bytes);
    await fs.utimes(target, before.atime, before.mtime);

    const blocked = await context.service.start(
      { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
      () => true,
    );
    assert.equal(blocked.status, "unavailable");
    assert.equal(runNumber, 1);
    assert.equal(providerConstructions, 1);
  });
}

test("post-pending authority replacement aborts before provider execution", async (t) => {
  let executorCalls = 0;
  let tampered = false;
  const originalExecute = DeterministicMockImageProvider.prototype.execute;
  DeterministicMockImageProvider.prototype.execute = async function (...args) {
    executorCalls += 1;
    return originalExecute.apply(this, args);
  };
  t.after(() => {
    DeterministicMockImageProvider.prototype.execute = originalExecute;
  });

  let root = "";
  const context = await harness(t, {
    createRunId: () => "post-pending-authority-run",
    journalDurability: {
      afterPendingPublished: async (runId) => {
        const directory = path.join(root, "runs", runId);
        const pending = JSON.parse(
          await fs.readFile(path.join(directory, "run.pending.json"), "utf8"),
        ) as { kind?: string; event?: { type?: string } };
        if (pending.kind !== "append" || pending.event?.type !== "run-started") return;
        const target = path.join(directory, "run.json");
        const before = await fs.stat(target);
        const bytes = await fs.readFile(target);
        bytes[0] = bytes[0] === 0x7b ? 0x5b : bytes[0] ^ 1;
        await fs.writeFile(target, bytes);
        await fs.utimes(target, before.atime, before.mtime);
        assert.equal((await fs.stat(target)).size, before.size);
        tampered = true;
      },
    },
  });
  root = context.root;
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForAsync(async () => (await context.service.activeRuns()).length === 0);

  assert.equal(tampered, true);
  assert.equal(executorCalls, 0);
  assert.equal(context.assets.publicationOrder.length, 0);
  const health = await context.journals.health(started.run.runId);
  assert.equal(health.status, "recovery-required");
  if (health.status === "recovery-required") {
    assert.equal(health.reason, "pending-conflict");
    assert.equal(health.canRecover, false);
  }
  await fs.access(path.join(root, "runs", started.run.runId, "run.pending.json"));
});

test("torn prepared-submission append is recovered without provider execution or resubmit", async (t) => {
  let executorCalls = 0;
  const originalExecute = DeterministicMockImageProvider.prototype.execute;
  DeterministicMockImageProvider.prototype.execute = async function (...args) {
    executorCalls += 1;
    return originalExecute.apply(this, args);
  };
  t.after(() => {
    DeterministicMockImageProvider.prototype.execute = originalExecute;
  });

  let root = "";
  let torn = false;
  const context = await harness(t, {
    createRunId: () => "torn-prepared-submission-run",
    journalDurability: {
      afterPendingPublished: async (runId) => {
        const directory = path.join(root, "runs", runId);
        const pending = JSON.parse(
          await fs.readFile(path.join(directory, "run.pending.json"), "utf8"),
        ) as { kind?: string; event?: CreateImagesRunEventV1 };
        if (pending.kind !== "append" || pending.event?.type !== "node-submission-prepared") {
          return;
        }
        const checkpoint = JSON.parse(
          await fs.readFile(path.join(directory, "run.json"), "utf8"),
        ) as CreateImagesRunJournalV1;
        const eventLogPath = path.join(directory, "run.events.jsonl");
        const eventLog = await fs.readFile(eventLogPath, "utf8");
        const lines = eventLog.trimEnd().split("\n");
        const previousDigest = (JSON.parse(lines[lines.length - 1] as string) as { digest: string })
          .digest;
        const event = pending.event;
        const journalRevision = event.sequence + 1;
        const digest = createHash("sha256")
          .update(JSON.stringify({ runId, journalRevision, previousDigest, event }), "utf8")
          .digest("hex");
        const record = Buffer.from(
          `${JSON.stringify({
            version: 1,
            runId,
            journalRevision,
            previousDigest,
            digest,
            event,
          })}\n`,
          "utf8",
        );
        assert.ok(checkpoint.journalRevision < journalRevision);
        await fs.appendFile(eventLogPath, record.subarray(0, Math.floor(record.length / 2)));
        torn = true;
        throw new Error("simulated process loss during prepared-submission append");
      },
    },
  });
  root = context.root;
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForAsync(async () => (await context.service.activeRuns()).length === 0);

  assert.equal(torn, true);
  assert.equal(executorCalls, 0);
  assert.equal(context.assets.publicationOrder.length, 0);
  const journal = await context.journals.get(started.run.runId);
  assert.ok(journal?.events.some((event) => event.type === "node-submission-prepared"));
  assert.equal(
    journal?.events.some((event) => event.type === "node-submission-accepted"),
    false,
  );
  assert.equal(journal && projectCreateImagesRun(journal).status, "needs_attention");
});

test("a failed start index publication reconciles its durable run before retry", async (t) => {
  let rejectIndex = false;
  let runNumber = 0;
  const context = await harness(t, {
    createRunId: () => `start-index-${++runNumber}`,
    journalDurability: {
      beforeIndexPublished: async () => {
        if (rejectIndex) throw new Error("simulated start index failure");
      },
    },
  });
  await context.service.initialize();
  rejectIndex = true;
  await assert.rejects(
    context.service.start(
      { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
      () => true,
    ),
    /simulated start index failure/u,
  );
  const authoritative = await context.journals.get("start-index-1");
  assert.equal(projectCreateImagesRun(authoritative!).terminal?.status, "interrupted");
  assert.equal(projectCreateImagesRun(authoritative!).cancellation, undefined);
  assert.equal(runNumber, 1);

  rejectIndex = false;
  const retry = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(retry.status, "started");
  assert.equal(runNumber, 2);
  if (retry.status === "started") await waitForTerminal(context.journals, retry.run.runId);
});

test("same-process launch reconciliation retains ownership until it can interrupt the orphan", async (t) => {
  let runNumber = 0;
  let scriptCalls = 0;
  const context = await harness(t, {
    createRunId: () => `launch-orphan-${++runNumber}`,
    onScript: () => (scriptCalls += 1),
  });
  const originalAppend = context.journals.append.bind(context.journals);
  let failedAppendAttempts = 0;
  context.journals.append = async (...args) => {
    if (failedAppendAttempts < 2) {
      failedAppendAttempts += 1;
      throw new Error(`simulated transient append failure ${failedAppendAttempts}`);
    }
    return originalAppend(...args);
  };

  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitFor(() => failedAppendAttempts === 2);
  assert.deepEqual(
    (await context.service.activeRuns()).map((run) => run.runId),
    [started.run.runId],
  );
  const orphan = await context.journals.get(started.run.runId);
  assert.ok(orphan);
  assert.equal(projectCreateImagesRun(orphan).terminal, undefined);
  assert.equal(scriptCalls, 1);

  context.journals.append = originalAppend;
  const admitted = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(admitted.status, "started");
  assert.equal(runNumber, 2);
  assert.equal(scriptCalls, 2);
  const interrupted = await context.journals.get(started.run.runId);
  assert.ok(interrupted);
  const interruptedProjection = projectCreateImagesRun(interrupted);
  assert.equal(interruptedProjection.status, "interrupted");
  assert.equal(interruptedProjection.cancellation, undefined);
  assert.equal(interruptedProjection.nodes["prompt-1"]?.errorCode, "interrupted");
  assert.equal(
    interrupted?.events.some(
      (event) => event.type === "node-submission-prepared" || event.type === "node-started",
    ),
    false,
  );
  if (admitted.status === "started") await waitForTerminal(context.journals, admitted.run.runId);
});

test("failed-launch callers bound a deferred publication-tail reconciliation", async (t) => {
  const never = new Promise<void>(() => undefined);
  let rejectLaunchMutation: (error: Error) => void = () => undefined;
  let launchMutationReached: () => void = () => undefined;
  const launchMutation = new Promise<CreateImagesRunJournalV1>((_resolve, reject) => {
    rejectLaunchMutation = reject;
  });
  const reachedLaunchMutation = new Promise<void>((resolve) => {
    launchMutationReached = resolve;
  });
  let runNumber = 0;
  let providerConstructions = 0;
  const context = await harness(t, {
    shutdownTimeoutMs: 30,
    createRunId: () => `publication-orphan-${++runNumber}`,
    onScript: () => (providerConstructions += 1),
  });
  const originalAppend = context.journals.append.bind(context.journals);
  let holdFirstLaunchMutation = true;
  context.journals.append = async (...args) => {
    if (!holdFirstLaunchMutation) return originalAppend(...args);
    holdFirstLaunchMutation = false;
    launchMutationReached();
    return launchMutation;
  };

  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await reachedLaunchMutation;
  const internals = context.service as unknown as {
    activeByRun: Map<
      string,
      {
        needsReconciliation?: boolean;
        publicationTail: Promise<void>;
      }
    >;
  };
  const active = internals.activeByRun.get(started.run.runId);
  assert.ok(active);
  active.publicationTail = never;
  rejectLaunchMutation(new Error("simulated launch failure before publication join"));
  await waitFor(() => active.needsReconciliation === true);

  const listStartedAt = Date.now();
  assert.equal((await context.service.list("workflow-1")).status, "unavailable");
  assert.ok(Date.now() - listStartedAt < 500, "list exceeded its publication-tail deadline");
  const startStartedAt = Date.now();
  assert.equal(
    (
      await context.service.start(
        {
          workflowId: "workflow-1",
          expectedRevision: 1,
          scope: { kind: "all" },
        },
        () => true,
      )
    ).status,
    "unavailable",
  );
  assert.ok(Date.now() - startStartedAt < 500, "start exceeded its publication-tail deadline");
  assert.equal(runNumber, 1);
  assert.equal(providerConstructions, 1);
});

test("failed-launch reconciliation bounds list, start, stop, and quit around deferred authority", async (t) => {
  const never = new Promise<void>(() => undefined);
  let healthReached: () => void = () => undefined;
  const reachedHealth = new Promise<void>((resolve) => {
    healthReached = resolve;
  });
  let runNumber = 0;
  let providerConstructions = 0;
  const context = await harness(t, {
    shutdownTimeoutMs: 30,
    createRunId: () => `bounded-orphan-${++runNumber}`,
    onScript: () => (providerConstructions += 1),
  });
  const originalAppend = context.journals.append.bind(context.journals);
  let rejectFirstLaunchMutation = true;
  context.journals.append = async (...args) => {
    if (rejectFirstLaunchMutation) {
      rejectFirstLaunchMutation = false;
      throw new Error("simulated launch mutation failure");
    }
    return originalAppend(...args);
  };
  context.journals.health = async () => {
    healthReached();
    return never as never;
  };

  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await reachedHealth;
  const internals = context.service as unknown as {
    activeByRun: Map<
      string,
      {
        mutationTail: Promise<void>;
        publicationTail: Promise<void>;
      }
    >;
  };
  const active = internals.activeByRun.get(started.run.runId);
  assert.ok(active);
  active.mutationTail = never;
  active.publicationTail = never;

  const listStartedAt = Date.now();
  assert.equal((await context.service.list("workflow-1")).status, "unavailable");
  assert.ok(Date.now() - listStartedAt < 500, "list exceeded its reconciliation deadline");

  const startStartedAt = Date.now();
  assert.equal(
    (
      await context.service.start(
        {
          workflowId: "workflow-1",
          expectedRevision: 1,
          scope: { kind: "all" },
        },
        () => true,
      )
    ).status,
    "unavailable",
  );
  assert.ok(Date.now() - startStartedAt < 500, "start exceeded its reconciliation deadline");
  assert.equal(runNumber, 1);
  assert.equal(providerConstructions, 1);

  const stopStartedAt = Date.now();
  assert.equal(
    (await context.service.stop("workflow-1", started.run.runId, "user")).status,
    "unavailable",
  );
  assert.ok(Date.now() - stopStartedAt < 500, "stop exceeded its durable deadline");

  const quitStartedAt = Date.now();
  assert.deepEqual(await context.service.stopAll("app-quit"), {
    status: "blocked",
    failedRunIds: [started.run.runId],
  });
  assert.ok(Date.now() - quitStartedAt < 500, "stopAll exceeded its durable deadline");
  const durable = await context.journals.get(started.run.runId);
  assert.equal(
    durable?.events.some(
      (event) => event.type === "node-submission-prepared" || event.type === "node-started",
    ),
    false,
  );
});

test("asset publication failure is terminal and reconciliation releases its reservation", async (t) => {
  const context = await harness(t);
  context.assets.failIngest = true;
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const journal = await waitForTerminal(context.journals, started.run.runId);
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.status, "failed");
  assert.equal(projection.nodes["generate-1"]?.errorCode, "output-publication-failed");
  assert.ok(context.references.reservations.length > 0);
  await waitFor(() => context.references.reservations.every((reservation) => !reservation.active));
  assert.equal(
    context.references.reservations.some((reservation) => reservation.active),
    false,
  );
  assert.equal(context.references.isRunAssetReferenced(journal.runId, "a".repeat(64)), false);
});

test("prepared restart becomes needs-attention without executing or resubmitting", async (t) => {
  let scriptCalls = 0;
  const context = await harness(t, {
    onScript: () => (scriptCalls += 1),
    now: () => Date.parse(NOW) - 60_000,
  });
  const plan = createWorkflowCoordinatorPlan(workflow(), { kind: "all" });
  let journal = await context.journals.start(
    {
      runId: "run-restart",
      workflowSnapshot: plan.snapshot,
      plan: {
        scope: { kind: "all" },
        orderedNodeIds: [...plan.orderedNodeIds],
        dependencies: Object.fromEntries(
          Object.entries(plan.dependencies).map(([nodeId, values]) => [nodeId, [...values]]),
        ),
      },
      createdAt: NOW,
    },
    () => true,
  );
  const append = async (event: CreateImagesRunEventV1) => {
    journal = await context.journals.append(journal.runId, journal.journalRevision, event);
  };
  const base = () => ({
    workflowId: journal.workflowId,
    workflowRevision: journal.workflowRevision,
    runId: journal.runId,
    sequence: journal.events.length + 1,
    at: NOW,
  });
  await append({ ...base(), type: "run-started" });
  await append({ ...base(), type: "node-started", nodeId: "prompt-1" });
  await append({
    ...base(),
    type: "node-output-published",
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  await append({
    ...base(),
    type: "node-succeeded",
    nodeId: "prompt-1",
    outputAssetIds: [],
  });
  await append({ ...base(), type: "node-started", nodeId: "generate-1" });
  await append({
    ...base(),
    type: "node-submission-prepared",
    nodeId: "generate-1",
    attempt: 1,
    idempotencyKey: "idem-restart-node-0001",
    providerId: "local-mock",
    modelId: "deterministic-v1",
  });

  await context.service.initialize();
  const reconciled = await context.journals.get("run-restart");
  assert.ok(reconciled);
  assert.equal(reconciled && projectCreateImagesRun(reconciled).status, "needs_attention");
  assert.equal(scriptCalls, 0);
  assert.equal(
    reconciled?.events.filter((event) => event.type === "node-submission-prepared").length,
    1,
  );
  assert.equal(
    reconciled?.events.some((event) => event.type === "node-submission-accepted"),
    false,
  );
  assert.ok(Date.parse(reconciled?.updatedAt ?? "") >= Date.parse(NOW));
});

test("accepted restart reconciles the durable mock job and truthfully interrupts lost local work", async (t) => {
  let scriptCalls = 0;
  const context = await harness(t, {
    onScript: () => (scriptCalls += 1),
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "success",
            remoteJobId: "accepted-restart-job",
            durableRemoteJob: true,
            width: 8,
            height: 8,
            seed: 37,
          },
        ],
      },
    },
  });
  await seedRestartRun(context.journals, {
    runId: "run-accepted-restart",
    providerJobId: "accepted-restart-job",
  });
  await context.service.initialize();
  const journal = await waitForTerminal(context.journals, "run-accepted-restart");
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.status, "interrupted");
  assert.equal(projection.nodes["generate-1"]?.status, "succeeded");
  assert.equal(projection.nodes["generate-1"]?.outputAssetIds.length, 1);
  assert.equal(projection.nodes["output-1"]?.status, "failed");
  assert.equal(projection.nodes["output-1"]?.errorCode, "interrupted");
  assert.equal(projection.cancellation, undefined);
  assert.equal(scriptCalls, 1);
  assert.equal(
    journal.events.filter((event) => event.type === "node-submission-prepared").length,
    1,
  );
  assert.equal(
    journal.events.filter((event) => event.type === "node-submission-accepted").length,
    1,
  );
  assert.equal(
    journal.events.filter(
      (event) => event.type === "node-output-published" && event.nodeId === "generate-1",
    ).length,
    1,
  );
  assert.equal(context.assets.publicationOrder.length, 1);
});

test("restart cancellation remains authoritative over an accepted provider job", async (t) => {
  let scriptCalls = 0;
  const context = await harness(t, {
    onScript: () => (scriptCalls += 1),
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "success",
            remoteJobId: "accepted-cancelled-job",
            durableRemoteJob: true,
            width: 8,
            height: 8,
          },
        ],
      },
    },
  });
  const accepted = await seedRestartRun(context.journals, {
    runId: "run-accepted-cancelled",
    providerJobId: "accepted-cancelled-job",
  });
  await context.journals.requestCancellation(accepted.runId, accepted.journalRevision, {
    at: NOW,
    reason: "app-quit",
  });

  await context.service.initialize();
  const journal = await waitForTerminal(context.journals, "run-accepted-cancelled");
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.cancellation?.reason, "app-quit");
  assert.equal(projection.terminal?.status, "cancelled");
  assert.equal(projection.nodes["generate-1"]?.status, "cancelled");
  assert.equal(scriptCalls, 0);
  assert.equal(context.assets.publicationOrder.length, 0);
  assert.equal(
    journal.events.some(
      (candidate) =>
        candidate.type === "node-output-published" && candidate.nodeId === "generate-1",
    ),
    false,
  );
});

test("restart keeps a prepared submission ambiguous even after durable cancellation", async (t) => {
  const context = await harness(t);
  const prepared = await seedRestartRun(context.journals, {
    runId: "run-prepared-cancelled",
  });
  await context.journals.requestCancellation(prepared.runId, prepared.journalRevision, {
    at: NOW,
    reason: "app-quit",
  });

  await context.service.initialize();
  const journal = await waitForTerminal(context.journals, prepared.runId);
  const projection = projectCreateImagesRun(journal);
  assert.equal(projection.cancellation?.reason, "app-quit");
  assert.equal(projection.status, "needs_attention");
  assert.equal(projection.nodes["generate-1"]?.status, "ambiguous");
  assert.equal(projection.nodes["output-1"]?.status, "blocked");
  assert.equal(
    journal.events.some(
      (event) => event.type === "node-cancelled" && event.nodeId === "generate-1",
    ),
    false,
  );
});

test("restart finalizes a node only from its durably published output boundary", async (t) => {
  let scriptCalls = 0;
  const context = await harness(t, { onScript: () => (scriptCalls += 1) });
  await seedRestartRun(context.journals, {
    runId: "run-output-published",
    providerJobId: "accepted-output-job",
    durableOutputAssetIds: [DURABLE_ASSET_ID, DURABLE_ASSET_ID],
  });
  context.assets.available.set(DURABLE_ASSET_ID, {
    assetId: DURABLE_ASSET_ID,
    mediaType: "image/png",
    byteLength: 1,
    width: 1,
    height: 1,
    createdAt: NOW,
    origin: {
      kind: "provider",
      providerId: "local-mock",
      modelId: "deterministic-v1",
      runId: "run-output-published",
    },
    referenceCount: 1,
    thumbnailSizes: [],
  });
  await context.service.initialize();
  const journal = await waitForTerminal(context.journals, "run-output-published");
  const node = projectCreateImagesRun(journal).nodes["generate-1"];
  assert.equal(node?.status, "succeeded");
  assert.deepEqual(node?.outputAssetIds, [DURABLE_ASSET_ID, DURABLE_ASSET_ID]);
  assert.equal(scriptCalls, 0);
  assert.equal(context.assets.publicationOrder.length, 0);
  assert.equal(
    journal.events.filter(
      (event) => event.type === "node-output-published" && event.nodeId === "generate-1",
    ).length,
    1,
  );
  const listed = await context.service.list("workflow-1");
  assert.equal(listed.status, "ready");
  if (listed.status === "ready") {
    assert.equal(
      listed.history.find((entry) => entry.runId === "run-output-published")?.outputCount,
      2,
    );
  }
});

test("restart refuses to finalize a published output whose durable asset is missing", async (t) => {
  let scriptCalls = 0;
  const context = await harness(t, { onScript: () => (scriptCalls += 1) });
  await seedRestartRun(context.journals, {
    runId: "run-output-missing",
    providerJobId: "accepted-output-job",
    durableOutputAssetIds: [DURABLE_ASSET_ID],
  });
  await context.service.initialize();
  const journal = await waitForTerminal(context.journals, "run-output-missing");
  const node = projectCreateImagesRun(journal).nodes["generate-1"];
  assert.equal(node?.status, "failed");
  assert.equal(node?.errorCode, "output-publication-failed");
  assert.equal(scriptCalls, 0);
});

test("service revalidates stale terminal metadata and reconciles queued work before new admission", async (t) => {
  const context = await harness(t, { createRunId: () => "new-run" });
  const plan = createWorkflowCoordinatorPlan(workflow(), { kind: "all" });
  await context.journals.start(
    {
      runId: "concealed-queued",
      workflowSnapshot: plan.snapshot,
      plan: {
        scope: { kind: "all" },
        orderedNodeIds: [...plan.orderedNodeIds],
        dependencies: Object.fromEntries(
          Object.entries(plan.dependencies).map(([nodeId, values]) => [nodeId, [...values]]),
        ),
      },
      createdAt: NOW,
    },
    () => true,
  );
  const indexPath = path.join(context.root, "run-index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  index.entries[0]!.status = "succeeded";
  index.entries[0]!.terminal = true;
  await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

  await context.service.initialize();
  const concealed = await context.journals.get("concealed-queued");
  assert.ok(concealed);
  const concealedProjection = projectCreateImagesRun(concealed!);
  assert.equal(concealedProjection.terminal?.status, "interrupted");
  assert.equal(concealedProjection.cancellation, undefined);
  assert.equal(concealedProjection.nodes["prompt-1"]?.errorCode, "interrupted");
  assert.equal(
    concealed!.events.some(
      (event) =>
        event.type === "run-cancel-requested" ||
        event.type === "run-started" ||
        event.type === "node-started",
    ),
    false,
  );
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status === "started") {
    await context.service.stop("workflow-1", started.run.runId, "user");
    await waitForTerminal(context.journals, started.run.runId);
  }
});

test("production run service distinguishes every mock submission crash boundary", async (t) => {
  await t.test(
    "crash before send is the only automatically retryable exception boundary",
    async (t) => {
      const context = await harness(t, {
        script: {
          nodes: {
            "generate-1": [
              { outcome: "crash-before-send" },
              { outcome: "success", width: 8, height: 8, seed: 12 },
            ],
          },
        },
      });
      const started = await context.service.start(
        {
          workflowId: "workflow-1",
          expectedRevision: 1,
          scope: { kind: "all" },
        },
        () => true,
      );
      assert.equal(started.status, "started");
      if (started.status !== "started") return;
      const journal = await waitForTerminal(context.journals, started.run.runId);
      assert.equal(projectCreateImagesRun(journal).status, "succeeded");
      assert.equal(
        journal.events.filter((event) => event.type === "node-submission-prepared").length,
        2,
      );
    },
  );

  for (const [outcome, acceptedCount] of [
    ["accepted-before-response", 0],
    ["crash-after-send", 1],
  ] as const) {
    await t.test(outcome, async (t) => {
      const context = await harness(t, {
        script: { nodes: { "generate-1": [{ outcome }] } },
      });
      const started = await context.service.start(
        {
          workflowId: "workflow-1",
          expectedRevision: 1,
          scope: { kind: "all" },
        },
        () => true,
      );
      assert.equal(started.status, "started");
      if (started.status !== "started") return;
      const journal = await waitForTerminal(context.journals, started.run.runId);
      const projection = projectCreateImagesRun(journal);
      assert.equal(projection.status, "needs_attention");
      assert.equal(projection.nodes["generate-1"]?.status, "ambiguous");
      assert.equal(
        journal.events.filter((event) => event.type === "node-submission-accepted").length,
        acceptedCount,
      );
      const attempts = projection.nodes["generate-1"]?.attempts ?? [];
      assert.equal(
        attempts[attempts.length - 1]?.submission,
        outcome === "accepted-before-response" ? "ambiguous" : "accepted",
      );
    });
  }
});

test("production run coordination rejects out-of-order mock completion but tolerates duplicates", async (t) => {
  for (const [label, script, expected] of [
    ["duplicate", { outcome: "success", duplicateSubmittedEvent: true }, "succeeded"],
    ["out-of-order", { outcome: "success", outOfOrderCompletionEvent: true }, "needs_attention"],
  ] as const) {
    await t.test(label, async (t) => {
      const context = await harness(t, {
        script: {
          nodes: { "generate-1": [{ ...script, width: 8, height: 8 }] },
        },
      });
      const started = await context.service.start(
        {
          workflowId: "workflow-1",
          expectedRevision: 1,
          scope: { kind: "all" },
        },
        () => true,
      );
      assert.equal(started.status, "started");
      if (started.status !== "started") return;
      const journal = await waitForTerminal(context.journals, started.run.runId);
      assert.equal(projectCreateImagesRun(journal).status, expected);
    });
  }
});

test("snapshot input assets are reserved before journal publication and committed before launch", async (t) => {
  const document = workflow();
  document.nodes.push({
    id: "image-input-1",
    type: "image-input",
    position: { x: 0, y: 100 },
    data: { assetId: DURABLE_ASSET_ID },
  });
  document.assetRefs = [DURABLE_ASSET_ID];
  const context = await harness(t, {
    document,
    script: {
      nodes: {
        "generate-1": [{ outcome: "success", delayMs: 60_000, width: 8, height: 8 }],
      },
    },
  });
  context.assets.available.set(DURABLE_ASSET_ID, {
    assetId: DURABLE_ASSET_ID,
    mediaType: "image/png",
    byteLength: 1,
    width: 1,
    height: 1,
    createdAt: NOW,
    origin: { kind: "import" },
    referenceCount: 1,
    thumbnailSizes: [],
  });
  let publicationChecks = 0;
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => {
      publicationChecks += 1;
      assert.equal(context.references.isRunAssetReferenced("run-1", DURABLE_ASSET_ID), true);
      return true;
    },
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  assert.equal(publicationChecks, 1);
  assert.deepEqual(context.references.order.slice(0, 3), [
    "reserve:run-1",
    "commit:run-1",
    "release:run-1",
  ]);
  assert.equal(context.references.isRunAssetReferenced("run-1", DURABLE_ASSET_ID), true);
  assert.deepEqual(context.assets.runReferences.get("run-1"), [DURABLE_ASSET_ID]);
  await context.service.stop("workflow-1", "run-1", "user");
  await waitForTerminal(context.journals, "run-1");
});

test("run detail, recovery, and active-run reads stay workflow-authorized and path-free", async (t) => {
  const context = await harness(t, {
    script: {
      nodes: {
        "generate-1": [{ outcome: "success", delayMs: 60_000, width: 8, height: 8 }],
      },
    },
  });
  await context.workflows.create({
    ...workflow(),
    id: "workflow-2",
    title: "Another workflow",
  });
  assert.deepEqual(await context.service.list("missing-workflow"), {
    status: "not-found",
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  assert.deepEqual(
    (await context.service.activeRuns()).map((run) => run.runId),
    [started.run.runId],
  );
  assert.equal((await context.service.get("workflow-1", started.run.runId)).status, "ready");
  assert.equal((await context.service.get("workflow-2", started.run.runId)).status, "not-found");
  await context.service.stop("workflow-1", started.run.runId, "user");
  await waitForTerminal(context.journals, started.run.runId);
  await fs.writeFile(
    path.join(context.root, "runs", started.run.runId, "run.json"),
    "{broken",
    "utf8",
  );
  const listed = await context.service.list("workflow-1");
  assert.equal(listed.status, "ready");
  if (listed.status !== "ready") return;
  assert.equal(listed.authoritative, true);
  assert.equal(
    listed.history.some((entry) => entry.runId === started.run.runId),
    false,
  );
  assert.equal(listed.recoveries.length, 1);
  const recovery = listed.recoveries[0];
  assert.equal(recovery?.status, "recovery-required");
  if (!recovery || recovery.status !== "recovery-required") return;
  assert.equal(recovery.workflowId, "workflow-1");
  assert.equal(recovery.recoverySource, "last-known-good");
  assert.equal(JSON.stringify(recovery).includes(context.root), false);
  assert.equal(
    (await context.service.get("workflow-1", started.run.runId)).status,
    "recovery-required",
  );
  const expected = recovery.expectedCandidateJournalRevision;
  assert.ok(expected);
  const conflict = await context.service.recover(
    "workflow-1",
    started.run.runId,
    "last-known-good",
    (expected ?? 1) + 1,
  );
  assert.equal(conflict.status, "conflict");
  const recovered = await context.service.recover(
    "workflow-1",
    started.run.runId,
    "last-known-good",
    expected ?? 1,
  );
  assert.equal(recovered.status, "recovered");
  assert.equal((await context.service.get("workflow-1", started.run.runId)).status, "ready");
  assert.deepEqual(await context.service.activeRuns(), []);
});

test("recovery can durably rebuild last-known-good from a healthy current journal", async (t) => {
  const context = await harness(t);
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForTerminal(context.journals, started.run.runId);
  await fs.writeFile(
    path.join(context.root, "runs", started.run.runId, "run.last-known-good.json"),
    "{broken",
    "utf8",
  );

  const listed = await context.service.list("workflow-1");
  assert.equal(listed.status, "ready");
  if (listed.status !== "ready") return;
  const recovery = listed.recoveries[0];
  assert.equal(recovery?.status, "recovery-required");
  if (!recovery || recovery.status !== "recovery-required") return;
  assert.equal(recovery.recoverySource, "current");
  assert.ok(recovery.expectedCandidateJournalRevision);
  const recovered = await context.service.recover(
    "workflow-1",
    started.run.runId,
    "current",
    recovery.expectedCandidateJournalRevision ?? 1,
  );
  assert.equal(recovered.status, "recovered");
  assert.equal((await context.service.get("workflow-1", started.run.runId)).status, "ready");
});

test("future-schema and both-corrupt runs remain workflow-authorized list and detail records", async (t) => {
  let nextRun = 0;
  const context = await harness(t, {
    createRunId: () => `degraded-${++nextRun}`,
  });
  for (let index = 0; index < 2; index += 1) {
    const started = await context.service.start(
      { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
      () => true,
    );
    assert.equal(started.status, "started");
    if (started.status === "started") {
      await waitForTerminal(context.journals, started.run.runId);
      await waitForAsync(async () => (await context.service.activeRuns()).length === 0);
    }
  }

  const futurePath = path.join(context.root, "runs", "degraded-1", "run.json");
  const future = JSON.parse(await fs.readFile(futurePath, "utf8")) as Record<string, unknown>;
  future.version = 2;
  await fs.writeFile(futurePath, `${JSON.stringify(future)}\n`, "utf8");
  await Promise.all([
    fs.writeFile(
      path.join(context.root, "runs", "degraded-2", "run.json"),
      "{broken-current",
      "utf8",
    ),
    fs.writeFile(
      path.join(context.root, "runs", "degraded-2", "run.last-known-good.json"),
      "{broken-recovery",
      "utf8",
    ),
  ]);

  const listed = await context.service.list("workflow-1");
  assert.equal(listed.status, "ready");
  if (listed.status !== "ready") return;
  assert.deepEqual(
    listed.recoveries.map((recovery) => ({
      runId: recovery.runId,
      status: recovery.status,
    })),
    [
      { runId: "degraded-1", status: "unsafe" },
      { runId: "degraded-2", status: "recovery-required" },
    ],
  );
  const corrupt = listed.recoveries.find((recovery) => recovery.runId === "degraded-2");
  assert.equal(corrupt?.status, "recovery-required");
  if (corrupt?.status === "recovery-required") assert.equal(corrupt.recoverySource, undefined);
  assert.equal((await context.service.get("workflow-1", "degraded-1")).status, "unsafe");
  assert.equal((await context.service.get("workflow-1", "degraded-2")).status, "recovery-required");
  assert.equal((await context.service.get("other-workflow", "degraded-1")).status, "not-found");
  assert.equal(
    (await context.service.recover("workflow-1", "degraded-1", "current", 1)).status,
    "unsafe",
  );
});

test("stopAll durably cancels but does not wait forever for stalled publication", async (t) => {
  const context = await harness(t, { shutdownTimeoutMs: 250 });
  context.assets.ingestGate = new Promise<void>(() => undefined);
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitFor(() => context.assets.ingestStarted);
  const startedAt = Date.now();
  const stopped = await context.service.stopAll("app-quit");
  assert.ok(Date.now() - startedAt < 1_000, "stopAll exceeded its bounded deadline");
  assert.deepEqual(stopped, {
    status: "safe-to-quit",
    unsettledRunIds: [started.run.runId],
  });
  const journal = await context.journals.get(started.run.runId);
  assert.equal(projectCreateImagesRun(journal!).cancellation?.reason, "app-quit");
});

test("stopAll closes admission before joining an in-flight durable start", async (t) => {
  let releaseAdmission: () => void = () => undefined;
  let markPending: () => void = () => undefined;
  const admissionGate = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const pendingReached = new Promise<void>((resolve) => {
    markPending = resolve;
  });
  let pauseFirstStart = true;
  let runNumber = 0;
  const context = await harness(t, {
    shutdownTimeoutMs: 300,
    createRunId: () => `admission-run-${++runNumber}`,
    journalDurability: {
      afterPendingPublished: async (runId) => {
        if (runId !== "admission-run-1" || !pauseFirstStart) return;
        pauseFirstStart = false;
        markPending();
        await admissionGate;
      },
    },
    script: {
      nodes: {
        "generate-1": [{ outcome: "success", delayMs: 60_000, width: 8, height: 8 }],
      },
    },
  });
  const crossingStart = context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  await pendingReached;
  const quitStartedAt = Date.now();
  assert.deepEqual(await context.service.stopAll("app-quit"), {
    status: "blocked",
    failedRunIds: [],
  });
  assert.ok(Date.now() - quitStartedAt < 1_000);

  const laterStart = context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  releaseAdmission();
  assert.equal((await crossingStart).status, "started");
  assert.equal((await laterStart).status, "unavailable");
  assert.equal((await context.service.stopAll("app-quit")).status, "safe-to-quit");
});

test("stop and stopAll report blocked when durable cancellation rejects", async (t) => {
  const context = await harness(t, { shutdownTimeoutMs: 30 });
  context.assets.ingestGate = new Promise<void>(() => undefined);
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitFor(() => context.assets.ingestStarted);
  context.journals.requestCancellation = async () => {
    throw new Error("simulated cancellation journal rejection");
  };

  const stopped = await context.service.stop("workflow-1", started.run.runId, "user");
  assert.equal(stopped.status, "unavailable");
  const quitStartedAt = Date.now();
  assert.deepEqual(await context.service.stopAll("app-quit"), {
    status: "blocked",
    failedRunIds: [started.run.runId],
  });
  assert.ok(Date.now() - quitStartedAt < 500);
  const journal = await context.journals.get(started.run.runId);
  assert.equal(projectCreateImagesRun(journal!).cancellation, undefined);
  assert.equal(projectCreateImagesRun(journal!).terminal, undefined);
});

test("after-pending cancellation hangs block quit without a follow-up store read", async (t) => {
  let blockCancellation = false;
  const never = new Promise<void>(() => undefined);
  const context = await harness(t, {
    shutdownTimeoutMs: 30,
    journalDurability: {
      afterPendingPublished: async () => {
        if (blockCancellation) await never;
      },
    },
    script: {
      nodes: {
        "generate-1": [{ outcome: "success", delayMs: 1_000, width: 8, height: 8 }],
      },
    },
  });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  await waitForJournal(context.journals, started.run.runId, (journal) =>
    journal.events.some((candidate) => candidate.type === "node-submission-accepted"),
  );
  blockCancellation = true;

  const quitStartedAt = Date.now();
  assert.deepEqual(await context.service.stopAll("app-quit"), {
    status: "blocked",
    failedRunIds: [started.run.runId],
  });
  assert.ok(Date.now() - quitStartedAt < 500);
  const inspectStartedAt = Date.now();
  assert.deepEqual(
    (await context.service.activeRuns()).map((run) => run.runId),
    [started.run.runId],
  );
  assert.ok(Date.now() - inspectStartedAt < 100);
  const pending = JSON.parse(
    await fs.readFile(
      path.join(context.root, "runs", started.run.runId, "run.pending.json"),
      "utf8",
    ),
  ) as { event?: { type?: string } };
  assert.equal(pending.event?.type, "run-cancel-requested");
});

test("run history retention requires a fresh CAS plan and reconciles released run references", async (t) => {
  const context = await harness(t);
  const candidates = [
    {
      runId: "old-run-1",
      workflowId: "workflow-1",
      journalRevision: 7,
      updatedAt: NOW,
      assetIds: [DURABLE_ASSET_ID],
    },
  ];
  const token = "b".repeat(64);
  context.references.committed.set("old-run-1", new Set([DURABLE_ASSET_ID]));
  context.assets.runReferences.set("old-run-1", [DURABLE_ASSET_ID]);
  context.journals.terminalRetentionCandidates = async (query) => {
    assert.deepEqual(query, { keepLatest: 100, limit: 100 });
    return candidates;
  };
  context.journals.planTerminalPrune = async (requested) => {
    assert.deepEqual(requested, candidates);
    return {
      version: 1,
      candidates: [{ runId: "old-run-1", journalRevision: 7 }],
      token,
      assetIds: [DURABLE_ASSET_ID],
    };
  };
  let pruned = false;
  context.journals.pruneTerminalRuns = async (plan) => {
    assert.equal(plan.token, token);
    pruned = true;
    return {
      removedRunIds: ["old-run-1"],
      releasedAssetIds: [DURABLE_ASSET_ID],
    };
  };

  assert.deepEqual(await context.service.planHistoryPrune(100), {
    status: "ready",
    scope: "all-workflows",
    mayReleaseUniqueOutputs: true,
    authorizationToken: token,
    keepLatest: 100,
    candidateRunCount: 1,
    releasedAssetCount: 1,
  });
  assert.equal((await context.service.pruneHistory(100, "c".repeat(64))).status, "conflict");
  assert.equal(pruned, false);
  assert.deepEqual(await context.service.pruneHistory(100, token), {
    status: "pruned",
    removedRunCount: 1,
    releasedAssetCount: 1,
  });
  assert.equal(pruned, true);
  assert.deepEqual(context.assets.runReferences.get("old-run-1"), []);
  assert.equal(context.references.isRunAssetReferenced("old-run-1", DURABLE_ASSET_ID), false);
});

test("service requires a fresh explicit plan before discarding irrecoverable run authority", async (t) => {
  const context = await harness(t, { createRunId: () => "replacement-run" });
  await context.service.initialize();
  const plan = createWorkflowCoordinatorPlan(workflow(), { kind: "all" });
  await context.journals.start(
    {
      runId: "damaged-run",
      workflowSnapshot: plan.snapshot,
      plan: {
        scope: structuredClone(plan.scope),
        orderedNodeIds: [...plan.orderedNodeIds],
        dependencies: Object.fromEntries(
          Object.entries(plan.dependencies).map(([nodeId, dependencies]) => [
            nodeId,
            [...dependencies],
          ]),
        ),
      },
      createdAt: NOW,
    },
    () => true,
  );
  await Promise.all([
    fs.writeFile(
      path.join(context.root, "runs", "damaged-run", "run.json"),
      "{broken-current",
      "utf8",
    ),
    fs.writeFile(
      path.join(context.root, "runs", "damaged-run", "run.last-known-good.json"),
      "{broken-recovery",
      "utf8",
    ),
  ]);
  assert.notEqual((await context.journals.health("damaged-run")).status, "healthy");
  const blocked = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(blocked.status, "unavailable");

  const planned = await context.service.planDegradedRunDiscard("damaged-run");
  assert.equal(planned.status, "ready");
  if (planned.status !== "ready") return;
  assert.equal(planned.mayLoseOutputs, true);
  assert.equal(planned.mayDuplicateProviderWork, true);
  assert.deepEqual(
    await context.service.discardDegradedRun({
      runId: planned.runId,
      authorizationToken: "f".repeat(64),
      confirmed: true,
    }),
    { status: "conflict" },
  );
  const discarded = await context.service.discardDegradedRun({
    runId: planned.runId,
    authorizationToken: planned.authorizationToken,
    ...(planned.expectedCurrentJournalRevision === undefined
      ? {}
      : {
          expectedCurrentJournalRevision: planned.expectedCurrentJournalRevision,
        }),
    ...(planned.expectedLastKnownGoodJournalRevision === undefined
      ? {}
      : {
          expectedLastKnownGoodJournalRevision: planned.expectedLastKnownGoodJournalRevision,
        }),
    confirmed: true,
  });
  assert.equal(discarded.status, "discarded");
  if (discarded.status === "discarded") {
    assert.equal(discarded.authoritativeList?.status, "ready");
  }
  assert.equal(await context.journals.degradedRunCount(), 0);
  const admitted = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(admitted.status, "started");
  await context.service.stopAll("app-quit");
});

test("main admission rejects a forged rejoining downstream path without creating a journal", async (t) => {
  const document = workflow();
  const firstGeneration = document.nodes.find((node) => node.id === "generate-1")!;
  document.nodes = [
    document.nodes.find((node) => node.id === "prompt-1")!,
    { ...structuredClone(firstGeneration), id: "generation-a" },
    { ...structuredClone(firstGeneration), id: "generation-b" },
    {
      id: "gallery",
      type: "output-gallery",
      position: { x: 200, y: 0 },
      data: {},
    },
  ];
  document.edges = [
    {
      id: "prompt-a",
      source: "prompt-1",
      sourcePort: "text",
      target: "generation-a",
      targetPort: "prompt",
    },
    {
      id: "prompt-b",
      source: "prompt-1",
      sourcePort: "text",
      target: "generation-b",
      targetPort: "prompt",
    },
    {
      id: "images-a",
      source: "generation-a",
      sourcePort: "images",
      target: "gallery",
      targetPort: "images",
    },
    {
      id: "images-b",
      source: "generation-b",
      sourcePort: "images",
      target: "gallery",
      targetPort: "images",
    },
  ];
  let allocatedRunIds = 0;
  const context = await harness(t, {
    document,
    createRunId: () => `forged-run-${++allocatedRunIds}`,
  });
  const result = await context.service.start(
    {
      workflowId: "workflow-1",
      expectedRevision: 1,
      scope: {
        kind: "from-node",
        nodeId: "prompt-1",
        downstreamPath: ["generation-a", "gallery"],
      },
    },
    () => true,
  );
  assert.equal(result.status, "invalid");
  assert.equal(allocatedRunIds, 0);
  assert.deepEqual(await context.journals.reconciliationCandidates(), []);
  assert.deepEqual(await context.journals.terminalHistory(), []);
});

test("start enforces exact workflow revision, renderer liveness, and one active run per workflow", async (t) => {
  let runNumber = 0;
  const context = await harness(t, {
    createRunId: () => `run-${++runNumber}`,
    script: {
      nodes: {
        "generate-1": [{ outcome: "success", delayMs: 60_000, width: 8, height: 8, seed: 9 }],
      },
    },
  });
  const conflict = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 2, scope: { kind: "all" } },
    () => true,
  );
  assert.deepEqual(conflict, {
    status: "conflict",
    expectedRevision: 2,
    currentRevision: 1,
  });
  let staleChecks = 0;
  await assert.rejects(
    context.service.start(
      { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
      () => {
        staleChecks += 1;
        return false;
      },
    ),
    /no longer active/u,
  );
  assert.equal(staleChecks, 1);
  assert.equal(
    context.references.reservations.find((reservation) => reservation.runId === "run-1")?.active,
    false,
  );
  assert.equal((await context.journals.health("run-1")).status, "missing");

  const starts = await Promise.all([
    context.service.start(
      { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
      () => true,
    ),
    context.service.start(
      { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
      () => true,
    ),
  ]);
  assert.deepEqual(starts.map((result) => result.status).sort(), ["already-running", "started"]);
  const running = starts.find((result) => result.status === "started");
  assert.ok(running?.status === "started");
  await context.service.stop("workflow-1", running.run.runId, "user");
  await waitForTerminal(context.journals, running.run.runId);
});

test("multi-image output persists every unique durable asset and counts the batch once", async (t) => {
  const context = await harness(t, { document: workflow(3) });
  const started = await context.service.start(
    { workflowId: "workflow-1", expectedRevision: 1, scope: { kind: "all" } },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const journal = await waitForTerminal(context.journals, started.run.runId);
  const outputAssetIds = projectCreateImagesRun(journal).nodes["generate-1"]?.outputAssetIds ?? [];
  assert.equal(outputAssetIds.length, 3);
  assert.equal(new Set(outputAssetIds).size, 3);
  assert.ok(outputAssetIds.every((assetId) => context.assets.available.has(assetId)));
  assert.deepEqual(context.assets.runReferences.get(journal.runId), [...outputAssetIds].sort());
  const listed = await context.service.list("workflow-1");
  assert.equal(listed.status, "ready");
  if (listed.status === "ready") assert.equal(listed.history[0]?.outputCount, 3);
});

test("active-run admission is globally capped before a fifth journal is published", async (t) => {
  let runNumber = 0;
  const context = await harness(t, {
    createRunId: () => `run-cap-${++runNumber}`,
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "success",
            delayMs: 60_000,
            width: 8,
            height: 8,
            seed: 11,
          },
        ],
      },
    },
  });
  const workflowIds = Array.from(
    { length: CREATE_IMAGES_MAX_ACTIVE_RUNS + 1 },
    (_, index) => `workflow-${index + 1}`,
  );
  for (const workflowId of workflowIds.slice(1)) {
    await context.workflows.create({
      ...workflow(),
      id: workflowId,
      title: `Workflow ${workflowId}`,
    });
  }
  const results = await Promise.all(
    workflowIds.map((workflowId) =>
      context.service.start(
        { workflowId, expectedRevision: 1, scope: { kind: "all" } },
        () => true,
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === "started").length, 4);
  assert.equal(results.filter((result) => result.status === "unavailable").length, 1);
  assert.equal((await context.journals.initialize()).length, CREATE_IMAGES_MAX_ACTIVE_RUNS);
  await context.service.stopAll("app-quit");
});

test("Gemini launch requires one-shot main consent and durably binds provider authority", async (t) => {
  const secret = "AIzaSy_PHASE4_TEST_KEY_NEVER_PERSIST";
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  let fetchCount = 0;
  let runCount = 0;
  const context = await harness(t, {
    createRunId: () => `gemini-run-${++runCount}`,
    resolveGeminiAuth: async () => ({ auth: { apiKey: secret }, source: "test API key" }),
    createGeminiProvider: () =>
      new GeminiImageProvider({
        fetch: (async () => {
          fetchCount += 1;
          return new Response(
            JSON.stringify({
              id: "interactions/phase4-test",
              status: "completed",
              steps: [
                {
                  type: "model_output",
                  content: [{ type: "image", mime_type: "image/png", data: png }],
                },
              ],
              usage: { total_input_tokens: 3, total_output_tokens: 4, total_tokens: 7 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof globalThis.fetch,
      }),
  });

  const withoutConsent = await context.service.start(
    {
      workflowId: "workflow-1",
      expectedRevision: 1,
      scope: { kind: "all" },
      executionMode: "gemini",
    },
    () => true,
  );
  assert.equal(withoutConsent.status, "invalid");
  assert.equal(runCount, 0);
  assert.equal(fetchCount, 0);

  const prepared = await context.service.prepareGeminiRun({
    workflowId: "workflow-1",
    expectedRevision: 1,
    scope: { kind: "all" },
  });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.plan.accounting.initialRequestCount, 1);
  assert.equal(prepared.plan.accounting.maximumAttempts, 1);
  assert.equal(prepared.plan.accounting.dataLeavesDevice, true);
  assert.equal(prepared.plan.estimate.kind, "unavailable");
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(secret, "u"));

  const consent = {
    version: 1 as const,
    authorizationId: prepared.plan.authorizationId,
    consentFingerprint: prepared.plan.consentFingerprint,
    token: prepared.plan.token,
    reviewed: true as const,
  };
  const started = await context.service.start(
    {
      workflowId: "workflow-1",
      expectedRevision: 1,
      scope: { kind: "all" },
      executionMode: "gemini",
      providerConsent: consent,
    },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const journal = await waitForTerminal(context.journals, started.run.runId);
  assert.equal(fetchCount, 1);
  assert.equal(
    projectCreateImagesRun(journal).terminal?.status,
    "succeeded",
    JSON.stringify({
      projection: projectCreateImagesRun(journal),
      assets: [...context.assets.available.values()],
      reservations: context.references.reservations.map((item) => [...item.next]),
    }),
  );
  assert.equal(journal.providerAuthorization?.executionMode, "gemini");
  assert.equal(journal.providerAuthorization?.maximumAttempts, 1);
  assert.equal(journal.providerAuthorization?.credentialRecordId.startsWith("google-"), true);
  const serialized = JSON.stringify(journal);
  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.doesNotMatch(serialized, new RegExp(prepared.plan.token, "u"));
  assert.ok(
    journal.events.some(
      (event) =>
        event.type === "node-submission-prepared" &&
        event.providerId === "gemini" &&
        event.modelId === "gemini-3.1-flash-image",
    ),
  );
  const generatedAsset = [...context.assets.available.values()][0];
  assert.equal(
    generatedAsset?.origin.kind === "provider" ? generatedAsset.origin.providerId : undefined,
    "gemini",
  );
  await waitForAsync(async () => (await context.service.activeRuns()).length === 0);

  const replay = await context.service.start(
    {
      workflowId: "workflow-1",
      expectedRevision: 1,
      scope: { kind: "all" },
      executionMode: "gemini",
      providerConsent: consent,
    },
    () => true,
  );
  assert.equal(replay.status, "invalid");
  assert.equal(runCount, 1);
  assert.equal(fetchCount, 1);
});

test("Gemini consent accounts for a durable reference and submits only its bounded bytes", async (t) => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const pngBytes = Uint8Array.from(Buffer.from(pngBase64, "base64"));
  const assetId = createHash("sha256").update(pngBytes).digest("hex");
  const document = workflow();
  document.nodes.splice(1, 0, {
    id: "reference-1",
    type: "image-input",
    position: { x: 0, y: 100 },
    data: { assetId, label: "Reference" },
  });
  document.edges.splice(1, 0, {
    id: "edge-reference",
    source: "reference-1",
    sourcePort: "image",
    target: "generate-1",
    targetPort: "references",
  });
  document.assetRefs = [assetId];
  let requestBody = "";
  const context = await harness(t, {
    document,
    createRunId: () => "gemini-reference-run",
    resolveGeminiAuth: async () => ({ auth: { apiKey: "reference-test-key" }, source: "test" }),
    createGeminiProvider: () =>
      new GeminiImageProvider({
        fetch: (async (_url, init) => {
          requestBody = String(init?.body ?? "");
          return new Response(
            JSON.stringify({
              status: "completed",
              steps: [
                {
                  type: "model_output",
                  content: [{ type: "image", mime_type: "image/png", data: pngBase64 }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof globalThis.fetch,
      }),
  });
  const reference: AssetMetadataDto = {
    assetId,
    mediaType: "image/png",
    byteLength: pngBytes.byteLength,
    width: 1,
    height: 1,
    createdAt: NOW,
    origin: { kind: "import" },
    referenceCount: 1,
    thumbnailSizes: [],
  };
  context.assets.available.set(assetId, reference);
  context.assets.bytesById.set(assetId, pngBytes);
  const prepared = await context.service.prepareGeminiRun({
    workflowId: document.id,
    expectedRevision: document.revision,
    scope: { kind: "all" },
  });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  assert.equal(prepared.plan.accounting.referenceImageCount, 1);
  assert.equal(prepared.plan.accounting.referenceImageBytes, pngBytes.byteLength);
  const started = await context.service.start(
    {
      workflowId: document.id,
      expectedRevision: document.revision,
      scope: { kind: "all" },
      executionMode: "gemini",
      providerConsent: {
        version: 1,
        authorizationId: prepared.plan.authorizationId,
        consentFingerprint: prepared.plan.consentFingerprint,
        token: prepared.plan.token,
        reviewed: true,
      },
    },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  assert.equal(
    projectCreateImagesRun(await waitForTerminal(context.journals, started.run.runId)).terminal
      ?.status,
    "succeeded",
  );
  assert.match(requestBody, new RegExp(pngBase64.replace(/[+]/gu, "\\+"), "u"));
  assert.doesNotMatch(requestBody, /reference-test-key/u);
});

test("Gemini credential drift after durable preparation fails before transport", async (t) => {
  let authReads = 0;
  let fetchCount = 0;
  const context = await harness(t, {
    createRunId: () => "gemini-drift-run",
    resolveGeminiAuth: async () => ({
      auth: { apiKey: authReads++ < 2 ? "reviewed-key" : "changed-key" },
      source: "test",
    }),
    createGeminiProvider: () =>
      new GeminiImageProvider({
        fetch: (async () => {
          fetchCount += 1;
          throw new Error("must not execute");
        }) as typeof globalThis.fetch,
      }),
  });
  const prepared = await context.service.prepareGeminiRun({
    workflowId: "workflow-1",
    expectedRevision: 1,
    scope: { kind: "all" },
  });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  const started = await context.service.start(
    {
      workflowId: "workflow-1",
      expectedRevision: 1,
      scope: { kind: "all" },
      executionMode: "gemini",
      providerConsent: {
        version: 1,
        authorizationId: prepared.plan.authorizationId,
        consentFingerprint: prepared.plan.consentFingerprint,
        token: prepared.plan.token,
        reviewed: true,
      },
    },
    () => true,
  );
  assert.equal(started.status, "started");
  if (started.status !== "started") return;
  const journal = await waitForTerminal(context.journals, started.run.runId);
  assert.equal(fetchCount, 0);
  assert.equal(projectCreateImagesRun(journal).terminal?.status, "failed");
  assert.ok(journal.events.some((event) => event.type === "node-submission-prepared"));
  assert.equal(
    journal.events.some((event) => event.type === "node-submission-accepted"),
    false,
  );
});
