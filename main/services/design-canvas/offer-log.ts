// A log of one-time offers Aiden has made in a workspace, shared by v1's
// tokens offer and the DESIGN.md draft offer (spec S40). It keeps an HMAC of
// each offer's key parts (the folder path, and the app root for DESIGN.md)
// with a random per-install key, never the parts themselves, so it says
// nothing about the person's folders even to someone guessing likely paths.
//
// An offer is claimed for the run when it's made and logged only once the
// turn that carried it ended normally (`settle(key, true)`); a failed or
// stopped turn releases it for a later turn.
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../durable-fs.js";

/** Entries remembered; the oldest are forgotten past this. */
const MAX_REMEMBERED = 1_000;
const HEX_KEY = /^[0-9a-f]{64}$/u;

/** Version 2 keys the log with a per-install HMAC; version 1's plain hashes are ignored. */
type OffersFile = { version: 2; offered: Record<string, number> };

export type OfferLogOptions = {
  /** Where the log lives; its hashing key lives beside it with a `.key` suffix. */
  file: () => string;
  now?: () => number;
  /** Told when the log could not be written; the offer still went out, and may be made once more after a restart. */
  onSaveError?: (error: unknown) => void;
};

export class OfferLog {
  private readonly options: OfferLogOptions;
  private loaded: Promise<Map<string, number>> | undefined;
  private hashKey: Promise<Buffer> | undefined;
  private writes: Promise<void> = Promise.resolve();
  /** Keys claimed in this run, logged or not. */
  private readonly claimed = new Set<string>();

  constructor(options: OfferLogOptions) {
    this.options = options;
  }

  /** The HMAC of `parts`, joined with NUL; one part hashes as itself, as today's log does. */
  async keyFor(...parts: string[]): Promise<string> {
    return createHmac("sha256", await this.loadHashKey()).update(parts.join("\u0000")).digest("hex");
  }

  /** True when `key` was neither logged nor claimed in this run; it's then claimed until `settle`. */
  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    const offered = await this.load();
    if (offered.has(key) || this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  /** `delivered` logs a claimed key; otherwise the claim is released for a later turn. */
  async settle(key: string, delivered: boolean): Promise<void> {
    if (!delivered) {
      this.claimed.delete(key);
      return;
    }
    const offered = await this.load();
    offered.set(key, (this.options.now ?? Date.now)());
    await this.save(offered).catch((error: unknown) => this.options.onSaveError?.(error));
  }

  /**
   * The install's random hashing key, made on first use with owner-only
   * access. A key that cannot be read or written is replaced with one kept
   * for this run only, so at worst an offer is made once more.
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
      // A missing or unreadable log counts as empty: at worst an offer is made once more.
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
