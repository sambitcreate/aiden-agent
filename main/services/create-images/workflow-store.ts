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
  assets: Pick<StudioAssetStore, "retain" | "replaceHolder" | "releaseAllForHolder">;
  now?: () => number;
  newId?: () => string;
  /** Test seam for the atomic JSON writer. */
  writeJson?: typeof writeJsonAtomic;
  /** Receives non-fatal failures (a cache write that did not land). The runtime (CI-1.6) wires this to the dev log; the default drops them. */
  reportIssue?: (message: string, error: unknown) => void;
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

/** What the store remembers of each indexed document, so hot reads never re-parse files. */
interface DocumentFacts {
  nodeIds: ReadonlySet<string>;
  imageInputs: readonly string[];
}

function factsOf(doc: WorkflowDocV1): DocumentFacts {
  return { nodeIds: new Set(doc.nodes.map((node) => node.id)), imageInputs: [...new Set(imageInputAssets(doc))].sort() };
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
function truncateCodePoints(text: string, max: number): string {
  let result = "";
  for (const character of text) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result;
}

/** `writeJsonAtomic` staging names: `.<target>.<uuid>.tmp`. */
const STAGED_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STAGED_DOCUMENT = new RegExp(`^\\..+\\.json\\.${STAGED_UUID}\\.tmp$`, "u");
const STAGED_INDEX = new RegExp(`^\\.index\\.json\\.${STAGED_UUID}\\.tmp$`, "u");

type LoadedDocument = { kind: "ok"; doc: WorkflowDocV1 } | { kind: "missing" } | { kind: "unreadable" };

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
  private facts = new Map<string, DocumentFacts>();
  /** Files that exist but cannot be parsed: left in place, never listed, their holds left alone. */
  private unreadable = new Set<string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private indexWrites: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly writeJson: typeof writeJsonAtomic;
  private readonly reportIssue: (message: string, error: unknown) => void;

  constructor(private readonly options: ImageWorkflowStoreOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.writeJson = options.writeJson ?? writeJsonAtomic;
    this.reportIssue = options.reportIssue ?? (() => undefined);
  }

  async initialize(): Promise<void> {
    this.root = this.options.root();
    await fs.mkdir(this.workflowsDirectory(), { recursive: true, mode: 0o700 });
    const names = await fs.readdir(this.workflowsDirectory());
    // Nothing writes before initialize finishes, so any staging file left here is from a crash.
    await this.sweepStaged(this.workflowsDirectory(), names, STAGED_DOCUMENT);
    await this.sweepStaged(this.root, await fs.readdir(this.root), STAGED_INDEX);
    const ids = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => IMAGE_WORKFLOW_ID_PATTERN.test(id));
    // The summaries always come from the documents: a cached index.json can be
    // stale when its write failed after a document landed, and the file names
    // alone cannot tell. Every well-formed document is indexed, graph-invalid
    // ones included, so a broken workflow stays visible and deletable; opening
    // it is what is refused.
    this.index = new Map();
    this.facts = new Map();
    this.unreadable = new Set();
    for (const id of ids) {
      const loaded = await this.loadDocument(id);
      if (loaded.kind === "ok") this.remember(loaded.doc);
      else if (loaded.kind === "unreadable") this.unreadable.add(id);
    }
    if (this.unreadable.size > 0) {
      // Ids only: a parse error message can quote the file's contents, which include prompts.
      this.reportIssue(
        `${this.unreadable.size} image workflow ${this.unreadable.size === 1 ? "file" : "files"} could not be read and ${this.unreadable.size === 1 ? "was" : "were"} left in place.`,
        { workflowIds: [...this.unreadable].sort() },
      );
    }
    const cached = await this.readIndex();
    const current = this.list();
    const matches =
      cached !== null &&
      cached.length === current.length &&
      cached.every((entry) => {
        const fresh = this.index.get(entry.id);
        return fresh !== undefined && fresh.title === entry.title && fresh.revision === entry.revision && fresh.updatedAt === entry.updatedAt;
      });
    if (!matches) await this.writeIndex();
  }

  list(): WorkflowSummary[] {
    return [...this.index.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * Distinct Image Input assets per workflow, from memory kept in step with every write. A
   * workflow whose graph is invalid still counts, because its images are still held; an
   * unreadable file does not.
   */
  async imageInputAssets(): Promise<Record<string, string[]>> {
    const found: Record<string, string[]> = {};
    for (const [id, facts] of this.facts) if (facts.imageInputs.length > 0) found[id] = [...facts.imageInputs];
    return found;
  }

  /** The node ids the stored document has now; undefined once the workflow is gone. Synchronous, for retention. */
  nodeIds(workflowId: string): ReadonlySet<string> | undefined {
    return this.facts.get(workflowId)?.nodeIds;
  }

  /** Ids whose file exists but cannot be parsed. Their holds are kept, in case the file is repaired. */
  unreadableIds(): ReadonlySet<string> {
    return this.unreadable;
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
      // Crash-safe order: add holds for the new document's assets (a missing asset
      // rejects here, before any write), commit the document, and only then shrink
      // membership to exact. A failed or interrupted write therefore never leaves
      // the still-persisted old document referencing an unheld asset.
      const held = this.retainAssets(next);
      if (held) return held;
      await this.publish(next);
      this.settleHolds(next);
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
      title: `${truncateCodePoints(source.title, IMAGE_WORKFLOW_LIMITS.maxTitleLength - suffix.length)}${suffix}`,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.serialize(copy.id, async () => {
      const held = this.retainAssets(copy);
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
      // Only indexed ids: callers' busy checks are keyed by the exact id, and on a
      // case-insensitive volume a near-miss id could otherwise name another workflow's file.
      if (!this.index.has(workflowId)) return false;
      await fs.rm(this.file(workflowId), { force: true });
      this.index.delete(workflowId);
      this.facts.delete(workflowId);
      await this.writeIndex();
      this.options.assets.releaseAllForHolder({ kind: "images-workflow", id: workflowId });
      return true;
    });
  }

  /** Additive holds; a missing asset rejects before anything is written. */
  private retainAssets(doc: WorkflowDocV1): Extract<WorkflowSaveResult, { ok: false }> | null {
    try {
      this.options.assets.retain({ kind: "images-workflow", id: doc.id }, imageInputAssets(doc));
      return null;
    } catch (error) {
      if (error instanceof StudioAssetError && error.code === "not_found") {
        return { ok: false, reason: "invalid", issues: ["An image in this workflow is no longer available."] };
      }
      throw error;
    }
  }

  /** After the document is committed: drop holds the document no longer references. */
  private settleHolds(doc: WorkflowDocV1): void {
    try {
      this.options.assets.replaceHolder({ kind: "images-workflow", id: doc.id }, imageInputAssets(doc));
    } catch (error) {
      // Holds are a superset until the next save; the committed document is not undone.
      this.reportIssue(`Could not trim image holds for workflow ${doc.id}.`, error);
    }
  }

  /** The document write is the commit point; the index is only a cache of it. */
  private async publish(doc: WorkflowDocV1): Promise<void> {
    try {
      await this.writeJson(this.file(doc.id), doc, JSON_FILE);
    } catch (error) {
      // The atomic write can fail after the document was renamed into place
      // (the directory flush). The document then exists and is what readers
      // see, so it counts as committed: dropping it from the index (or its
      // holds) would desync the library from the files.
      const stored = await this.readDocument(doc.id);
      if (stored === null || stored.revision !== doc.revision || stored.updatedAt !== doc.updatedAt) throw error;
      this.reportIssue(`Workflow ${doc.id} was written but could not be flushed to disk.`, error);
    }
    this.remember(doc);
    await this.writeIndex();
  }

  private remember(doc: WorkflowDocV1): void {
    this.index.set(doc.id, summary(doc));
    this.facts.set(doc.id, factsOf(doc));
    this.unreadable.delete(doc.id);
  }

  private async sweepStaged(directory: string, names: readonly string[], pattern: RegExp): Promise<void> {
    for (const name of names) {
      if (!pattern.test(name)) continue;
      await fs.rm(path.join(directory, name), { force: true }).catch((error: unknown) =>
        this.reportIssue("Could not remove a leftover image workflow staging file.", error),
      );
    }
  }

  /** Shape-parses the stored file. A file that cannot be parsed is left in place and reads as absent. */
  private async readDocument(workflowId: string): Promise<WorkflowDocV1 | null> {
    const loaded = await this.loadDocument(workflowId);
    return loaded.kind === "ok" ? loaded.doc : null;
  }

  private async loadDocument(workflowId: string): Promise<LoadedDocument> {
    if (!IMAGE_WORKFLOW_ID_PATTERN.test(workflowId)) return { kind: "missing" };
    let text: string;
    try {
      text = await fs.readFile(this.file(workflowId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
    try {
      const parsed = parseWorkflowDocV1(JSON.parse(text));
      return parsed.ok && parsed.value.id === workflowId ? { kind: "ok", doc: parsed.value } : { kind: "unreadable" };
    } catch {
      return { kind: "unreadable" };
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
    // A failed cache write is reported, never thrown: the index is rebuilt from the documents.
    const write = this.indexWrites
      .then(() => this.writeJson(this.indexFile(), this.list(), JSON_FILE))
      .catch((error: unknown) => this.reportIssue("Could not write the image workflow index.", error));
    this.indexWrites = write;
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
