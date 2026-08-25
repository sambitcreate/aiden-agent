import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { invalidateBotRuntimeInventoryAuthority } from "./bot-runtime-inventory-lease.js";
import { invalidateSkillDiscoveryCache } from "./skills-discovery.js";

interface WatchedDirectory {
  watcher: FSWatcher;
  filenames: Set<string>;
}

/**
 * Watches only directories that contain discovered skill instruction files.
 * This avoids broad home-directory observation while still fencing edits,
 * atomic replacements, and deletion of every skill admitted into Bot runtime.
 */
export class BotSkillContentWatcher {
  private readonly directories = new Map<string, WatchedDirectory>();

  constructor(
    private readonly onChanged: () => void = () => {
      invalidateSkillDiscoveryCache();
      invalidateBotRuntimeInventoryAuthority("skill_content");
    },
  ) {}

  async watchSkillFiles(skillFiles: readonly string[]): Promise<void> {
    for (const skillFile of new Set(skillFiles)) {
      if (!path.isAbsolute(skillFile) || path.basename(skillFile) !== "SKILL.md") continue;
      const metadata = await fs.lstat(skillFile).catch(() => null);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
      const directory = path.dirname(skillFile);
      const filename = path.basename(skillFile);
      const existing = this.directories.get(directory);
      if (existing) {
        existing.filenames.add(filename);
        continue;
      }
      const filenames = new Set([filename]);
      let watcher: FSWatcher;
      try {
        watcher = watch(directory, { persistent: false }, (_event, changed) => {
          const changedName = changed?.toString();
          // Some platforms omit the filename. Conservatively fence the active
          // Bot authority for any event in this narrowly watched directory.
          if (changedName !== undefined && !filenames.has(changedName)) return;
          this.onChanged();
        });
      } catch {
        // Discovery/revalidation remains the fail-closed fallback if the host
        // cannot establish a watcher for this directory.
        continue;
      }
      watcher.on("error", () => this.onChanged());
      this.directories.set(directory, { watcher, filenames });
    }
  }

  dispose(): void {
    for (const { watcher } of this.directories.values()) watcher.close();
    this.directories.clear();
  }
}
