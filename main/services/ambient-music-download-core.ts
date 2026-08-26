import path from "node:path";

import type { AmbientMusicModelId } from "../../renderer/shared/ambient-music.js";

export type AmbientMusicAssetRole = "shared" | AmbientMusicModelId;

export interface AmbientMusicAsset {
  role: AmbientMusicAssetRole;
  relativePath: string;
  size: number;
  sha256: string;
}

export interface AmbientMusicAssetManifest {
  version: 1;
  source: "google/magenta-realtime-2";
  revision: string;
  license: "CC-BY-4.0";
  termsUrl: string;
  bundled: false;
  files: AmbientMusicAsset[];
}

export interface AmbientMusicPartialMetadata {
  version: 1;
  revision: string;
  relativePath: string;
  expectedSize: number;
  etag: string;
}

export class AmbientMusicDownloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AmbientMusicDownloadError";
  }
}

const TRUSTED_DOWNLOAD_HOSTS = new Set([
  "huggingface.co",
  "cdn-lfs.hf.co",
  "cdn-lfs-us-1.hf.co",
  "cdn-lfs-eu-1.hf.co",
  "cdn-lfs.huggingface.co",
  "cas-bridge.xethub.hf.co",
]);

function isTrustedDownloadHost(hostname: string): boolean {
  return TRUSTED_DOWNLOAD_HOSTS.has(hostname) ||
    hostname === "aws.cdn.hf.co" ||
    hostname.endsWith(".aws.cdn.hf.co");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && !normalized.startsWith("../") && normalized !== "..";
}

function parseAsset(value: unknown): AmbientMusicAsset {
  if (!isRecord(value)) {
    throw new AmbientMusicDownloadError("invalid_manifest", "Ambient Music has an invalid asset manifest.");
  }
  const role = value.role;
  const relativePath = value.relativePath;
  const size = value.size;
  const sha256 = value.sha256;
  if (
    (role !== "shared" && role !== "mrt2_small" && role !== "mrt2_base") ||
    typeof relativePath !== "string" ||
    !isSafeRelativePath(relativePath) ||
    !Number.isSafeInteger(size) ||
    (size as number) <= 0 ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sha256)
  ) {
    throw new AmbientMusicDownloadError("invalid_manifest", "Ambient Music has an invalid asset entry.");
  }
  const expectedPrefix = role === "shared" ? "resources/" : `models/${role}/`;
  if (!relativePath.startsWith(expectedPrefix)) {
    throw new AmbientMusicDownloadError("invalid_manifest", "An Ambient Music asset is outside its owned role.");
  }
  return { role, relativePath, size: size as number, sha256 };
}

export function parseAmbientMusicAssetManifest(value: unknown): AmbientMusicAssetManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.source !== "google/magenta-realtime-2" ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.revision) ||
    value.license !== "CC-BY-4.0" ||
    value.bundled !== false ||
    typeof value.termsUrl !== "string" ||
    !Array.isArray(value.files)
  ) {
    throw new AmbientMusicDownloadError("invalid_manifest", "Ambient Music has an invalid pinned manifest.");
  }
  const files = value.files.map(parseAsset);
  const paths = new Set<string>();
  for (const asset of files) {
    if (paths.has(asset.relativePath)) {
      throw new AmbientMusicDownloadError("invalid_manifest", "The Ambient Music manifest contains a duplicate path.");
    }
    paths.add(asset.relativePath);
  }
  for (const role of ["shared", "mrt2_small", "mrt2_base"] as const) {
    if (!files.some((asset) => asset.role === role)) {
      throw new AmbientMusicDownloadError("invalid_manifest", `The Ambient Music manifest omits ${role}.`);
    }
  }
  return {
    version: 1,
    source: "google/magenta-realtime-2",
    revision: value.revision,
    license: "CC-BY-4.0",
    termsUrl: value.termsUrl,
    bundled: false,
    files,
  };
}

export function ambientMusicAssetsForModel(
  manifest: AmbientMusicAssetManifest,
  model: AmbientMusicModelId,
): AmbientMusicAsset[] {
  return manifest.files.filter((asset) => asset.role === "shared" || asset.role === model);
}

export function ambientMusicRoleAssets(
  manifest: AmbientMusicAssetManifest,
  role: AmbientMusicAssetRole,
): AmbientMusicAsset[] {
  return manifest.files.filter((asset) => asset.role === role);
}

export function ambientMusicModelDownloadBytes(
  manifest: AmbientMusicAssetManifest,
  model: AmbientMusicModelId,
): number {
  return ambientMusicAssetsForModel(manifest, model).reduce((total, asset) => total + asset.size, 0);
}

export function ambientMusicAssetUrl(
  manifest: AmbientMusicAssetManifest,
  asset: AmbientMusicAsset,
): URL {
  const encodedPath = asset.relativePath.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `https://huggingface.co/${manifest.source}/resolve/${manifest.revision}/${encodedPath}?download=true`,
  );
}

export function validateAmbientMusicRedirect(current: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new AmbientMusicDownloadError("invalid_redirect", "The model host returned an invalid redirect.");
  }
  if (
    next.protocol !== "https:" ||
    next.username ||
    next.password ||
    !isTrustedDownloadHost(next.hostname) ||
    next.port
  ) {
    throw new AmbientMusicDownloadError(
      "untrusted_redirect",
      "The model host redirected outside Aiden's trusted download boundary.",
    );
  }
  if (next.hostname === "huggingface.co") {
    if (current.hostname !== "huggingface.co" || next.pathname !== current.pathname) {
      throw new AmbientMusicDownloadError(
        "redirect_path_drift",
        "The model host redirected to a different repository, revision, or asset path.",
      );
    }
  } else if (next.hostname === "cas-bridge.xethub.hf.co") {
    if (!/^\/(?:xet-bridge-[a-z0-9-]+|v1\/reconstructions)\/[A-Za-z0-9._~/-]+$/u.test(next.pathname)) {
      throw new AmbientMusicDownloadError("redirect_path_drift", "The Xet redirect path is outside the model asset boundary.");
    }
  } else if (next.hostname === "aws.cdn.hf.co" || next.hostname.endsWith(".aws.cdn.hf.co")) {
    if (!/^\/xet-bridge-[a-z0-9-]+\/[a-f0-9]{16,}\/[a-f0-9]{16,}$/u.test(next.pathname)) {
      throw new AmbientMusicDownloadError("redirect_path_drift", "The model CDN redirect path is outside the Xet object boundary.");
    }
  } else if (!/^\/[A-Za-z0-9._~/-]+$/u.test(next.pathname) || next.pathname.split("/").filter(Boolean).length < 2) {
    throw new AmbientMusicDownloadError("redirect_path_drift", "The model CDN redirect path is invalid.");
  }
  return next;
}

export function resolveAmbientMusicOwnedPath(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new AmbientMusicDownloadError("unsafe_path", "An Ambient Music asset path is unsafe.");
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new AmbientMusicDownloadError("unsafe_path", "An Ambient Music asset escaped its storage root.");
  }
  return candidate;
}

export function parseAmbientMusicContentRange(value: string | undefined): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

export function canResumeAmbientMusicPartial(
  metadata: unknown,
  manifest: AmbientMusicAssetManifest,
  asset: AmbientMusicAsset,
  partialSize: number,
): metadata is AmbientMusicPartialMetadata {
  return isRecord(metadata) &&
    metadata.version === 1 &&
    metadata.revision === manifest.revision &&
    metadata.relativePath === asset.relativePath &&
    metadata.expectedSize === asset.size &&
    typeof metadata.etag === "string" &&
    metadata.etag.length > 0 &&
    metadata.etag.length <= 512 &&
    Number.isSafeInteger(partialSize) &&
    partialSize > 0 &&
    partialSize < asset.size;
}

export function ambientMusicDiskBudget(remainingBytes: number): number {
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0) {
    throw new AmbientMusicDownloadError("invalid_disk_budget", "Ambient Music could not calculate disk use.");
  }
  const safetyMargin = Math.max(512 * 1024 * 1024, Math.ceil(remainingBytes * 0.1));
  return remainingBytes + safetyMargin;
}
