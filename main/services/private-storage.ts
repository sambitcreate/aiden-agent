/** POSIX protection for dedicated Aiden state directories. Never chmod ancestors. */
import type { Stats } from "node:fs";
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface PrivateDirectorySymlinkHop {
  path: string;
  target: string;
  requireCurrentUser: boolean;
}

export interface PrivateDirectoryResolution {
  requested: string;
  canonical: string;
  ancestors: string[];
  symlinkHops: PrivateDirectorySymlinkHop[];
  traversedDirectories: string[];
}

function unsafe(target: string): Error {
  return new Error(`Aiden storage must be a private directory or single-link file owned by this user: ${target}`);
}

function verifyOwner(info: Stats, target: string): void {
  if (process.getuid && info.uid !== process.getuid()) throw unsafe(target);
}

/** Reject ancestors another local user could use to replace the directory. */
function verifyAncestors(target: string): void {
  verifyDirectoryChain(dirname(realpathSync(target)));
}

/** Check `directory` itself and every ancestor above it. */
function verifyDirectoryChain(directory: string): void {
  if (process.platform === "win32") return;
  let parent = directory;
  for (;;) {
    const info = lstatSync(parent);
    // A sticky directory such as /tmp protects an owned child from other users.
    const foreignOwner = process.getuid && info.uid !== 0 && info.uid !== process.getuid();
    if (!info.isDirectory() || foreignOwner || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) throw unsafe(parent);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

/**
 * Every symlink met while resolving the requested path, including links inside other links'
 * targets, must belong to this user (or the system) and sit in a folder no other user can
 * change, or another user could swap it after the checks below pass.
 */
function verifyLexicalAliases(requested: string): void {
  if (process.platform === "win32") return;
  const parts = (value: string) => value.split(sep).filter((part) => part !== "" && part !== ".");
  const queue = parts(requested);
  let resolved: string = sep;
  let links = 0;
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part === "..") { resolved = dirname(resolved); continue; }
    const candidate = join(resolved, part);
    let info: Stats;
    try { info = lstatSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (!info.isSymbolicLink()) { resolved = candidate; continue; }
    if (++links > 40) throw unsafe(requested);
    if (process.getuid && info.uid !== 0 && info.uid !== process.getuid()) throw unsafe(candidate);
    // `resolved` is already free of links, so this checks the folder that really holds this one.
    verifyDirectoryChain(resolved);
    const target = readlinkSync(candidate);
    if (isAbsolute(target)) resolved = sep;
    queue.unshift(...parts(target));
  }
}

/**
 * A dedicated root may be a symlink (for example one a dotfile manager made) when the link
 * itself, the folder it sits in and the folder it points to all belong to this user. The
 * protection then applies to the folder the link points to.
 */
export function ensurePrivateDirectory(target: string, existing: "harden" | "reject" = "harden"): void {
  const requested = resolve(target);
  if (requested === dirname(requested) || requested === resolve(homedir())) throw unsafe(target);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  verifyLexicalAliases(requested);
  const link = lstatSync(requested);
  let absolute = requested;
  if (link.isSymbolicLink()) {
    verifyOwner(link, target);
    absolute = realpathSync(requested);
    if (absolute === dirname(absolute)) throw unsafe(target);
  }
  const before = lstatSync(absolute);
  if (!before.isDirectory() || before.isSymbolicLink()) throw unsafe(target);
  verifyOwner(before, target);
  const home = statSync(homedir());
  const canonical = realpathSync(absolute), canonicalHome = realpathSync(homedir());
  const sameHomePath = process.platform === "win32" ? canonical.toLowerCase() === canonicalHome.toLowerCase() : canonical === canonicalHome;
  if (sameHomePath || (before.ino !== 0 && home.ino !== 0 && before.dev === home.dev && before.ino === home.ino)) throw unsafe(target);
  verifyAncestors(absolute);
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const opened = fstatSync(fd);
    verifyOwner(opened, target);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) throw unsafe(target);
    if (process.platform !== "win32") {
      if (existing === "reject" && (opened.mode & 0o077) !== 0) throw unsafe(target);
      if ((opened.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
    }
    const after = lstatSync(absolute);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw unsafe(target);
    // A link retargeted while this ran must not leave the old folder treated as the root.
    if (absolute !== requested && realpathSync(requested) !== absolute) throw unsafe(target);
  } finally { closeSync(fd); }
}

/** Missing files are fine; symlinks, special files and foreign/hard-linked files are not. */
export function hardenPrivateFile(target: string, ownedPublicationPaths: readonly string[] = []): void {
  const validLinks = (info: Stats): boolean => {
    let expected = 1;
    for (const other of new Set(ownedPublicationPaths)) {
      if (resolve(other) === resolve(target)) continue;
      try {
        const alias = lstatSync(other);
        if (alias.isFile() && !alias.isSymbolicLink() && alias.dev === info.dev && alias.ino === info.ino) expected++;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return expected <= 2 && info.nlink === expected;
  };
  let before: Stats;
  try { before = lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || !validLinks(before)) throw unsafe(target);
  verifyOwner(before, target);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    verifyOwner(opened, target);
    if (!opened.isFile() || !validLinks(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw unsafe(target);
    if (process.platform !== "win32" && (opened.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    const after = lstatSync(target);
    if (after.dev !== opened.dev || after.ino !== opened.ino || !validLinks(after)) throw unsafe(target);
  } finally { closeSync(fd); }
}

async function verifyDirectoryChainAsync(directory: string, visitedAncestors?: Set<string>): Promise<void> {
  if (process.platform === "win32") return;
  let parent = directory;
  for (;;) {
    const info = await lstat(parent);
    const foreignOwner = process.getuid && info.uid !== 0 && info.uid !== process.getuid();
    if (!info.isDirectory() || foreignOwner || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
      throw unsafe(parent);
    }
    visitedAncestors?.add(parent);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

async function verifyLexicalAliasesAsync(
  requested: string,
  ancestors: Set<string>,
  symlinkHops: Map<string, { target: string; requireCurrentUser: boolean }>,
  traversedDirs: Set<string>,
): Promise<void> {
  if (process.platform === "win32") return;
  const parts = (value: string) => value.split(sep).filter((part) => part !== "" && part !== ".");
  const queue = parts(requested).map((part, index, list) => ({
    part,
    isRequestedLeaf: index === list.length - 1,
  }));
  let resolved: string = sep;
  let links = 0;
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.part === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const candidate = join(resolved, item.part);
    let info: Stats;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (!info.isSymbolicLink()) {
      resolved = candidate;
      traversedDirs.add(candidate);
      continue;
    }
    if (++links > 40) throw unsafe(requested);
    if (process.getuid && info.uid !== 0 && info.uid !== process.getuid()) throw unsafe(candidate);
    await verifyDirectoryChainAsync(resolved, ancestors);
    const linkTarget = await readlink(candidate);
    symlinkHops.set(candidate, {
      target: linkTarget,
      requireCurrentUser: Boolean(symlinkHops.get(candidate)?.requireCurrentUser || item.isRequestedLeaf),
    });
    if (isAbsolute(linkTarget)) resolved = sep;
    queue.unshift(...parts(linkTarget).map((part) => ({ part, isRequestedLeaf: false })));
  }
}

/** Async counterpart of `ensurePrivateDirectory` returning resolved paths for signature caching. */
export async function ensurePrivateDirectoryAsync(
  target: string,
  existing: "harden" | "reject" = "harden",
): Promise<PrivateDirectoryResolution> {
  const requested = resolve(target);
  if (requested === dirname(requested) || requested === resolve(homedir())) throw unsafe(target);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const ancestors = new Set<string>();
  const symlinkHops = new Map<string, { target: string; requireCurrentUser: boolean }>();
  const traversedDirs = new Set<string>();
  await verifyLexicalAliasesAsync(requested, ancestors, symlinkHops, traversedDirs);
  const link = await lstat(requested);
  let absolute = requested;
  if (link.isSymbolicLink()) {
    verifyOwner(link, target);
    absolute = await realpath(requested);
    if (absolute === dirname(absolute)) throw unsafe(target);
  }
  const before = await lstat(absolute);
  if (!before.isDirectory() || before.isSymbolicLink()) throw unsafe(target);
  verifyOwner(before, target);
  const homePath = homedir();
  const [home, canonical, canonicalHome] = await Promise.all([
    stat(homePath),
    realpath(absolute),
    realpath(homePath),
  ]);
  const sameHomePath =
    process.platform === "win32"
      ? canonical.toLowerCase() === canonicalHome.toLowerCase()
      : canonical === canonicalHome;
  if (
    sameHomePath ||
    (before.ino !== 0 && home.ino !== 0 && before.dev === home.dev && before.ino === home.ino)
  ) {
    throw unsafe(target);
  }
  await verifyDirectoryChainAsync(dirname(canonical), ancestors);
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const opened = await handle.stat();
    verifyOwner(opened, target);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw unsafe(target);
    }
    if (process.platform !== "win32") {
      if (existing === "reject" && (opened.mode & 0o077) !== 0) throw unsafe(target);
      if ((opened.mode & 0o7777) !== 0o700) await handle.chmod(0o700);
    }
    const after = await lstat(absolute);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw unsafe(target);
    }
    if (absolute !== requested && (await realpath(requested)) !== absolute) throw unsafe(target);
  } finally {
    await handle.close();
  }
  return {
    requested,
    canonical,
    ancestors: [...ancestors],
    symlinkHops: [...symlinkHops.entries()].map(([hopPath, hop]) => ({
      path: hopPath,
      target: hop.target,
      requireCurrentUser: hop.requireCurrentUser,
    })),
    traversedDirectories: [...traversedDirs].filter(
      (dir) => dir !== canonical && !ancestors.has(dir),
    ),
  };
}

/** Async counterpart of `hardenPrivateFile`. */
export async function hardenPrivateFileAsync(
  target: string,
  ownedPublicationPaths: Iterable<string> = [],
): Promise<void> {
  const resolvedTarget = resolve(target);
  const currentOwnedOthers = (): string[] => {
    const seen = new Set<string>();
    for (const other of ownedPublicationPaths) {
      const resolvedOther = resolve(other);
      if (resolvedOther !== resolvedTarget) seen.add(resolvedOther);
    }
    return [...seen];
  };
  const lstatOrNull = async (candidate: string): Promise<Stats | null> => {
    try {
      return await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const countMatchingOwnedAliases = async (
    info: Stats,
    others: readonly string[],
  ): Promise<number> => {
    let matches = 0;
    for (const other of others) {
      const alias = await lstatOrNull(other);
      if (
        alias !== null &&
        alias.isFile() &&
        !alias.isSymbolicLink() &&
        alias.dev === info.dev &&
        alias.ino === info.ino
      ) {
        matches += 1;
      }
    }
    return matches;
  };
  const checkLinks = async (
    info: Stats,
    restat: () => Promise<Stats | null>,
  ): Promise<"valid" | "retry" | "unsafe"> => {
    if (info.nlink === 1) return "valid";
    if (info.nlink === 0) return "retry";
    if (info.nlink === 2) {
      const others = currentOwnedOthers();
      if (others.length > 0 && (await countMatchingOwnedAliases(info, others)) === 1) {
        return "valid";
      }
    }
    // An owned staging/held link may have been created or unlinked while we
    // awaited lstat. Re-stat to separate a completed owned transition from an
    // unapproved hard link.
    const refreshed = await restat();
    if (refreshed === null) return "retry";
    if (refreshed.isSymbolicLink() || !refreshed.isFile()) return "unsafe";
    verifyOwner(refreshed, target);
    if (refreshed.dev !== info.dev || refreshed.ino !== info.ino) return "retry";
    if (refreshed.nlink === 1) return "valid";
    if (refreshed.nlink === 0) return "retry";
    if (refreshed.nlink === 2) {
      const latestOthers = currentOwnedOthers();
      if (
        latestOthers.length > 0 &&
        (await countMatchingOwnedAliases(refreshed, latestOthers)) === 1
      ) {
        return "valid";
      }
    }
    return "unsafe";
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await lstatOrNull(target);
    if (before === null) return;
    if (!before.isFile() || before.isSymbolicLink()) throw unsafe(target);
    verifyOwner(before, target);
    const beforeLinks = await checkLinks(before, () => lstatOrNull(target));
    if (beforeLinks === "unsafe") throw unsafe(target);
    if (beforeLinks === "retry") continue;

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "ELOOP" || code === "EMLINK") throw unsafe(target);
      throw error;
    }

    let retry = false;
    try {
      const opened = await handle.stat();
      verifyOwner(opened, target);
      if (!opened.isFile()) throw unsafe(target);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        retry = true;
      } else {
        const openedLinks = await checkLinks(opened, async () => handle.stat());
        if (openedLinks === "unsafe") throw unsafe(target);
        if (process.platform !== "win32" && (opened.mode & 0o7777) !== 0o600) {
          await handle.chmod(0o600);
        }
        if (openedLinks === "retry") {
          const current = await lstatOrNull(target);
          if (current === null) return;
          retry = true;
        } else {
          const after = await lstatOrNull(target);
          if (after === null) return;
          if (after.isSymbolicLink() || !after.isFile()) throw unsafe(target);
          verifyOwner(after, target);
          if (after.dev !== opened.dev || after.ino !== opened.ino) {
            retry = true;
          } else {
            const afterLinks = await checkLinks(after, () => lstatOrNull(target));
            if (afterLinks === "unsafe") throw unsafe(target);
            if (afterLinks === "retry") {
              retry = true;
            } else {
              return;
            }
          }
        }
      }
    } finally {
      await handle.close();
    }
    if (!retry) return;
  }
  throw unsafe(target);
}
