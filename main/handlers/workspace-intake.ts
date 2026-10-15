// Workspace menu IPC: inspect or open a typed path, and clone a repository.
//
// Every argument is re-validated here and in the service. Clone progress goes
// only to the document that started the clone, and a reload or navigation of
// that document cancels it.

import {
  workspaceCloneId,
  type WorkspaceCloneProgress,
  type WorkspaceCloneResult,
} from "../../renderer/shared/workspace-intake.js";
import type { Workspace } from "../services/types.js";
import type { WorkspaceIntakeService } from "../services/workspace-intake.js";

export interface WorkspaceIntakeOwner {
  key: string;
  isDestroyed(): boolean;
  onInvalidated(listener: () => void): () => void;
  /** Deliver a notification to this document only. */
  send(channel: "workspaces:clone-progress", payload: WorkspaceCloneProgress): void;
}

export interface WorkspaceIntakeHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Throws for a sender that is not the current main frame. */
  owner(event: Event): WorkspaceIntakeOwner;
  service(): Pick<WorkspaceIntakeService, "inspect" | "open" | "previewClone" | "clone">;
  /** Tell every window the workspace list changed. */
  notifyChanged(): void;
}

const INACTIVE = "The application document changed.";

function optionalWorkspaceId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error('Expected a workspace id for "relativeToWorkspaceId".');
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object for "${name}".`);
  }
  return value as Record<string, unknown>;
}

export function registerWorkspaceIntakeHandlers<Event>(
  dependencies: WorkspaceIntakeHandlerDependencies<Event>,
): void {
  const { handle } = dependencies;
  const clones = new Map<string, { owner: string; controller: AbortController }>();

  const active = (event: Event): WorkspaceIntakeOwner => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    return owner;
  };

  handle("workspaces:inspectPath", async (event, input, relativeToWorkspaceId) => {
    active(event);
    return dependencies.service().inspect(input, optionalWorkspaceId(relativeToWorkspaceId));
  });

  handle("workspaces:openPath", async (event, input, rawOptions) => {
    active(event);
    const options = record(rawOptions ?? {}, "options");
    if (options.create !== undefined && typeof options.create !== "boolean") {
      throw new Error('Expected boolean "create".');
    }
    const result = await dependencies.service().open(input, {
      create: options.create === true,
      relativeToWorkspaceId: optionalWorkspaceId(options.relativeToWorkspaceId),
    });
    if (result.ok && !result.existing) dependencies.notifyChanged();
    return result;
  });

  handle("workspaces:clonePreview", async (event, url) => {
    active(event);
    return dependencies.service().previewClone(url);
  });

  handle("workspaces:clone", async (event, rawInput): Promise<WorkspaceCloneResult<Workspace>> => {
    const owner = active(event);
    const input = record(rawInput, "input");
    const cloneId = workspaceCloneId(input.cloneId);
    if (clones.has(cloneId)) throw new Error("That clone is already running.");
    const controller = new AbortController();
    clones.set(cloneId, { owner: owner.key, controller });
    const detach = owner.onInvalidated(() => controller.abort());
    try {
      const result = await dependencies.service().clone(
        { url: input.url, destination: input.destination },
        {
          cloneId,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!owner.isDestroyed()) owner.send("workspaces:clone-progress", progress);
          },
        },
      );
      if (result.ok) dependencies.notifyChanged();
      return result;
    } finally {
      detach();
      clones.delete(cloneId);
    }
  });

  handle("workspaces:cloneCancel", (event, cloneId) => {
    const owner = active(event);
    const running = clones.get(workspaceCloneId(cloneId));
    if (!running || running.owner !== owner.key) return false;
    running.controller.abort();
    return true;
  });
}
