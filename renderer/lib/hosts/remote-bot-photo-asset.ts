import { MAX_INLINE_IMAGE_BYTES } from "../../shared/attachment-contract";

/** A paired host's Bot photo as its feed row lists it (`avatar.asset`). */
export interface RemoteBotPhotoAsset {
  assetRevision: string;
  byteSize: number;
}

const ASSET_REVISION = /^[A-Za-z0-9._:-]{1,128}$/u;

/** The photo a host feed Bot row lists, or undefined when it lists none or a malformed one. */
export function remoteBotPhotoAsset(row: object): RemoteBotPhotoAsset | undefined {
  const avatar = (row as { avatar?: unknown }).avatar;
  const asset =
    avatar && typeof avatar === "object" ? (avatar as { asset?: unknown }).asset : undefined;
  if (!asset || typeof asset !== "object") return undefined;
  const { assetRevision, byteSize, mimeType } = asset as Record<string, unknown>;
  if (
    typeof assetRevision !== "string" ||
    !ASSET_REVISION.test(assetRevision) ||
    mimeType !== "image/png"
  )
    return undefined;
  if (
    typeof byteSize !== "number" ||
    !Number.isSafeInteger(byteSize) ||
    byteSize <= 0 ||
    byteSize > MAX_INLINE_IMAGE_BYTES
  )
    return undefined;
  return { assetRevision, byteSize };
}
