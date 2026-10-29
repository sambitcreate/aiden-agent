import { DataStore } from "./data-store.js";
import {
  aidenRemoteStreamStoreOptions,
  mergeAidenRemoteStreamJournal,
  normalizeAidenRemoteStreamSnapshot,
  type AidenRemoteStreamJournalWrite,
  type AidenRemoteStreamSnapshot,
} from "./aiden-remote-streams.js";

const EMPTY: AidenRemoteStreamSnapshot = { version: 1, streams: [] };

/**
 * The durable Remote stream journal, kept as two files so a streaming turn
 * rewrites only its own events. The archive keeps the established file name,
 * so a journal written by an earlier single-file build loads as the archive
 * and is split on the next write.
 */
export class AidenRemoteStreamJournal {
  private readonly archive: DataStore<AidenRemoteStreamSnapshot>;
  private readonly live: DataStore<AidenRemoteStreamSnapshot>;

  constructor(fileName: string, baseDir: () => string) {
    const liveName = fileName.endsWith(".json")
      ? `${fileName.slice(0, -".json".length)}-live.json`
      : `${fileName}-live`;
    this.archive = new DataStore(fileName, EMPTY, baseDir, aidenRemoteStreamStoreOptions());
    this.live = new DataStore(liveName, EMPTY, baseDir, aidenRemoteStreamStoreOptions());
  }

  async load(): Promise<AidenRemoteStreamSnapshot> {
    const archive = await this.archive.load();
    const live = await this.live.load();
    try {
      return mergeAidenRemoteStreamJournal(archive, live);
    } catch {
      // Each part is valid alone, so only a torn pair can fail to merge;
      // finished history is worth more than an interrupted turn's partial text.
      return normalizeAidenRemoteStreamSnapshot(archive);
    }
  }

  /**
   * Archive first: if the process dies between the two writes, the stream
   * that just finished is still found in its finished form.
   */
  async save(write: AidenRemoteStreamJournalWrite): Promise<void> {
    if (write.archive) await this.archive.save(write.archive);
    await this.live.save(write.live);
  }

  /** Replaces the whole journal, for example after startup revocation cleanup. */
  async replace(snapshot: AidenRemoteStreamSnapshot): Promise<void> {
    await this.save({
      archive: { version: 1, streams: snapshot.streams, turnIndex: [] },
      live: { version: 1, streams: [], turnIndex: snapshot.turnIndex ?? [] },
    });
  }
}
