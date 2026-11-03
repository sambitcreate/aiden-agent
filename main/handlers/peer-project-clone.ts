import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import { PEER_PROJECT_CLONE_FEATURE } from "../../renderer/shared/peer-project-clone.js";
import { workspaceCloneId } from "../../renderer/shared/workspace-intake.js";
import type { createPeerProjectSource } from "../services/peer-project-source.js";
import type { PeerHostManager } from "../services/peer-host-manager.js";
import type { PeerHostView } from "../../renderer/shared/peer-host.js";
import type { PeerHostLiveOwner } from "./peer-host-live.js";

export function registerPeerProjectCloneHandlers<Event>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  owner(event: Event): PeerHostLiveOwner;
  source: ReturnType<typeof createPeerProjectSource>;
  hosts(): Promise<PeerHostView[]>;
  manager(): Pick<PeerHostManager, "call">;
}) {
  const pending = new Map<string, { owner: string; controller: AbortController }>();
  const active = (event: Event) => {
    const owner = deps.owner(event);
    if (owner.isDestroyed()) throw new Error("The application document changed.");
    return owner;
  };
  deps.handle("workspaces:peerClonePreview", (event, workspaceId) => {
    active(event);
    return deps.source.preview(hostIdentifier(workspaceId));
  });
  deps.handle("workspaces:peerCloneCancel", (event, rawId) => {
    const owner = active(event);
    const request = pending.get(workspaceCloneId(rawId));
    if (!request || request.owner !== owner.key) return false;
    request.controller.abort();
    return true;
  });
  deps.handle("workspaces:peerClone", async (event, raw) => {
    const owner = active(event);
    const input = raw as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["cloneId", "hostId", "workspaceId", "selection", "files"].includes(key))) throw new Error("Invalid project transfer.");
    const cloneId = workspaceCloneId(input.cloneId);
    const hostId = hostIdentifier(input.hostId);
    const workspaceId = hostIdentifier(input.workspaceId);
    if (pending.has(cloneId)) throw new Error("That project transfer is already running.");
    if (typeof input.selection !== "string" || !/^sel_[A-Za-z0-9_-]{43}$/u.test(input.selection)) throw new Error("Choose a destination folder on the paired computer.");
    const controller = new AbortController();
    pending.set(cloneId, { owner: owner.key, controller });
    const detach = owner.onInvalidated(() => controller.abort());
    try {
      const host = (await deps.hosts()).find(row => row.id === hostId);
      if (owner.isDestroyed() || controller.signal.aborted) throw new Error("Project transfer stopped.");
      if (!host?.enabled || !host.features.includes(PEER_PROJECT_CLONE_FEATURE) || !host.capabilities.includes("workspace:manage") || !host.capabilities.includes("workspace:browse")) throw new Error("Update the paired computer and allow project creation and folder browsing first.");
      const { source, files } = await deps.source.read(workspaceId, input.files);
      if (owner.isDestroyed() || controller.signal.aborted) throw new Error("Project transfer stopped.");
      return await deps.manager().call(hostId, {
        operation: "cloneWorkspace", idempotencyKey: `project-clone-${cloneId}`,
        body: { mode: "clone", selection: input.selection, url: source.url, files },
      }, controller.signal);
    } finally { detach(); pending.delete(cloneId); }
  });
}
