import { randomBytes } from "node:crypto";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export const ASSET_DELIVERY_GRANT_TTL_MS = 60_000;

export interface AssetDeliveryGrantLease {
  expiresAt: number;
  release(): void;
}

interface AssetDeliveryGrant {
  token: string;
  documentId: string;
  assetId: string;
  expiresAt: number;
  createdAt: number;
  owner: RendererDocumentOwner;
  isAuthorized: (assetId: string) => boolean;
  disposeInvalidation: () => void;
  lease: AssetDeliveryGrantLease;
}

interface AuthorizedProtocolRequest {
  assetId: string;
  expiresAt: number;
  remaining: number;
}

export interface AssetDeliveryGrantView {
  token: string;
  expiresAt: number;
}

/**
 * Opaque, document-bound grants for a future aiden-asset protocol. No local
 * path or asset identifier is encoded in the renderer-visible token.
 */
export class AssetDeliveryGrantRegistry {
  private readonly grants = new Map<string, AssetDeliveryGrant>();
  private readonly protocolRequests = new Map<string, AuthorizedProtocolRequest>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = ASSET_DELIVERY_GRANT_TTL_MS,
    // A v1 workflow may reference 2,000 distinct assets. Leave room for the
    // renderer's bounded atomic-renewal overlap without evicting live previews.
    private readonly maxGrants = 4_096,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) {
      throw new Error("Asset delivery grants require a 1–300 second lifetime.");
    }
    if (!Number.isInteger(maxGrants) || maxGrants < 1 || maxGrants > 10_000) {
      throw new Error("Invalid asset delivery grant capacity.");
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now || grant.owner.isDestroyed()) this.deleteGrant(token);
    }
    for (const [token, request] of this.protocolRequests) {
      if (request.expiresAt <= now || !this.grants.has(token)) this.protocolRequests.delete(token);
    }
  }

  private deleteGrant(token: string): boolean {
    const grant = this.grants.get(token);
    if (!grant) return false;
    this.grants.delete(token);
    this.protocolRequests.delete(token);
    grant.disposeInvalidation();
    this.releaseLease(grant.lease);
    return true;
  }

  private releaseLease(lease: AssetDeliveryGrantLease): void {
    try {
      lease.release();
    } catch {
      // A grant must still disappear if best-effort lease cleanup reports an
      // error. The lease expiry remains the GC-safe backstop.
    }
  }

  mint(
    owner: RendererDocumentOwner,
    assetId: string,
    isAuthorized: (assetId: string) => boolean,
    lease: AssetDeliveryGrantLease,
  ): AssetDeliveryGrantView {
    if (!OPAQUE_ID_PATTERN.test(assetId)) {
      this.releaseLease(lease);
      throw new Error("Asset delivery grants require opaque asset IDs.");
    }
    if (!owner.documentId || owner.documentId.length > 512 || owner.isDestroyed()) {
      this.releaseLease(lease);
      throw new Error("Asset delivery grants require a live renderer document owner.");
    }
    if (!isAuthorized(assetId)) {
      this.releaseLease(lease);
      throw new Error("The renderer document is not authorized to access this asset.");
    }
    if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= this.now()) {
      this.releaseLease(lease);
      throw new Error("Asset delivery grants require a live preview lease.");
    }
    this.pruneExpired();
    while (this.grants.size >= this.maxGrants) {
      const oldest = [...this.grants.values()].sort(
        (left, right) => left.createdAt - right.createdAt,
      )[0];
      if (!oldest) break;
      this.deleteGrant(oldest.token);
    }
    const createdAt = this.now();
    const token = randomBytes(32).toString("base64url");
    const grant: AssetDeliveryGrant = {
      token,
      documentId: owner.documentId,
      assetId,
      createdAt,
      expiresAt: Math.min(createdAt + this.ttlMs, lease.expiresAt),
      owner,
      isAuthorized,
      disposeInvalidation: () => undefined,
      lease,
    };
    this.grants.set(token, grant);
    grant.disposeInvalidation = owner.onInvalidated(() => this.deleteGrant(token));
    return { token, expiresAt: grant.expiresAt };
  }

  resolve(token: string, owner: RendererDocumentOwner): string | undefined {
    this.pruneExpired();
    const grant = this.grants.get(token);
    if (
      !grant ||
      owner.isDestroyed() ||
      grant.owner.isDestroyed() ||
      grant.documentId !== owner.documentId ||
      grant.owner.id !== owner.id
    ) {
      return undefined;
    }
    try {
      if (!grant.isAuthorized(grant.assetId)) {
        this.deleteGrant(token);
        return undefined;
      }
    } catch {
      this.deleteGrant(token);
      return undefined;
    }
    return grant.assetId;
  }

  /**
   * Authorize a single protocol request from the exact frame document that
   * received this grant. The protocol handler must subsequently consume the
   * ticket; calling the handler directly cannot resolve a renderer grant.
   */
  authorizeProtocolRequest(token: string, webContentsId: number, documentId: string): boolean {
    this.pruneExpired();
    const grant = this.grants.get(token);
    if (
      !grant ||
      grant.owner.isDestroyed() ||
      grant.owner.id !== webContentsId ||
      grant.documentId !== documentId
    ) {
      return false;
    }
    try {
      if (!grant.isAuthorized(grant.assetId)) {
        this.deleteGrant(token);
        return false;
      }
    } catch {
      this.deleteGrant(token);
      return false;
    }
    const current = this.protocolRequests.get(token);
    this.protocolRequests.set(token, {
      assetId: grant.assetId,
      expiresAt: Math.min(grant.expiresAt, this.now() + 10_000),
      remaining: Math.min(8, (current?.remaining ?? 0) + 1),
    });
    return true;
  }

  consumeProtocolRequest(token: string): string | undefined {
    this.pruneExpired();
    const request = this.protocolRequests.get(token);
    if (!request || request.remaining < 1) return undefined;
    if (request.remaining === 1) this.protocolRequests.delete(token);
    else this.protocolRequests.set(token, { ...request, remaining: request.remaining - 1 });
    return request.assetId;
  }

  revoke(token: string, owner: RendererDocumentOwner): boolean {
    const grant = this.grants.get(token);
    if (!grant || grant.documentId !== owner.documentId || grant.owner.id !== owner.id)
      return false;
    return this.deleteGrant(token);
  }

  revokeDocument(owner: RendererDocumentOwner): number {
    let revoked = 0;
    for (const [token, grant] of this.grants) {
      if (grant.documentId !== owner.documentId || grant.owner.id !== owner.id) continue;
      this.deleteGrant(token);
      revoked += 1;
    }
    return revoked;
  }

  size(): number {
    this.pruneExpired();
    return this.grants.size;
  }
}
