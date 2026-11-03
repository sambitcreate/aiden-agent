import type { DatabaseSync } from "node:sqlite";

// Configure before creating any tables. Existing stores keep their file format;
// converting them would require a blocking full VACUUM and extra disk space.
export function initializeSqliteReclamation(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
    database.exec("PRAGMA auto_vacuum=INCREMENTAL");
  }
}

/** At most 128 free pages per lifecycle pass, outside application transactions. */
export function reclaimSqlitePages(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA incremental_vacuum(128)");
  } catch {
    // Housekeeping cannot fail a committed write or prevent closing a handle.
    // A busy connection can try again on its next open/close.
  }
}
