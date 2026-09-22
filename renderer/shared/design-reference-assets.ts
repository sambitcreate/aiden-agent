export const DESIGN_REFERENCE_ASSET_VERSION = 1 as const;

/** Renderer-safe metadata. Asset bytes remain main-owned unless explicitly read. */
export interface DesignReferenceAssetV1 {
  version: typeof DESIGN_REFERENCE_ASSET_VERSION;
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
}
