/**
 * The DESIGN.md draft offer, made at most once per workspace and app root
 * (spec S40, R6). The log is `OfferLog` on `design-md-offers.json`, so it
 * holds only HMACs of the folder path and app root, never either.
 */
import path from "node:path";
import { isSafeWorkspaceRelativePath } from "../canvas-config.js";
import { OfferLog, type OfferLogOptions } from "../offer-log.js";
import { designMdOfferSentence } from "./status.js";

/** An offer made: its sentence, and the key its turn settles. */
export type DesignMdOffer = { sentence: string; key: string };

export class DesignMdOffers {
  private readonly log: OfferLog;

  constructor(options: OfferLogOptions) {
    this.log = new OfferLog(options);
  }

  /** The offer for this workspace and app root, or `null` when it was made before or is out now. */
  async offerFor(workspaceRoot: string, appRoot: string): Promise<DesignMdOffer | null> {
    if (!isSafeWorkspaceRelativePath(appRoot)) return null;
    const key = await this.log.keyFor(path.resolve(workspaceRoot), appRoot);
    if (!(await this.log.claim(key))) return null;
    return { sentence: designMdOfferSentence(appRoot), key };
  }

  /**
   * `delivered` logs the offer with this key; otherwise it's left for a later
   * turn. Only the turn that made an offer settles it, so another chat's turn
   * in the same workspace never settles it for that one.
   */
  async settle(key: string, delivered: boolean): Promise<void> {
    await this.log.settle(key, delivered);
  }
}
