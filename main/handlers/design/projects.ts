// designProjects:* library and mutation channels (ADR-DS §6, channels 1-7).
// Refusals from the store come back as typed results (see results.ts).
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { DesignProjectStore } from "../../services/design/store.js";
import {
  parseDesignCreateRequest,
  parseDesignDeleteRequest,
  parseDesignListRequest,
  parseDesignMutateRequest,
  parseDesignProjectRequest,
} from "./params.js";
import { settleDesignCall, settleDesignCallAsync, type DesignIpcFailure } from "./results.js";

export type DesignIpcRegistrar = Pick<IpcMain, "handle">;

export interface DesignProjectHandlerDeps {
  store: Pick<
    DesignProjectStore,
    "list" | "get" | "create" | "duplicate" | "mutate" | "previewDelete" | "delete" | "deleteUnreadable"
  >;
  /** Throws unless the sender is the active application document. */
  assertOwner(event: IpcMainInvokeEvent): void;
}

export function registerDesignProjectHandlers(ipc: DesignIpcRegistrar, deps: DesignProjectHandlerDeps): void {
  ipc.handle("designProjects:list", (event, request: unknown) => {
    deps.assertOwner(event);
    parseDesignListRequest(request);
    return deps.store.list();
  });

  ipc.handle("designProjects:get", (event, request: unknown) => {
    deps.assertOwner(event);
    const { projectId } = parseDesignProjectRequest(request);
    return deps.store.get(projectId) ?? missingProject();
  });

  ipc.handle("designProjects:create", (event, request: unknown) => {
    deps.assertOwner(event);
    const input = parseDesignCreateRequest(request);
    return settleDesignCallAsync(() => deps.store.create(input));
  });

  ipc.handle("designProjects:duplicate", (event, request: unknown) => {
    deps.assertOwner(event);
    const { projectId } = parseDesignProjectRequest(request);
    return settleDesignCallAsync(() => deps.store.duplicate(projectId));
  });

  ipc.handle("designProjects:mutate", (event, request: unknown) => {
    deps.assertOwner(event);
    const { projectId, expectedRevision, op } = parseDesignMutateRequest(request);
    return settleDesignCallAsync(() => deps.store.mutate(projectId, expectedRevision, op));
  });

  ipc.handle("designProjects:previewDelete", (event, request: unknown) => {
    deps.assertOwner(event);
    const { projectId } = parseDesignProjectRequest(request);
    return settleDesignCall(() => deps.store.previewDelete(projectId));
  });

  ipc.handle("designProjects:delete", (event, request: unknown): Promise<void | DesignIpcFailure> => {
    deps.assertOwner(event);
    const parsed = parseDesignDeleteRequest(request);
    // The store removes an unreadable project's hidden chats by owner lookup before its files.
    return settleDesignCallAsync(async () => {
      if (parsed.unreadable) await deps.store.deleteUnreadable(parsed.projectId);
      else await deps.store.delete(parsed.projectId, parsed.expectedRevision);
    });
  });
}

function missingProject(): DesignIpcFailure {
  return { ok: false, reason: "not_found", message: "This design project no longer exists." };
}
