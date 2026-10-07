import { MAX_DISPLAY_IMAGE_DIMENSION, MAX_DISPLAY_IMAGE_PIXELS } from "../display-image-extension.js";

export const STUDIO_ASSET_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type StudioAssetMediaType = (typeof STUDIO_ASSET_MEDIA_TYPES)[number];

export function isStudioAssetMediaType(value: unknown): value is StudioAssetMediaType {
  return (STUDIO_ASSET_MEDIA_TYPES as readonly unknown[]).includes(value);
}
export type StudioAssetThumbnailEdge = 256 | 512;
export type StudioAssetRendition = "original" | "thumb-256" | "thumb-512";

/** Who keeps an asset alive. Keys are `${kind}:${id}`, matching ADR-DS and ADR-CI. */
export const STUDIO_ASSET_HOLDER_KINDS = ["design", "images-workflow", "images-run"] as const;
export type StudioAssetHolderKind = (typeof STUDIO_ASSET_HOLDER_KINDS)[number];
export interface StudioAssetHolder {
  kind: StudioAssetHolderKind;
  id: string;
}

export interface StudioAssetRecord {
  assetId: string;
  mediaType: StudioAssetMediaType;
  bytes: number;
  width: number;
  height: number;
  createdAt: number;
}

export interface StudioAssetLimits {
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxAssets: number;
  maxEdge: number;
  maxPixels: number;
  /** Unheld assets survive this long after their last put or release. */
  gcGraceMs: number;
}

export const STUDIO_ASSET_LIMITS: Readonly<StudioAssetLimits> = Object.freeze({
  maxAssetBytes: 32 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024 * 1024,
  maxAssets: 100_000,
  maxEdge: MAX_DISPLAY_IMAGE_DIMENSION,
  maxPixels: MAX_DISPLAY_IMAGE_PIXELS,
  gcGraceMs: 60 * 60 * 1000,
});

export type StudioAssetErrorCode =
  | "invalid_image"
  | "too_large"
  | "quota"
  | "not_found"
  | "invalid_holder"
  | "unavailable";

export class StudioAssetError extends Error {
  constructor(
    readonly code: StudioAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioAssetError";
  }
}

const ASSET_ID = /^[0-9a-f]{64}$/u;
const HOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isStudioAssetId(value: unknown): value is string {
  return typeof value === "string" && ASSET_ID.test(value);
}

export function holderKey(holder: StudioAssetHolder): string {
  if (
    !holder ||
    !(STUDIO_ASSET_HOLDER_KINDS as readonly string[]).includes(holder.kind) ||
    typeof holder.id !== "string" ||
    !HOLDER_ID.test(holder.id)
  ) {
    throw new StudioAssetError("invalid_holder", "Invalid studio asset holder.");
  }
  return `${holder.kind}:${holder.id}`;
}

export function parseHolderKey(key: string): StudioAssetHolder {
  const separator = key.indexOf(":");
  const holder = { kind: key.slice(0, separator), id: key.slice(separator + 1) } as StudioAssetHolder;
  holderKey(holder);
  return holder;
}
