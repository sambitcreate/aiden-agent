// Settings → Memory lists what Aiden remembers for each workspace and lets the
// person delete a fact. It reads the same scope chats use (memory-context.ts),
// so what is listed here is exactly what a chat in that workspace can recall.

import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { sharedWorkspaceScopeId } from "./memory-shared.js";
import type { MemoryFact, MemoryScope } from "./memory-store.js";

export interface WorkspaceMemoryFactView {
  id: string;
  text: string;
  /** Always included in that workspace's chats, rather than recalled when relevant. */
  alwaysOn: boolean;
  /** Who saved it: the person, or Aiden (a fact Aiden suggested in a chat). */
  savedBy: "you" | "aiden";
  updatedAt: number;
  expiresAt?: number;
}

export interface WorkspaceMemoryFactsDeps {
  getWorkspace(id: string): Promise<{ id: string; folderPath?: string } | null | undefined>;
  store: {
    list(scope: MemoryScope): Promise<MemoryFact[]>;
    remove(scope: MemoryScope, id: string): Promise<boolean>;
  };
  now?: () => number;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function createWorkspaceMemoryFacts(deps: WorkspaceMemoryFactsDeps) {
  const scopeFor = async (workspaceId: unknown): Promise<MemoryScope> => {
    const workspace = await deps.getWorkspace(requireId(workspaceId, "workspace"));
    if (!workspace) throw new Error("This workspace no longer exists.");
    return workspace.folderPath
      ? { kind: "workspace", id: sharedWorkspaceScopeId(workspace.folderPath) }
      : { kind: "workspace", id: persistedChatWorkspaceId(workspace.id) };
  };
  return {
    /** Active, unexpired facts, newest first. Replaced versions are not shown. */
    async list(workspaceId: unknown): Promise<WorkspaceMemoryFactView[]> {
      const now = (deps.now ?? Date.now)();
      return (await deps.store.list(await scopeFor(workspaceId)))
        .filter((fact) => fact.state === "active" && (fact.expiresAt === undefined || fact.expiresAt > now))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((fact) => ({
          id: fact.id,
          text: fact.text,
          alwaysOn: fact.alwaysOn,
          savedBy: fact.provenance.kind === "user_edit" ? "you" : "aiden",
          updatedAt: fact.updatedAt,
          ...(fact.expiresAt !== undefined ? { expiresAt: fact.expiresAt } : {}),
        }));
    },
    /** Delete one fact for good. Returns false when it was already gone. */
    async remove(workspaceId: unknown, factId: unknown): Promise<boolean> {
      return deps.store.remove(await scopeFor(workspaceId), requireId(factId, "memory"));
    },
  };
}
