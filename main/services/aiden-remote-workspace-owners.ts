import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";

class AidenRemoteWorkspaceOperationOwner implements WorkspaceOperationDocumentOwner {
  private invalidated = false;
  private readonly listeners = new Set<() => void>();

  isDestroyed(): boolean {
    return this.invalidated;
  }

  onInvalidated(listener: () => void): () => void {
    if (this.invalidated) listener();
    else this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  revoke(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

/** Remote ownership survives a socket disconnect and ends only on revocation. */
export class AidenRemoteWorkspaceOwnerRegistry {
  private readonly owners = new Map<string, AidenRemoteWorkspaceOperationOwner>();

  owner(deviceId: string): WorkspaceOperationDocumentOwner {
    let owner = this.owners.get(deviceId);
    if (!owner || owner.isDestroyed()) {
      owner = new AidenRemoteWorkspaceOperationOwner();
      this.owners.set(deviceId, owner);
    }
    return owner;
  }

  revokeDevice(deviceId: string): void {
    this.owners.get(deviceId)?.revoke();
    this.owners.delete(deviceId);
  }
}
