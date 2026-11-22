// The design-system offer: the first time design mode is on in a workspace
// with no design/tokens.css, Aiden reads the workspace's style files and, if
// they set up colours or fonts, offers once to write a tokens file and a
// specimen page from them. It writes them only after the person agrees in
// chat; this only builds the offer and remembers that it was made.
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../durable-fs.js";
import { isProtectedCredentialPath } from "../model-file-policy.js";
import { listWorkspaceFiles, readWorkspaceFile } from "../workspace-files.js";
import {
  designSystemFileRank,
  designSystemOfferLine,
  detectDesignSystem,
  type DesignSystemFile,
  type DetectedDesignSystem,
} from "./design-system.js";

/** Style files read per workspace, most telling first. */
const MAX_FILES = 12;
/** Bigger style files are generated or vendored, not where a design system is set up. */
const MAX_FILE_BYTES = 256 * 1024;
/** Workspaces remembered as offered; the oldest are forgotten past this. */
const MAX_REMEMBERED = 1_000;

/** The colours and fonts the style files in `root` set up, reading at most a dozen small files. */
export async function findWorkspaceDesignSystem(root: string, signal?: AbortSignal): Promise<DetectedDesignSystem> {
  const index = await listWorkspaceFiles(root, signal);
  const candidates = index.entries
    .filter((entry) => entry.kind === "file" && !entry.symbolic && (entry.size ?? 0) <= MAX_FILE_BYTES)
    .filter((entry) => !isProtectedCredentialPath(entry.path, "file"))
    .map((entry) => ({ path: entry.path, rank: designSystemFileRank(entry.path) }))
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => right.rank - left.rank || left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path))
    .slice(0, MAX_FILES);
  const files: DesignSystemFile[] = [];
  for (const candidate of candidates) {
    try {
      const document = await readWorkspaceFile(root, candidate.path, signal, { maxBytes: MAX_FILE_BYTES });
      files.push({ path: document.path, text: document.content });
    } catch (error) {
      if (signal?.aborted) throw error;
      // A file that vanished or cannot be read just adds nothing.
    }
  }
  return detectDesignSystem(files);
}

/** Version 2 keys the log with a per-install HMAC; version 1's plain hashes are ignored. */
type OffersFile = { version: 2; offered: Record<string, number> };

const HEX_KEY = /^[0-9a-f]{64}$/u;

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
  private loaded: Promise<Map<string, number>> | undefined;
  private hashKey: Promise<Buffer> | undefined;
  private writes: Promise<void> = Promise.resolve();
  /** Workspaces looked at in this run, offered or not. */
  private readonly claimed = new Set<string>();
  /** Offers made but not yet settled, by resolved folder path. */
  private readonly pending = new Map<string, string>();

  constructor(options: DesignSystemOffersOptions) {
    this.options = options;
  }

  /**
   * The offer for `folderPath`, or "" when it already has design/tokens.css,
   * was offered before, or its style files set up nothing. A non-empty offer
   * is held for this run until `settle` says how its turn ended.
   */
  async offerFor(folderPath: string, signal?: AbortSignal): Promise<string> {
    const folder = path.resolve(folderPath);
    const key = await this.keyFor(folder);
    if (this.claimed.has(key)) return "";
    if (await hasTokensFile(folder)) return "";
    const offered = await this.load();
    if (offered.has(key) || this.claimed.has(key)) return "";
    this.claimed.add(key);
    let line = "";
    try {
      line = designSystemOfferLine(await (this.options.find ?? findWorkspaceDesignSystem)(folder, signal));
    } catch (error) {
      // An aborted turn may look again next time; anything else is skipped for this run.
      if (signal?.aborted) this.claimed.delete(key);
      throw error;
    }
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
    if (!delivered) {
      this.claimed.delete(key);
      return;
    }
    const offered = await this.load();
    offered.set(key, (this.options.now ?? Date.now)());
    await this.save(offered).catch((error: unknown) => this.options.onSaveError?.(error));
  }

  private async keyFor(folder: string): Promise<string> {
    return createHmac("sha256", await this.loadHashKey()).update(folder).digest("hex");
  }

  /**
   * The install's random hashing key, made on first use with owner-only
   * access. A key that cannot be read or written is replaced with one kept
   * for this run only, so at worst a workspace is offered once more.
   */
  private loadHashKey(): Promise<Buffer> {
    this.hashKey ??= (async () => {
      const file = `${this.options.file()}.key`;
      try {
        const text = (await fs.readFile(file, "utf8")).trim();
        if (HEX_KEY.test(text)) return Buffer.from(text, "hex");
      } catch {
        // Missing or unreadable: make one below.
      }
      const key = randomBytes(32);
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${key.toString("hex")}\n`, { mode: 0o600 });
        await fs.chmod(file, 0o600);
      } catch {
        // Kept in memory for this run.
      }
      return key;
    })();
    return this.hashKey;
  }

  private load(): Promise<Map<string, number>> {
    this.loaded ??= fs
      .readFile(this.options.file(), "utf8")
      .then((text) => {
        const parsed = JSON.parse(text) as Partial<OffersFile>;
        const entries = parsed?.version === 2 && parsed.offered && typeof parsed.offered === "object" ? Object.entries(parsed.offered) : [];
        return new Map(entries.filter((entry): entry is [string, number] => HEX_KEY.test(entry[0]) && Number.isFinite(entry[1])));
      })
      // A missing or unreadable log counts as empty: at worst a workspace is offered once more.
      .catch(() => new Map<string, number>());
    return this.loaded;
  }

  private save(offered: Map<string, number>): Promise<void> {
    const write = this.writes.then(async () => {
      const kept = [...offered.entries()].sort((left, right) => right[1] - left[1]).slice(0, MAX_REMEMBERED);
      if (kept.length < offered.size) {
        offered.clear();
        for (const [key, at] of kept) offered.set(key, at);
      }
      const file = this.options.file();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeJsonAtomic(file, { version: 2, offered: Object.fromEntries(kept) } satisfies OffersFile);
    });
    this.writes = write.catch(() => undefined);
    return write;
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
