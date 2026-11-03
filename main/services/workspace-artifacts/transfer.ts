import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { AIDEN_UI_CATALOG_VERSION, type AidenUiNodeV1 } from "../../../renderer/shared/aiden-ui/types.js";
import { validateCompiledAum } from "../../../renderer/shared/aiden-ui/validate.js";
import { parseChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/visual.js";
import {
  isWorkspaceArtifactTitle,
  parseWorkspaceArtifactActions,
  parseWorkspaceArtifactDescription,
  parseWorkspaceArtifactRefresh,
  parseWorkspaceArtifactSources,
  parseWorkspaceArtifactV1,
  WORKSPACE_ARTIFACT_LIMITS,
  type WorkspaceArtifactActionV1,
  type WorkspaceArtifactRefreshV1,
  type WorkspaceArtifactSourceV1,
  type WorkspaceArtifactV1,
} from "../../../renderer/shared/workspace-artifacts.js";
import { safeExportFileName } from "../chat-export.js";
import { readRegularFile } from "../regular-file-read.js";
import type { WorkspaceArtifactContent } from "./store.js";

/**
 * Export and import of one workspace artifact page as a file the person keeps
 * or shares. The file carries only what makes the page: never an approval,
 * ids, the workspace, the chat that made it, timestamps, the person's saved
 * page state, data its sources read, or history. An imported file is
 * untrusted input, so its page is checked the way the compiler builds one,
 * read back through the same parsers and limits as a page Aiden saves, and
 * always saved without an approval.
 */

/** The native file dialogs and file access behind Export page and Import page. */
export interface WorkspaceArtifactFiles {
  /** Asks where to save the page file; null when the person cancels. */
  chooseExportPath: (event: unknown, defaultName: string) => Promise<string | null>;
  /** Asks for a page file to import; null when the person cancels. */
  chooseImportFile: (event: unknown) => Promise<string | null>;
  writeFile: (filePath: string, text: string) => Promise<void>;
  /** Reads a regular file, failing with code EFBIG past `maxBytes`. */
  readFile: (filePath: string, maxBytes: number) => Promise<Uint8Array>;
}

/**
 * Reads the file the person picked. The path may be a symlink or alias, so
 * the bytes come from the file it names; anything but a regular file (a
 * FIFO, a device, a directory) is refused without blocking, and the read
 * fails with EFBIG past `maxBytes`.
 */
export async function readWorkspaceArtifactPageFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  return readRegularFile(await fs.realpath(filePath), maxBytes);
}

export const WORKSPACE_ARTIFACT_FILE_FORMAT = "aiden-artifact-page";
export const WORKSPACE_ARTIFACT_FILE_VERSION = 1;
/** Larger than any page the store accepts, small enough to read at once. */
export const WORKSPACE_ARTIFACT_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** How long a previewed import waits for the person to confirm it. */
export const WORKSPACE_ARTIFACT_IMPORT_TTL_MS = 5 * 60_000;
const MAX_PENDING_IMPORTS = 8;

export interface WorkspaceArtifactPageFileV1 {
  format: typeof WORKSPACE_ARTIFACT_FILE_FORMAT;
  version: typeof WORKSPACE_ARTIFACT_FILE_VERSION;
  title: string;
  description?: string;
  /**
   * The compiled page. `state` is the state its markup declared, never what
   * the person saved since (a tab they picked, text they typed); a page
   * saved before Aiden kept the declared state apart exports none.
   */
  visual: {
    catalogVersion: number;
    tree: AidenUiNodeV1;
    dataJson?: string;
    state?: Record<string, unknown>;
    layout?: "wide";
    fallbackText: string;
  };
  sources: WorkspaceArtifactSourceV1[];
  actions: WorkspaceArtifactActionV1[];
  refresh: WorkspaceArtifactRefreshV1;
}

/** The file an export writes for a page. */
export function workspaceArtifactPageFile(artifact: WorkspaceArtifactV1): WorkspaceArtifactPageFileV1 {
  const { catalogVersion, tree, dataJson, layout, fallbackText } = artifact.visual;
  return {
    format: WORKSPACE_ARTIFACT_FILE_FORMAT,
    version: WORKSPACE_ARTIFACT_FILE_VERSION,
    title: artifact.visual.title,
    ...(artifact.description ? { description: artifact.description } : {}),
    visual: {
      catalogVersion,
      tree,
      ...(dataJson !== undefined ? { dataJson } : {}),
      ...(artifact.initialState ? { state: artifact.initialState } : {}),
      ...(layout === "wide" ? { layout } : {}),
      fallbackText,
    },
    sources: artifact.sources,
    actions: artifact.actions,
    refresh: artifact.refresh,
  };
}

/** `<title>.aiden-page.json`, with characters file systems reject or hide replaced. */
export function workspaceArtifactPageFileName(title: string): string {
  return safeExportFileName(title, { fallback: "Aiden page", extension: ".aiden-page.json" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cannotImport(reason: string): never {
  throw new Error(`This page can’t be imported: ${reason}`);
}

function strictly<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    return cannotImport(error instanceof Error ? error.message : "it is invalid.");
  }
}

/**
 * Reads a page file strictly: an unknown format or version, or anything a
 * page Aiden saves could not hold, is refused with the reason. Keys the
 * format does not define (an approval, ids) are ignored, never kept.
 */
export function parseWorkspaceArtifactPageFile(value: unknown): WorkspaceArtifactContent {
  if (!isRecord(value) || value.format !== WORKSPACE_ARTIFACT_FILE_FORMAT) {
    throw new Error("This file isn’t an Aiden page. Choose a file exported with Export page.");
  }
  if (value.version !== WORKSPACE_ARTIFACT_FILE_VERSION) {
    throw new Error(
      typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version > WORKSPACE_ARTIFACT_FILE_VERSION
        ? "This page was exported by a newer Aiden. Update Aiden to import it."
        : "This page file’s version isn’t one Aiden can read.",
    );
  }
  const title = typeof value.title === "string" ? value.title.trim() : value.title;
  if (!isWorkspaceArtifactTitle(title)) {
    cannotImport(`its title must be 1–${WORKSPACE_ARTIFACT_LIMITS.titleChars} visible characters on one line.`);
  }
  const description = strictly(() => parseWorkspaceArtifactDescription(value.description));
  const sources = strictly(() => parseWorkspaceArtifactSources(value.sources));
  const actions = strictly(() => parseWorkspaceArtifactActions(value.actions));
  const refresh = strictly(() => parseWorkspaceArtifactRefresh(value.refresh));
  const raw = value.visual;
  if (!isRecord(raw)) cannotImport("it has no page.");
  if (raw.catalogVersion !== AIDEN_UI_CATALOG_VERSION) cannotImport("it was made for components this Aiden doesn’t have.");
  if (raw.layout !== undefined && raw.layout !== "column" && raw.layout !== "wide") cannotImport('its layout must be "column" or "wide".');
  // Held to what compileAum enforces, and rebuilt from known keys only.
  const page = validateCompiledAum(
    {
      tree: raw.tree,
      ...(raw.dataJson !== undefined ? { dataJson: raw.dataJson } : {}),
      ...(raw.state !== undefined ? { state: raw.state } : {}),
    },
    { artifactActions: true },
  );
  if (!page.ok) cannotImport(page.error);
  const visual = parseChatUiVisualV1({
    version: 1,
    kind: "ui",
    id: "pending",
    title,
    catalogVersion: raw.catalogVersion,
    tree: page.tree,
    ...(page.dataJson !== undefined ? { dataJson: page.dataJson } : {}),
    ...(page.state ? { state: page.state } : {}),
    fallbackText: raw.fallbackText,
    ...(raw.layout === "wide" ? { layout: "wide" } : {}),
  });
  if (!visual) cannotImport("its page is invalid or larger than an artifact can hold.");
  const content: WorkspaceArtifactContent = {
    title,
    ...(description ? { description } : {}),
    visual,
    // The file's state is what its markup declared, so it is both.
    ...(page.state ? { initialState: page.state } : {}),
    sources,
    actions,
    refresh,
  };
  // The whole page through the store's own reader, as a save would be.
  const candidate = parseWorkspaceArtifactV1({
    version: 1,
    id: "import",
    workspaceId: "import",
    ...(description ? { description } : {}),
    visual: { ...visual, id: "import" },
    ...(page.state ? { initialState: page.state } : {}),
    sources,
    actions,
    refresh,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  });
  if (!candidate) cannotImport("its page is invalid or larger than an artifact can hold.");
  return content;
}

/** Reads a page file's text; anything that is not JSON is refused. */
export function parseWorkspaceArtifactPageFileText(text: string): WorkspaceArtifactContent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This file isn’t an Aiden page. Choose a file exported with Export page.");
  }
  return parseWorkspaceArtifactPageFile(value);
}

interface PendingImport {
  workspaceId: string;
  owner: string;
  content: WorkspaceArtifactContent;
  expiresAt: number;
}

const EXPIRED = "This import is no longer available. Choose the file again.";

/**
 * Previewed imports waiting for the person: each under a random one-time
 * token, tied to the workspace and the window document that asked, until it
 * expires. Nothing from a file is saved, and so nothing runs, before its
 * token is taken.
 */
export class WorkspaceArtifactImports {
  private readonly pending = new Map<string, PendingImport>();
  private readonly now: () => number;
  private readonly newToken: () => string;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; newToken?: () => string; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.newToken = options.newToken ?? (() => randomBytes(24).toString("base64url"));
    this.ttlMs = options.ttlMs ?? WORKSPACE_ARTIFACT_IMPORT_TTL_MS;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(token);
  }

  hold(workspaceId: string, owner: string, content: WorkspaceArtifactContent): string {
    this.prune();
    // The oldest waiting import goes first, so previews cannot pile up.
    while (this.pending.size >= MAX_PENDING_IMPORTS) this.pending.delete(this.pending.keys().next().value!);
    const token = this.newToken();
    this.pending.set(token, { workspaceId, owner, content, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** The content once, for the same workspace and window that previewed it. */
  take(workspaceId: string, owner: string, token: string): WorkspaceArtifactContent {
    this.prune();
    const entry = this.pending.get(token);
    // A token offered from elsewhere stays for the window it belongs to.
    if (!entry || entry.workspaceId !== workspaceId || entry.owner !== owner) throw new Error(EXPIRED);
    this.pending.delete(token);
    return entry.content;
  }

  discard(workspaceId: string, owner: string, token: string): boolean {
    const entry = this.pending.get(token);
    if (!entry || entry.workspaceId !== workspaceId || entry.owner !== owner) return false;
    return this.pending.delete(token);
  }
}
