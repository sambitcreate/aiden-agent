import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { validateWorkflowGraph } from "../../../renderer/shared/images/ports.js";
import {
  IMAGE_WORKFLOW_ID_PATTERN,
  IMAGE_WORKFLOW_LIMITS,
  type ImageModelRef,
  type WorkflowDocV1,
  type WorkflowSummary,
} from "../../../renderer/shared/images/schema.js";
import { workflowFromTemplate, type ImageWorkflowTemplate } from "../../../renderer/shared/images/templates.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { StudioAssetError } from "../studio-assets/contract.js";
import type { StudioAssetStore } from "../studio-assets/store.js";
import { parseWorkflowDocV1 } from "./workflow-schema.js";

export type WorkflowSaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict" | "invalid" | "not-found"; issues?: string[] };

export interface ImageWorkflowStoreOptions {
  root: () => string;
  assets: Pick<StudioAssetStore, "replaceHolder" | "releaseAllForHolder">;
  now?: () => number;
  newId?: () => string;
}

/**
 * A stored document that is well-formed but whose graph is invalid (a cycle, a
 * dangling edge, a bad port connection), for example after a hand edit. The
 * store refuses to open it and never repairs it; the file stays untouched.
 */
export class ImageWorkflowLoadError extends Error {
  readonly code = "invalid_graph" as const;

  constructor(
    readonly workflowId: string,
    readonly issues: string[],
  ) {
    super(`This workflow can't be opened because its connections are invalid. ${issues.join(" ")}`);
    this.name = "ImageWorkflowLoadError";
  }
}

const JSON_FILE = { mode: 0o600, mkdirMode: 0o700 } as const;

function summary(doc: WorkflowDocV1): WorkflowSummary {
  return { id: doc.id, title: doc.title, revision: doc.revision, updatedAt: doc.updatedAt };
}

function imageInputAssets(doc: WorkflowDocV1): string[] {
  return doc.nodes.flatMap((node) => (node.type === "image-input" && node.data.assetId ? [node.data.assetId] : []));
}

/** Distinct graph problems in reading order; a document with many bad edges repeats the same sentence. */
function graphProblems(doc: WorkflowDocV1): string[] {
  return [...new Set(validateWorkflowGraph(doc).map((issue) => issue.message))];
}

function isSummary(value: unknown): value is WorkflowSummary {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    IMAGE_WORKFLOW_ID_PATTERN.test(entry.id) &&
    typeof entry.title === "string" &&
    Number.isSafeInteger(entry.revision) &&
    Number.isSafeInteger(entry.updatedAt)
  );
}

/** One JSON file per workflow; the index is a rebuildable cache of their summaries. */
export class ImageWorkflowStore {
  private root = "";
  private index = new Map<string, WorkflowSummary>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private indexWrites: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: ImageWorkflowStoreOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    this.root = this.options.root();
    await fs.mkdir(this.workflowsDirectory(), { recursive: true, mode: 0o700 });
    const ids = (await fs.readdir(this.workflowsDirectory()))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => IMAGE_WORKFLOW_ID_PATTERN.test(id));
    const cached = await this.readIndex();
    const matches =
      cached !== null &&
      cached.length === ids.length &&
      cached.every((entry) => ids.includes(entry.id));
    if (matches) {
      this.index = new Map(cached.map((entry) => [entry.id, entry]));
      return;
    }
    // Rebuilding indexes every well-formed document, graph-invalid ones included,
    // so a broken workflow stays visible and deletable; opening it is what is refused.
    this.index = new Map();
    for (const id of ids) {
      const doc = await this.readDocument(id);
      if (doc) this.index.set(id, summary(doc));
    }
    await this.writeIndex();
  }

  list(): WorkflowSummary[] {
    return [...this.index.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async create(
    template: ImageWorkflowTemplate,
    options: { title?: string; model?: ImageModelRef } = {},
  ): Promise<WorkflowDocV1> {
    const doc = workflowFromTemplate({
      template,
      workflowId: this.newId(),
      now: this.now(),
      nextId: this.newId,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
    const parsed = parseWorkflowDocV1(doc);
    if (!parsed.ok || graphProblems(parsed.value).length > 0) throw new Error("The workflow template is invalid.");
    await this.serialize(doc.id, () => this.publish(parsed.value));
    return parsed.value;
  }

  /**
   * Null when no readable document has this id. Throws `ImageWorkflowLoadError`
   * when the document parses but its graph is invalid.
   */
  async get(workflowId: string): Promise<WorkflowDocV1 | null> {
    const doc = await this.readDocument(workflowId);
    if (!doc) return null;
    const problems = graphProblems(doc);
    if (problems.length > 0) throw new ImageWorkflowLoadError(workflowId, problems);
    return doc;
  }

  save(workflowId: string, baseRevision: number, document: unknown): Promise<WorkflowSaveResult> {
    return this.serialize(workflowId, async () => {
      // Only the stored revision and creation time matter here; the incoming
      // document is what gets validated, so a broken file can be replaced by a valid one.
      const current = await this.readDocument(workflowId);
      if (!current) return { ok: false, reason: "not-found" } as const;
      if (current.revision !== baseRevision) return { ok: false, reason: "conflict" } as const;
      const parsed = parseWorkflowDocV1(document);
      if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues } as const;
      if (parsed.value.id !== workflowId) {
        return { ok: false, reason: "invalid", issues: ["The document belongs to another workflow."] } as const;
      }
      const next: WorkflowDocV1 = {
        ...parsed.value,
        revision: baseRevision + 1,
        createdAt: current.createdAt,
        updatedAt: Math.max(this.now(), current.updatedAt + 1),
      };
      const problems = graphProblems(next);
      if (problems.length > 0) return { ok: false, reason: "invalid", issues: problems } as const;
      const held = this.hold(next);
      if (held) return held;
      await this.publish(next);
      return { ok: true, revision: next.revision } as const;
    });
  }

  rename(workflowId: string, title: string): Promise<WorkflowSaveResult> {
    return this.serialize(workflowId, async () => {
      let current: WorkflowDocV1 | null;
      try {
        current = await this.get(workflowId);
      } catch (error) {
        if (error instanceof ImageWorkflowLoadError) return { ok: false, reason: "invalid", issues: error.issues } as const;
        throw error;
      }
      if (!current) return { ok: false, reason: "not-found" } as const;
      const next = { ...current, title, revision: current.revision + 1, updatedAt: Math.max(this.now(), current.updatedAt + 1) };
      const parsed = parseWorkflowDocV1(next);
      if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues } as const;
      await this.publish(parsed.value);
      return { ok: true, revision: parsed.value.revision } as const;
    });
  }

  async duplicate(workflowId: string): Promise<WorkflowDocV1 | null> {
    const source = await this.get(workflowId);
    if (!source) return null;
    const now = this.now();
    const suffix = " copy";
    const copy: WorkflowDocV1 = {
      ...structuredClone(source),
      id: this.newId(),
      title: `${source.title.slice(0, IMAGE_WORKFLOW_LIMITS.maxTitleLength - suffix.length)}${suffix}`,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.serialize(copy.id, async () => {
      const held = this.hold(copy);
      if (held) throw new Error(held.issues?.[0] ?? "An image in this workflow is no longer available.");
      try {
        await this.publish(copy);
      } catch (error) {
        this.options.assets.releaseAllForHolder({ kind: "images-workflow", id: copy.id });
        throw error;
      }
      return copy;
    });
  }

  delete(workflowId: string): Promise<boolean> {
    return this.serialize(workflowId, async () => {
      if (!this.index.has(workflowId)) return false;
      await fs.rm(this.file(workflowId), { force: true });
      this.index.delete(workflowId);
      await this.writeIndex();
      this.options.assets.releaseAllForHolder({ kind: "images-workflow", id: workflowId });
      return true;
    });
  }

  /** Exact holder membership; a missing asset rejects the save before anything is written. */
  private hold(doc: WorkflowDocV1): Extract<WorkflowSaveResult, { ok: false }> | null {
    try {
      this.options.assets.replaceHolder({ kind: "images-workflow", id: doc.id }, imageInputAssets(doc));
      return null;
    } catch (error) {
      if (error instanceof StudioAssetError && error.code === "not_found") {
        return { ok: false, reason: "invalid", issues: ["An image in this workflow is no longer available."] };
      }
      throw error;
    }
  }

  private async publish(doc: WorkflowDocV1): Promise<void> {
    await writeJsonAtomic(this.file(doc.id), doc, JSON_FILE);
    this.index.set(doc.id, summary(doc));
    await this.writeIndex();
  }

  /** Shape-parses the stored file. A file that cannot be parsed is left in place and reads as absent. */
  private async readDocument(workflowId: string): Promise<WorkflowDocV1 | null> {
    if (!IMAGE_WORKFLOW_ID_PATTERN.test(workflowId)) return null;
    let text: string;
    try {
      text = await fs.readFile(this.file(workflowId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = parseWorkflowDocV1(JSON.parse(text));
      return parsed.ok && parsed.value.id === workflowId ? parsed.value : null;
    } catch {
      return null;
    }
  }

  private async readIndex(): Promise<WorkflowSummary[] | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.indexFile(), "utf8"));
      return Array.isArray(value) && value.every(isSummary) ? value : null;
    } catch {
      return null;
    }
  }

  private writeIndex(): Promise<void> {
    const write = this.indexWrites.then(() => writeJsonAtomic(this.indexFile(), this.list(), JSON_FILE));
    this.indexWrites = write.catch(() => undefined);
    return write;
  }

  private serialize<T>(workflowId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(workflowId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    this.chains.set(workflowId, tail);
    void tail.then(() => {
      if (this.chains.get(workflowId) === tail) this.chains.delete(workflowId);
    });
    return run;
  }

  private workflowsDirectory(): string {
    return path.join(this.root, "workflows");
  }

  private file(workflowId: string): string {
    return path.join(this.workflowsDirectory(), `${workflowId}.json`);
  }

  private indexFile(): string {
    return path.join(this.root, "index.json");
  }
}
