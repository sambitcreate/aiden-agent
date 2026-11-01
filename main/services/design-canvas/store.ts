// Per-chat design canvas documents: `<root>/<chatId>.json`, one atomic file
// per chat. Every read and write for a chat runs on that chat's promise chain,
// so a compare-and-swap save and an Aiden-side `update` never interleave.

import * as fs from "node:fs/promises";
import path from "node:path";
import {
  emptyDesignCanvas,
  parseDesignCanvasV1,
  type DesignCanvasV1,
} from "../../../renderer/shared/design-canvas/schema.js";
import { writeJsonAtomic } from "../durable-fs.js";

export type DesignCanvasSaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict"; doc: DesignCanvasV1 }
  | { ok: false; reason: "invalid"; issues: string[] };

/** Same alphabet and bound as the chat store's file names. */
const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
/** A canvas holds at most 200 frames and 500 comments; anything larger is not ours. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

export function assertDesignCanvasChatId(chatId: unknown): asserts chatId is string {
  if (
    typeof chatId !== "string" ||
    !SAFE_CHAT_ID.test(chatId) ||
    chatId === "." ||
    chatId === ".."
  ) {
    throw new Error("Invalid chat id.");
  }
}

export class DesignCanvasStore {
  private readonly root: () => string;
  private readonly writeJson: typeof writeJsonAtomic;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(options: { root: () => string; writeJson?: typeof writeJsonAtomic }) {
    this.root = options.root;
    this.writeJson = options.writeJson ?? writeJsonAtomic;
  }

  /** The chat's canvas, or `emptyDesignCanvas()` when it has none or its file is unreadable. */
  async get(chatId: string): Promise<DesignCanvasV1> {
    assertDesignCanvasChatId(chatId);
    return this.serialize(chatId, () => this.read(chatId));
  }

  /** Stores `doc` as `baseRevision + 1` only if `baseRevision` is still the stored revision. */
  async save(
    chatId: string,
    doc: DesignCanvasV1,
    baseRevision: number,
  ): Promise<DesignCanvasSaveResult> {
    assertDesignCanvasChatId(chatId);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new Error("Invalid canvas revision.");
    }
    const parsed = parseDesignCanvasV1(isRecord(doc) ? { ...doc, revision: baseRevision } : doc);
    if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues };
    return this.serialize(chatId, async () => {
      const current = await this.read(chatId);
      if (current.revision !== baseRevision) return { ok: false, reason: "conflict", doc: current };
      const revision = baseRevision + 1;
      await this.write(chatId, { ...parsed.doc, revision });
      return { ok: true, revision };
    });
  }

  /** Applies `mutate` to the latest canvas and stores the result at the next revision. */
  async update(
    chatId: string,
    mutate: (doc: DesignCanvasV1) => DesignCanvasV1,
  ): Promise<DesignCanvasV1> {
    assertDesignCanvasChatId(chatId);
    return this.serialize(chatId, async () => {
      const current = await this.read(chatId);
      const next = mutate(structuredClone(current));
      const revision = current.revision + 1;
      const parsed = parseDesignCanvasV1(isRecord(next) ? { ...next, revision } : next);
      if (!parsed.ok) throw new Error(`The canvas update is invalid: ${parsed.issues.join(" ")}`);
      await this.write(chatId, parsed.doc);
      return parsed.doc;
    });
  }

  /** Removes the chat's canvas file. Missing is fine. */
  async delete(chatId: string): Promise<void> {
    assertDesignCanvasChatId(chatId);
    return this.serialize(chatId, () => fs.rm(this.file(chatId), { force: true }));
  }

  private file(chatId: string): string {
    return path.join(this.root(), `${chatId}.json`);
  }

  private async read(chatId: string): Promise<DesignCanvasV1> {
    let text: string;
    try {
      const file = this.file(chatId);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return emptyDesignCanvas();
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return emptyDesignCanvas();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return emptyDesignCanvas();
    }
    const parsed = parseDesignCanvasV1(value);
    return parsed.ok ? parsed.doc : emptyDesignCanvas();
  }

  private write(chatId: string, doc: DesignCanvasV1): Promise<void> {
    return this.writeJson(this.file(chatId), doc, { mode: 0o600, mkdirMode: 0o700 });
  }

  private serialize<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(chatId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    this.chains.set(chatId, tail);
    void tail.then(() => {
      if (this.chains.get(chatId) === tail) this.chains.delete(chatId);
    });
    return run;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
