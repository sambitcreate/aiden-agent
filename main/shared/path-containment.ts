/**
 * One path-containment check for the main process.
 *
 * `path.relative` is the only reliable comparison: prefix checks accept
 * siblings such as `/root-evil`, and a bare `startsWith("..")` wrongly rejects
 * in-root names such as `..cache`. Lexical checks do not follow symlinks; use
 * {@link resolveRealPathInside} when the candidate may traverse a link.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

export interface PathContainmentOptions {
  /** Whether the root itself counts as inside. Defaults to true. */
  readonly allowRoot?: boolean;
  /** Path flavor to compare with. Defaults to the host platform. */
  readonly pathApi?: path.PlatformPath;
}

/** Lexically decide whether `candidate` is `root` or a descendant of it. */
export function isPathInside(
  root: string,
  candidate: string,
  options: PathContainmentOptions = {},
): boolean {
  const pathApi = options.pathApi ?? path;
  const relative = pathApi.relative(root, candidate);
  if (relative === "") return options.allowRoot ?? true;
  return (
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

/** Throw `message` unless `candidate` is lexically inside `root`. */
export function assertPathInside(
  root: string,
  candidate: string,
  message: string,
  options: PathContainmentOptions = {},
): void {
  if (!isPathInside(root, candidate, options)) throw new Error(message);
}

/**
 * Canonicalize both paths through the filesystem (following symlinks) and
 * return the candidate's real path when it stays inside the real root, or
 * null when it escapes. Filesystem errors such as ENOENT propagate.
 */
export async function resolveRealPathInside(
  root: string,
  candidate: string,
  options: Omit<PathContainmentOptions, "pathApi"> = {},
): Promise<string | null> {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  return isPathInside(realRoot, realCandidate, options) ? realCandidate : null;
}
