// The design-system offer: the first time design mode is on in a workspace
// with no design/tokens.css, Aiden reads the workspace's style files and, if
// they set up colours or fonts, offers once to write a tokens file and a
// specimen page from them. It writes them only after the person agrees in
// chat; this only builds the offer and remembers that it was made.
import fs from "node:fs/promises";
import path from "node:path";
import { designSystemOfferLine } from "./design-system.js";
import { findWorkspaceDesignSystem, type DetectedDesignSystem } from "./design-md/style-scan.js";
import { OfferLog } from "./offer-log.js";

export type DesignSystemOffersOptions = {
  /** Where the log of workspaces already offered lives; its hashing key lives beside it with a `.key` suffix. */
  file: () => string;
  /** Overridable for tests. */
  find?: (root: string, signal?: AbortSignal) => Promise<DetectedDesignSystem>;
  now?: () => number;
  /** Told when the log could not be written; the offer still goes out, and may be made once more after a restart. */
  onSaveError?: (error: unknown) => void;
};

/**
 * Builds each workspace's design-system offer at most once. The log keeps an
 * HMAC of the folder path keyed by a random per-install key, never the path,
 * so it says nothing about the person's folders, even to someone guessing
 * likely paths. An offer is logged only once the turn that carried it ended
 * normally (`settle`); a failed or stopped turn leaves it for a later turn.
 * A workspace whose files set up nothing is skipped for the rest of the run
 * without being logged, so adding a theme later counts.
 */
export class DesignSystemOffers {
  private readonly options: DesignSystemOffersOptions;
  private readonly log: OfferLog;
  /** Offers made but not yet settled, by resolved folder path. */
  private readonly pending = new Map<string, string>();

  constructor(options: DesignSystemOffersOptions) {
    this.options = options;
    this.log = new OfferLog({ file: options.file, now: options.now, onSaveError: options.onSaveError });
  }

  /**
   * The offer for `folderPath`, or "" when it already has design/tokens.css,
   * was offered before, or its style files set up nothing. A non-empty offer
   * is held for this run until `settle` says how its turn ended.
   */
  async offerFor(folderPath: string, signal?: AbortSignal): Promise<string> {
    const folder = path.resolve(folderPath);
    const key = await this.log.keyFor(folder);
    if (await hasTokensFile(folder)) return "";
    if (!(await this.log.claim(key))) return "";
    let line = "";
    try {
      line = designSystemOfferLine(await (this.options.find ?? findWorkspaceDesignSystem)(folder, signal));
    } catch (error) {
      // An aborted turn may look again next time; anything else is skipped for this run.
      if (signal?.aborted) await this.log.settle(key, false);
      throw error;
    }
    // A workspace whose files set up nothing stays claimed for the run without being logged.
    if (line) this.pending.set(folder, key);
    return line;
  }

  /**
   * Settles the offer made for `folderPath`: `delivered` logs it as made, so
   * it is not made again even after a restart; otherwise a later turn in
   * this run may make it again. Nothing happens without a pending offer.
   */
  async settle(folderPath: string, delivered: boolean): Promise<void> {
    const folder = path.resolve(folderPath);
    const key = this.pending.get(folder);
    if (key === undefined) return;
    this.pending.delete(folder);
    await this.log.settle(key, delivered);
  }
}

async function hasTokensFile(folderPath: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(folderPath, "design", "tokens.css"));
    return true;
  } catch {
    return false;
  }
}
