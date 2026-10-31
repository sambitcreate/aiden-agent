/**
 * Where hooks are configured:
 * - Aiden-owned entries for every scope (global, workspace, chat, bot) live
 *   in the profile at `<root>/hooks.json`. Agent-proposed workspace hooks are
 *   stored here keyed by workspace root and never written into the repo.
 * - A repo may carry `<workspaceRoot>/.aiden/hooks.json` (Claude-compatible).
 *   It is read with a size bound and listed, but its hooks run only once the
 *   owner approves each digest.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HookJsonFile } from "./hook-json-file.js";
import { compileHookMatcher } from "./hook-matcher.js";
import {
  hookDefinitionFor,
  hookScopeIdPart,
  isHookEvent,
  normalizeHookScope,
  parseHooksConfigText,
  validateHookHandler,
  type ParsedHooksFile,
} from "./hook-config.js";
import type { HookCommandHandler, HookDefinition, HookEvent, HookListing, HookScope } from "./hook-types.js";

export const WORKSPACE_HOOKS_FILE = path.join(".aiden", "hooks.json");
export const MAX_WORKSPACE_HOOKS_FILE_BYTES = 256 * 1024;

export interface StoredHookEntry {
  id: string;
  name?: string;
  scope: HookScope;
  event: HookEvent;
  matcher: string;
  handler: HookCommandHandler;
  source: "settings" | "agent" | "bot";
  createdAt: number;
  updatedAt: number;
}

interface HookStoreState {
  version: 1;
  entries: StoredHookEntry[];
}

function emptyStore(): HookStoreState {
  return { version: 1, entries: [] };
}

function sanitizeScope(raw: unknown): HookScope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const scope = raw as Record<string, unknown>;
  if (scope.kind === "global") return { kind: "global" };
  if (scope.kind === "workspace" && typeof scope.workspaceRoot === "string" && path.isAbsolute(scope.workspaceRoot)) {
    return normalizeHookScope({ kind: "workspace", workspaceRoot: scope.workspaceRoot });
  }
  if (scope.kind === "chat" && typeof scope.chatId === "string" && scope.chatId) return { kind: "chat", chatId: scope.chatId };
  if (scope.kind === "bot" && typeof scope.botId === "string" && scope.botId) return { kind: "bot", botId: scope.botId };
  return undefined;
}

function sanitizeStore(raw: unknown): HookStoreState {
  const state = emptyStore();
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { entries?: unknown }).entries)) return state;
  const seen = new Set<string>();
  for (const item of (raw as { entries: unknown[] }).entries) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const scope = sanitizeScope(entry.scope);
    if (typeof entry.id !== "string" || !entry.id || seen.has(entry.id) || !scope || !isHookEvent(entry.event)) continue;
    if (!entry.handler || typeof entry.handler !== "object") continue;
    seen.add(entry.id);
    state.entries.push({
      id: entry.id,
      ...(typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim() } : {}),
      scope,
      event: entry.event,
      matcher: typeof entry.matcher === "string" ? entry.matcher : "",
      // Re-validated whenever it is listed or run; kept as written so a bad edit shows as unsupported.
      handler: entry.handler as HookCommandHandler,
      source: entry.source === "agent" || entry.source === "bot" ? entry.source : "settings",
      createdAt: Number(entry.createdAt) || 0,
      updatedAt: Number(entry.updatedAt) || 0,
    });
  }
  return state;
}

/** A stored entry as a listing, before trust decides between active and waiting. */
export function storedEntryListing(entry: StoredHookEntry): HookListing {
  const validation = validateHookHandler(entry.handler);
  const handler: HookCommandHandler = validation.ok
    ? validation.handler
    : { type: "command", command: typeof entry.handler?.command === "string" ? entry.handler.command : "" };
  const definition = hookDefinitionFor({ ...entry, handler });
  const matcher = compileHookMatcher(entry.matcher);
  const reason = !validation.ok ? validation.reason : !matcher.ok ? matcher.reason : undefined;
  const listing: HookListing = {
    ...definition,
    configuredEvent: entry.event,
    configuredType: validation.ok ? "command" : validation.configuredType,
    status: reason ? "unsupported" : "waiting-for-approval",
  };
  if (reason) listing.unsupportedReason = reason;
  return listing;
}

export class HookEntryStore {
  private state: HookStoreState = emptyStore();
  private readonly file: HookJsonFile<HookStoreState>;

  constructor(root: () => string) {
    this.file = new HookJsonFile(() => path.join(root(), "hooks.json"), sanitizeStore, emptyStore);
  }

  async load(): Promise<void> {
    this.state = await this.file.read();
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  entries(): readonly StoredHookEntry[] {
    return this.state.entries;
  }

  get(id: string): StoredHookEntry | undefined {
    return this.state.entries.find((entry) => entry.id === id);
  }

  async upsert(entry: StoredHookEntry): Promise<void> {
    const index = this.state.entries.findIndex((existing) => existing.id === entry.id);
    if (index >= 0) this.state.entries[index] = entry;
    else this.state.entries.push(entry);
    await this.file.write(this.state);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((entry) => entry.id !== id);
    if (this.state.entries.length === before) return false;
    await this.file.write(this.state);
    return true;
  }
}

export interface WorkspaceHooksFile extends ParsedHooksFile {
  /** False when the repo has no `.aiden/hooks.json`. */
  present: boolean;
}

/** Id prefix for a repo's hooks; distinct from profile entries in the same workspace. */
export function workspaceFileIdPrefix(workspaceRoot: string): string {
  return `repo:${hookScopeIdPart({ kind: "workspace", workspaceRoot })}`;
}

/**
 * Read `<workspaceRoot>/.aiden/hooks.json` without following symlinks and
 * with a size bound. A missing file is not a problem; anything unreadable is.
 */
export async function readWorkspaceHooksFile(workspaceRoot: string): Promise<WorkspaceHooksFile> {
  const scope = normalizeHookScope({ kind: "workspace", workspaceRoot });
  const root = (scope as { workspaceRoot: string }).workspaceRoot;
  const empty = (problem?: string, present = true): WorkspaceHooksFile => ({
    present,
    hooks: [],
    problems: problem ? [problem] : [],
    warnings: [],
  });
  const directory = path.join(root, ".aiden");
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return empty(".aiden is not a plain folder, so its hooks were not read.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return empty(undefined, false);
    return empty(`The hooks file could not be read: ${(error as Error).message}`);
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path.join(root, WORKSPACE_HOOKS_FILE), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(undefined, false);
    return empty(`The hooks file could not be read: ${(error as Error).message}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return empty("The hooks file is not a regular file.");
    if (stat.size > MAX_WORKSPACE_HOOKS_FILE_BYTES) return empty(`The hooks file is larger than ${MAX_WORKSPACE_HOOKS_FILE_BYTES / 1024} KiB.`);
    const buffer = Buffer.alloc(MAX_WORKSPACE_HOOKS_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_WORKSPACE_HOOKS_FILE_BYTES) return empty(`The hooks file is larger than ${MAX_WORKSPACE_HOOKS_FILE_BYTES / 1024} KiB.`);
    const parsed = parseHooksConfigText(buffer.subarray(0, bytesRead).toString("utf8"), {
      scope,
      source: "workspace-file",
      idPrefix: workspaceFileIdPrefix(root),
    });
    return { present: true, ...parsed };
  } finally {
    await handle.close();
  }
}

/** The runnable definition behind a listing, or undefined when it is not supported. */
export function listingDefinition(listing: HookListing): HookDefinition | undefined {
  if (listing.status === "unsupported" || listing.event === "unknown") return undefined;
  const { id, name, event, matcher, handler, scope, source, digest } = listing;
  return { id, name, event, matcher, handler, scope, source, digest };
}
