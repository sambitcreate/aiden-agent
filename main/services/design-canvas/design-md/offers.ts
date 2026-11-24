/**
 * The DESIGN.md draft offer, made at most once per workspace and app root
 * (spec S40, R6). The log is `OfferLog` on `design-md-offers.json`, so it
 * holds only HMACs of the folder path and app root, never either.
 */
import path from "node:path";
import { isSafeWorkspaceRelativePath } from "../canvas-config.js";
import { OfferLog, type OfferLogOptions } from "../offer-log.js";
import { designMdOfferSentence } from "./status.js";

export class DesignMdOffers {
  private readonly log: OfferLog;
  /** Offers made but not yet settled, by resolved workspace folder. */
  private readonly pending = new Map<string, Set<string>>();

  constructor(options: OfferLogOptions) {
    this.log = new OfferLog(options);
  }

  /** The offer sentence for this workspace and app root, or "" when it was made before. */
  async offerFor(workspaceRoot: string, appRoot: string): Promise<string> {
    if (!isSafeWorkspaceRelativePath(appRoot)) return "";
    const folder = path.resolve(workspaceRoot);
    const key = await this.log.keyFor(folder, appRoot);
    if (!(await this.log.claim(key))) return "";
    const keys = this.pending.get(folder) ?? new Set<string>();
    keys.add(key);
    this.pending.set(folder, keys);
    return designMdOfferSentence(appRoot);
  }

  /** `delivered` logs this workspace's pending offers; otherwise they're left for a later turn. */
  async settle(workspaceRoot: string, delivered: boolean): Promise<void> {
    const folder = path.resolve(workspaceRoot);
    const keys = this.pending.get(folder);
    if (!keys) return;
    this.pending.delete(folder);
    for (const key of keys) await this.log.settle(key, delivered);
  }
}
