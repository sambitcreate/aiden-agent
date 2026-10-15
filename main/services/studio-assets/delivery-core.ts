import { randomBytes } from "node:crypto";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { STUDIO_ASSET_SCHEME } from "../custom-schemes-core.js";
import { isStudioAssetId, StudioAssetError, type StudioAssetRendition } from "./contract.js";

export type StudioAssetGrantOwner = Pick<
  RendererDocumentOwner,
  "id" | "documentId" | "isDestroyed" | "onInvalidated"
>;

const GRANT_HOST = "grant";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const RENDITIONS: readonly StudioAssetRendition[] = ["original", "thumb-256", "thumb-512"];

interface Grant {
  assetId: string;
  rendition: StudioAssetRendition;
  documentKey: string;
  dedupeKey: string;
  owner: StudioAssetGrantOwner;
}

function grantUrl(token: string): string {
  return `${STUDIO_ASSET_SCHEME}://${GRANT_HOST}/${token}`;
}

/** The token of an exact `aiden-asset://grant/<token>` URL, or undefined. */
export function studioAssetGrantToken(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${STUDIO_ASSET_SCHEME}:` ||
    parsed.hostname !== GRANT_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  const token = parsed.pathname.slice(1);
  return TOKEN.test(token) ? token : undefined;
}

/**
 * Opaque, document-bound capabilities for `aiden-asset:` URLs. A grant lives
 * until its renderer document navigates, reloads, crashes or closes; there is
 * no TTL to renew. Feature handlers authorize the asset before issuing.
 */
export class StudioAssetGrants {
  private readonly grants = new Map<string, Grant>(); // insertion order is age
  private readonly tokensByKey = new Map<string, string>();
  private readonly documentListeners = new Map<string, () => void>();
  private readonly maxGrants: number;
  private readonly token: () => string;

  constructor(options: { maxGrants?: number; token?: () => string } = {}) {
    this.maxGrants = options.maxGrants ?? 8_192;
    this.token = options.token ?? (() => randomBytes(32).toString("base64url"));
  }

  issue(owner: StudioAssetGrantOwner, assetId: string, rendition: StudioAssetRendition): string {
    if (!isStudioAssetId(assetId) || !RENDITIONS.includes(rendition)) {
      throw new StudioAssetError("not_found", "This studio asset is no longer available.");
    }
    if (owner.isDestroyed()) {
      throw new StudioAssetError("unavailable", "The renderer document is no longer active.");
    }
    const documentKey = `${owner.id}:${owner.documentId}`;
    const dedupeKey = `${documentKey}|${assetId}|${rendition}`;
    const existing = this.tokensByKey.get(dedupeKey);
    if (existing) {
      const grant = this.grants.get(existing)!;
      this.grants.delete(existing);
      this.grants.set(existing, grant);
      return grantUrl(existing);
    }
    if (!this.documentListeners.has(documentKey)) {
      this.documentListeners.set(documentKey, owner.onInvalidated(() => this.revokeDocument(documentKey)));
    }
    const token = this.token();
    this.grants.set(token, { assetId, rendition, documentKey, dedupeKey, owner });
    this.tokensByKey.set(dedupeKey, token);
    while (this.grants.size > this.maxGrants) {
      this.remove(this.grants.keys().next().value as string);
    }
    return grantUrl(token);
  }

  resolve(token: string): { assetId: string; rendition: StudioAssetRendition } | undefined {
    const grant = this.grants.get(token);
    if (!grant) return undefined;
    if (grant.owner.isDestroyed()) {
      this.revokeDocument(grant.documentKey);
      return undefined;
    }
    return { assetId: grant.assetId, rendition: grant.rendition };
  }

  revokeDocument(documentKey: string): number {
    let revoked = 0;
    for (const [token, grant] of this.grants) {
      if (grant.documentKey !== documentKey) continue;
      this.remove(token);
      revoked += 1;
    }
    this.documentListeners.get(documentKey)?.();
    this.documentListeners.delete(documentKey);
    return revoked;
  }

  size(): number {
    return this.grants.size;
  }

  private remove(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    this.tokensByKey.delete(grant.dedupeKey);
  }
}
