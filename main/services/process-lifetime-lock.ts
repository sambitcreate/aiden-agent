import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const heldPaths = new Set<string>();

/**
 * A permanent SQLite pathname is the synchronization object. Never remove or
 * replace it: doing so would let a second inode admit a second owner. SQLite
 * releases the transaction when the process dies, including after SIGKILL.
 */
export function tryAcquireProcessLifetimeLock(file: string): (() => void) | null {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(file)), basename(file));
  if (heldPaths.has(canonical)) return null;
  heldPaths.add(canonical);
  let db: DatabaseSync | undefined;
  try {
    const fd = openSync(canonical, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      heldPaths.delete(canonical);
      throw error;
    }
  }
  try {
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error(`Unsafe lease guard at ${canonical}`);
    }
    db = new DatabaseSync(canonical);
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode !== "delete") throw new Error(`Unsupported lease guard journal mode at ${canonical}`);
    // A malformed guard is never discarded as stale debris.
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok") throw new Error(`Corrupt lease guard at ${canonical}`);
  } catch (error) {
    db?.close();
    heldPaths.delete(canonical);
    if ((error as { code?: string }).code === "ERR_SQLITE_ERROR" &&
        /database is locked|database table is locked/iu.test(String(error))) return null;
    throw error;
  }
  const heldDatabase = db;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { heldDatabase.exec("ROLLBACK"); }
    finally {
      heldDatabase.close();
      heldPaths.delete(canonical);
    }
  };
}
