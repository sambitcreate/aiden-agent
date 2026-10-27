/** POSIX protection for dedicated Aiden state directories. Never chmod ancestors. */
import type { Stats } from "node:fs";
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

function unsafe(target: string): Error {
  return new Error(`Aiden storage must be a private directory or single-link file owned by this user: ${target}`);
}

function verifyOwner(info: Stats, target: string): void {
  if (process.getuid && info.uid !== process.getuid()) throw unsafe(target);
}

/** Reject ancestors another local user could use to replace the directory. */
function verifyAncestors(target: string): void {
  if (process.platform === "win32") return;
  let parent = dirname(realpathSync(target));
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

export function ensurePrivateDirectory(target: string, existing: "harden" | "reject" = "harden"): void {
  const absolute = resolve(target);
  if (absolute === dirname(absolute) || absolute === resolve(homedir())) throw unsafe(target);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
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
      fchmodSync(fd, 0o700);
    }
    const after = lstatSync(absolute);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw unsafe(target);
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
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    const after = lstatSync(target);
    if (after.dev !== opened.dev || after.ino !== opened.ino || !validLinks(after)) throw unsafe(target);
  } finally { closeSync(fd); }
}
