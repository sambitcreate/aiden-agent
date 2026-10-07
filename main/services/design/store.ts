// File-backed Design Studio projects: one directory per project, the manifest
// as the commit point, immutable revision files, one serial gate per project.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncDirectory, writeFileAtomic, writeJsonAtomic } from "../durable-fs.js";
import {
  MAX_DESIGN_MANIFEST_BYTES,
  MAX_DESIGN_PROJECTS,
  MAX_DESIGN_TOTAL_BYTES,
} from "../../../renderer/shared/design/limits.js";
import { own } from "../../../renderer/shared/design/own.js";
import type {
  DesignDeletePreview,
  DesignModelRef,
  DesignMutateResult,
  DesignProjectManifestV1,
  DesignProjectOp,
  DesignProjectSnapshot,
  DesignProjectSummary,
  DesignRunRequest,
} from "../../../renderer/shared/design/types.js";
import { createDesignProjectManifest, parseDesignProjectManifestV1 } from "./manifest-core.js";
import {
  applyDesignProjectOp,
  assertDesignProjectIdle,
  buildDesignProjectCopy,
  unreadableDesignDeletePreview,
} from "./ops-core.js";
import { isDesignId } from "./ops-parse.js";
import { DesignProjectGate } from "./project-gate.js";
import {
  DesignStoreError,
  acceptDesignArtifact,
  assertDesignManifestWritable,
  beginDesignRun,
  designDeletePreview,
  designProjectBytes,
  designProjectSummary,
  finishDesignRun,
  markDesignRevisionMissing,
  orphanRevisionIds,
  planDesignRun,
  reconcileDesignManifest,
  revisionIdForToolCall,
  type DesignRunOutcome,
  type DesignStorageTotals,
} from "./store-core.js";

export interface DesignChatPort {
  exists(chatId: string): Promise<boolean>;
  create(chatId: string, projectId: string): Promise<void>;
  remove(chatId: string): Promise<void>;
}

export interface DesignRunArtifact {
  toolCallId: string;
  title: string;
  html: string;
  model: DesignModelRef;
  replacesRevisionId?: string;
}

export interface DesignProjectStoreOptions {
  root: () => Promise<string>;
  chats: DesignChatPort;
  onChanged?: (projectId: string) => void;
  onError?: (message: string, error: unknown) => void;
  now?: () => number;
  newId?: () => string;
  /** Fault-injection seams for tests; production never passes them. */
  io?: { writeRevision?: typeof writeFileAtomic; writeManifest?: typeof writeJsonAtomic };
}

type ProjectEntry =
  | { kind: "ok"; manifest: DesignProjectManifestV1 }
  | { kind: "unreadable"; id: string; updatedAt: number };

const LIBRARY_GATE = "#library";
const DEFAULT_TITLE = "Untitled design";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const REVISION_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.html$/u;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isStagingLeftover(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".tmp");
}

export class DesignProjectStore {
  private readonly gate = new DesignProjectGate();
  private readonly entries = new Map<string, ProjectEntry>();
  private rootPath: string | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly writeRevisionFile: typeof writeFileAtomic;
  private readonly writeManifestFile: typeof writeJsonAtomic;

  constructor(private readonly options: DesignProjectStoreOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.writeRevisionFile = options.io?.writeRevision ?? writeFileAtomic;
    this.writeManifestFile = options.io?.writeManifest ?? writeJsonAtomic;
  }

  /** Load every manifest, reconcile crash leftovers, and report deletions to resume. */
  async initialize(): Promise<{ deleting: string[] }> {
    const root = await this.options.root();
    await fs.mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
    this.rootPath = root;
    this.entries.clear();
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (isDesignId(entry.name)) {
        await this.loadProject(entry.name);
      } else if (isStagingLeftover(entry.name)) {
        // A duplicate that never reached its final name.
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
    return {
      deleting: this.manifests().filter((manifest) => manifest.state === "deleting").map((manifest) => manifest.id),
    };
  }

  list(): DesignProjectSummary[] {
    const summaries: DesignProjectSummary[] = [];
    for (const entry of this.entries.values()) {
      if (entry.kind === "unreadable") {
        summaries.push({
          id: entry.id,
          title: "Unreadable project",
          updatedAt: entry.updatedAt,
          screenCount: 0,
          bytes: 0,
          health: "unreadable",
        });
      } else if (entry.manifest.state === "active") {
        summaries.push(designProjectSummary(entry.manifest));
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  get(projectId: string): DesignProjectSnapshot | undefined {
    const entry = this.entries.get(projectId);
    return entry?.kind === "ok" && entry.manifest.state === "active"
      ? structuredClone(entry.manifest)
      : undefined;
  }

  revisionIdForToolCall(projectId: string, toolCallId: string): string | undefined {
    const entry = this.entries.get(projectId);
    return entry?.kind === "ok" ? revisionIdForToolCall(entry.manifest, toolCallId) : undefined;
  }

  previewDelete(projectId: string): DesignDeletePreview {
    if (this.entries.get(projectId)?.kind === "unreadable") return unreadableDesignDeletePreview();
    return designDeletePreview(this.requireActive(projectId));
  }

  create(input: { title?: string } = {}): Promise<DesignProjectSnapshot> {
    return this.gate.run(LIBRARY_GATE, async () => {
      this.assertProjectCapacity();
      const manifest = createDesignProjectManifest({
        id: this.newId(),
        chatId: this.newId(),
        title: input.title ?? DEFAULT_TITLE,
        now: this.now(),
      });
      await fs.mkdir(this.projectDir(manifest.id), { recursive: true, mode: DIRECTORY_MODE });
      await this.commit(manifest);
      await this.createChatOrDefer(manifest);
      return structuredClone(manifest);
    });
  }

  /**
   * The copy is built whole beside the library and renamed into place, so a crash leaves
   * either the finished project or a staging directory the next start removes.
   */
  duplicate(projectId: string): Promise<DesignProjectSnapshot> {
    return this.gate.run(LIBRARY_GATE, () =>
      this.gate.run(projectId, async () => {
        const source = this.requireActive(projectId);
        assertDesignProjectIdle(source, "duplicate");
        this.assertProjectCapacity();
        if (this.totalsExcluding(undefined).otherProjectsBytes + designProjectBytes(source) > MAX_DESIGN_TOTAL_BYTES) {
          throw new DesignStoreError("quota", "Duplicating this project would exceed the 2 GiB design storage limit.");
        }
        const files = await this.readVerifiedRevisions(source);
        const { manifest: copy, revisionIds } = buildDesignProjectCopy(source, {
          newId: this.newId,
          now: this.now(),
          intactRevisionIds: new Set(files.keys()),
        });
        assertDesignManifestWritable(copy);
        const staging = path.join(this.root(), `.${copy.id}.duplicate.tmp`);
        try {
          for (const [revisionId, bytes] of files) {
            await this.writeRevisionFile(path.join(staging, "revisions", `${revisionIds.get(revisionId)}.html`), bytes, {
              mode: FILE_MODE,
              mkdirMode: DIRECTORY_MODE,
            });
          }
          await this.writeManifest(copy, staging);
          await fs.rename(staging, this.projectDir(copy.id));
        } catch (error) {
          await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        this.entries.set(copy.id, { kind: "ok", manifest: copy });
        await syncDirectory(this.root()).catch((error: unknown) =>
          this.options.onError?.("Could not flush the design library after duplicating a project.", error),
        );
        this.options.onChanged?.(copy.id);
        await this.createChatOrDefer(copy);
        return structuredClone(copy);
      }),
    );
  }

  mutate(projectId: string, expectedRevision: number, op: DesignProjectOp): Promise<DesignMutateResult> {
    return this.gate.run(projectId, async () => {
      const current = this.requireActive(projectId);
      if (current.revision !== expectedRevision) {
        return {
          ok: false,
          reason: "stale",
          message: "This project changed. Showing the latest version.",
          snapshot: structuredClone(current),
        };
      }
      try {
        const result = applyDesignProjectOp(current, op, this.now());
        await this.commit(result.manifest, result.deletedRevisionIds);
        return { ok: true, snapshot: structuredClone(result.manifest) };
      } catch (error) {
        // A refusal changes nothing: commit installs the new manifest only after it is on disk.
        if (error instanceof DesignStoreError && (error.code === "invalid" || error.code === "quota" || error.code === "busy")) {
          return { ok: false, reason: error.code, message: error.message, snapshot: structuredClone(current) };
        }
        throw error;
      }
    });
  }

  delete(projectId: string, expectedRevision: number): Promise<void> {
    return this.gate.run(projectId, async () => {
      const current = this.requireActive(projectId);
      if (current.revision !== expectedRevision) {
        throw new DesignStoreError("stale", "This project changed. Review it again before deleting.");
      }
      assertDesignProjectIdle(current, "delete");
      const deleting: DesignProjectManifestV1 = {
        ...structuredClone(current),
        state: "deleting",
        revision: current.revision + 1,
        updatedAt: Math.max(current.updatedAt, this.now()),
      };
      await this.commit(deleting);
      await this.finishDeletion(deleting);
    });
  }

  /**
   * Delete a project whose manifest cannot be read, after the caller showed the unknown-contents
   * preview and the user confirmed. This is the only way an unreadable project is ever removed.
   * Its hidden chat, if it has one, cannot be found without the manifest and is left as it is.
   */
  async deleteUnreadable(projectId: string): Promise<void> {
    // Validate before any path is joined: the id arrives from the renderer.
    if (!isDesignId(projectId)) throw new DesignStoreError("invalid", "That is not a design project.");
    await this.gate.run(projectId, async () => {
      const entry = this.entries.get(projectId);
      if (!entry) throw new DesignStoreError("not_found", "This design project no longer exists.");
      if (entry.kind !== "unreadable") {
        throw new DesignStoreError("invalid", "This project can be opened. Delete it from the library instead.");
      }
      await fs.rm(this.projectDir(projectId), { recursive: true, force: true });
      this.entries.delete(projectId);
      this.options.onChanged?.(projectId);
    });
  }

  /** Startup: finish every cascade a crash or failure interrupted. */
  async resumeDeletions(): Promise<void> {
    for (const manifest of this.manifests().filter((candidate) => candidate.state === "deleting")) {
      await this.gate.run(manifest.id, () => this.finishDeletion(manifest));
    }
  }

  /** A crash after a create's commit can leave a project without its chat; recreate it under the same id. */
  ensureChat(projectId: string): Promise<string> {
    return this.gate.run(projectId, async () => {
      const current = this.requireActive(projectId);
      if (!(await this.options.chats.exists(current.chatId))) {
        await this.options.chats.create(current.chatId, projectId);
      }
      return current.chatId;
    });
  }

  beginRun(
    projectId: string,
    input: { runId: string; turnId: string; request: DesignRunRequest; promptMessageId?: string },
  ): Promise<{ cap: number }> {
    return this.gate.run(projectId, async () => {
      const current = this.requireActive(projectId);
      // Under the gate, the one-running-run check admits one of two concurrent Resumes.
      const plan = planDesignRun(current, input.request);
      await this.commit(beginDesignRun(current, { ...input, plan, directionSetId: this.newId(), now: this.now() }));
      return { cap: plan.cap };
    });
  }

  acceptRunArtifact(projectId: string, runId: string, artifact: DesignRunArtifact): Promise<{ revisionId: string }> {
    return this.gate.run(projectId, async () => {
      const current = this.requireActive(projectId);
      const bytes = Buffer.from(artifact.html, "utf8");
      const revisionId = this.newId();
      const result = acceptDesignArtifact(
        current,
        {
          runId,
          toolCallId: artifact.toolCallId,
          title: artifact.title,
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
          model: artifact.model,
          ...(artifact.replacesRevisionId === undefined ? {} : { replacesRevisionId: artifact.replacesRevisionId }),
        },
        { revisionId, screenId: this.newId(), nodeId: this.newId() },
        this.totalsExcluding(projectId),
        this.now(),
      );
      // A manifest that would be refused must not leave its revision file behind.
      assertDesignManifestWritable(result.manifest);
      // Revision file first, manifest second. The manifest is the commit point,
      // and startup collects any file the manifest does not reference.
      await this.writeRevisionFile(this.revisionPath(projectId, revisionId), bytes, {
        mode: FILE_MODE,
        mkdirMode: DIRECTORY_MODE,
      });
      await this.commit(result.manifest, result.deletedRevisionIds);
      return { revisionId };
    });
  }

  finishRun(projectId: string, runId: string, outcome: DesignRunOutcome): Promise<DesignProjectSnapshot | undefined> {
    return this.gate.run(projectId, async () => {
      const entry = this.entries.get(projectId);
      if (entry?.kind !== "ok" || entry.manifest.state !== "active") return undefined;
      const next = finishDesignRun(entry.manifest, runId, outcome, this.now());
      if (!next) return undefined;
      await this.commit(next);
      return structuredClone(next);
    });
  }

  /** Read one revision, verifying size and digest; a mismatch is recorded as missing. */
  readRevision(projectId: string, revisionId: string): Promise<{ html: string; bytes: number; title: string }> {
    return this.gate.run(projectId, async () => {
      const current = this.requireActive(projectId);
      const revision = own(current.revisions, revisionId);
      if (!revision) throw new DesignStoreError("not_found", "That revision no longer exists.");
      if (revision.state === "missing") {
        throw new DesignStoreError("not_found", "This revision's file is missing or damaged.");
      }
      let bytes: Buffer | undefined;
      try {
        bytes = await fs.readFile(this.revisionPath(projectId, revisionId));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (!bytes || bytes.byteLength !== revision.bytes || sha256(bytes) !== revision.sha256) {
        await this.commit(markDesignRevisionMissing(current, revisionId, this.now()));
        throw new DesignStoreError("not_found", "This revision's file is missing or damaged.");
      }
      return { html: bytes.toString("utf8"), bytes: bytes.byteLength, title: revision.title };
    });
  }

  private root(): string {
    if (this.rootPath === undefined) {
      throw new DesignStoreError("unavailable", "Design projects are unavailable. Restart Aiden to try again.");
    }
    return this.rootPath;
  }

  private projectDir(projectId: string): string {
    if (!isDesignId(projectId)) throw new DesignStoreError("invalid", "That is not a design project.");
    return path.join(this.root(), projectId);
  }

  private revisionPath(projectId: string, revisionId: string): string {
    if (!isDesignId(revisionId)) throw new DesignStoreError("invalid", "That is not a design revision.");
    return path.join(this.projectDir(projectId), "revisions", `${revisionId}.html`);
  }

  private manifests(): DesignProjectManifestV1[] {
    return [...this.entries.values()].flatMap((entry) => (entry.kind === "ok" ? [entry.manifest] : []));
  }

  private requireActive(projectId: string): DesignProjectManifestV1 {
    const entry = this.entries.get(projectId);
    if (entry?.kind !== "ok" || entry.manifest.state !== "active") {
      throw new DesignStoreError("not_found", "This design project no longer exists.");
    }
    return entry.manifest;
  }

  private assertProjectCapacity(): void {
    this.root();
    if (this.entries.size >= MAX_DESIGN_PROJECTS) {
      throw new DesignStoreError("quota", `You have ${MAX_DESIGN_PROJECTS} design projects. Delete one to create another.`);
    }
  }

  private totalsExcluding(projectId: string | undefined): DesignStorageTotals {
    let otherProjectsBytes = 0;
    let largest: { title: string; bytes: number } | undefined;
    for (const manifest of this.manifests()) {
      if (manifest.id === projectId) continue;
      const bytes = designProjectBytes(manifest);
      otherProjectsBytes += bytes;
      if (bytes > 0 && (!largest || bytes > largest.bytes)) largest = { title: manifest.title, bytes };
    }
    return largest ? { otherProjectsBytes, largestOtherProjectTitle: largest.title } : { otherProjectsBytes };
  }

  /** Refuse any manifest the loader would not reopen, then publish it atomically. */
  private async writeManifest(manifest: DesignProjectManifestV1, directory = this.projectDir(manifest.id)): Promise<void> {
    assertDesignManifestWritable(manifest);
    await this.writeManifestFile(path.join(directory, "manifest.json"), manifest, {
      mode: FILE_MODE,
      mkdirMode: DIRECTORY_MODE,
    });
  }

  private async commit(manifest: DesignProjectManifestV1, deletedRevisionIds: readonly string[] = []): Promise<void> {
    await this.writeManifest(manifest);
    this.entries.set(manifest.id, { kind: "ok", manifest });
    for (const revisionId of deletedRevisionIds) {
      // The manifest no longer references the file, so a failure here only leaves an orphan for the next start.
      await fs.rm(this.revisionPath(manifest.id, revisionId), { force: true }).catch((error: unknown) =>
        this.options.onError?.("Could not remove a deleted design file; it is collected at the next start.", error),
      );
    }
    this.options.onChanged?.(manifest.id);
  }

  /** Every listed revision whose file is present and matches its recorded size and digest. */
  private async readVerifiedRevisions(manifest: DesignProjectManifestV1): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>();
    for (const revision of Object.values(manifest.revisions)) {
      if (revision.state === "missing") continue;
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(this.revisionPath(manifest.id, revision.id));
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (bytes.byteLength === revision.bytes && sha256(bytes) === revision.sha256) files.set(revision.id, bytes);
    }
    return files;
  }

  private async createChatOrDefer(manifest: DesignProjectManifestV1): Promise<void> {
    try {
      await this.options.chats.create(manifest.chatId, manifest.id);
    } catch (error) {
      this.options.onError?.(
        "Could not create a design project's conversation; it is created before the first run.",
        error,
      );
    }
  }

  private async finishDeletion(manifest: DesignProjectManifestV1): Promise<void> {
    if (await this.options.chats.exists(manifest.chatId)) await this.options.chats.remove(manifest.chatId);
    await fs.rm(this.projectDir(manifest.id), { recursive: true, force: true });
    this.entries.delete(manifest.id);
    this.options.onChanged?.(manifest.id);
  }

  private async revisionFiles(projectId: string): Promise<Map<string, number>> {
    const directory = path.join(this.projectDir(projectId), "revisions");
    const files = new Map<string, number>();
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (isMissing(error)) return files;
      throw error;
    }
    for (const name of names) {
      const match = REVISION_FILE.exec(name);
      if (match) {
        files.set(match[1]!, (await fs.stat(path.join(directory, name))).size);
      } else if (isStagingLeftover(name)) {
        await fs.rm(path.join(directory, name), { force: true });
      }
    }
    return files;
  }

  private async loadProject(projectId: string): Promise<void> {
    const directory = this.projectDir(projectId);
    for (const name of await fs.readdir(directory)) {
      if (isStagingLeftover(name)) await fs.rm(path.join(directory, name), { force: true });
    }
    const files = await this.revisionFiles(projectId);
    const manifestPath = path.join(directory, "manifest.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A create that crashed before its first commit leaves an empty directory.
      if (files.size === 0) {
        await fs.rm(directory, { recursive: true, force: true });
        return;
      }
      this.entries.set(projectId, {
        kind: "unreadable",
        id: projectId,
        updatedAt: Math.trunc((await fs.stat(directory)).mtimeMs),
      });
      return;
    }
    let manifest: DesignProjectManifestV1 | undefined;
    try {
      manifest =
        Buffer.byteLength(raw, "utf8") <= MAX_DESIGN_MANIFEST_BYTES
          ? parseDesignProjectManifestV1(JSON.parse(raw))
          : undefined;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      manifest = undefined;
    }
    if (!manifest || manifest.id !== projectId) {
      // Shown as Unreadable and never deleted automatically (ADR-DS §2).
      this.entries.set(projectId, {
        kind: "unreadable",
        id: projectId,
        updatedAt: Math.trunc((await fs.stat(manifestPath)).mtimeMs),
      });
      return;
    }
    const reconciled = reconcileDesignManifest(manifest, files, this.now());
    try {
      assertDesignManifestWritable(reconciled.manifest);
    } catch (error) {
      if (!(error instanceof DesignStoreError)) throw error;
      // Parses, but no transition could have written it: treat it like damage and never delete it.
      this.entries.set(projectId, {
        kind: "unreadable",
        id: projectId,
        updatedAt: Math.trunc((await fs.stat(manifestPath)).mtimeMs),
      });
      return;
    }
    if (reconciled.changed) await this.writeManifest(reconciled.manifest);
    for (const orphan of orphanRevisionIds(reconciled.manifest, files)) {
      await fs.rm(this.revisionPath(projectId, orphan), { force: true });
    }
    this.entries.set(projectId, { kind: "ok", manifest: reconciled.manifest });
  }
}
