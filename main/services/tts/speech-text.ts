// Deterministic Markdown → speech-text projection and segmentation.
//
// Pure and bounded: identical input plus reading preferences always produces
// identical output. No LLM rewriting, no link dereferencing, no translation.
// The parser is the same remark stack the chat renderer uses, so what is
// spoken matches what the response displays.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { TTS_LIMITS } from "../../../renderer/shared/tts.js";

export const SPEECH_TEXT_POLICY_VERSION = 1;

/** Reading preferences that affect projection, mirrored from shared settings. */
export interface SpeechReadingPreferences {
  inlineCode: boolean;
  fencedCode: boolean;
}

export interface SpeechPreparation {
  text: string;
  segments: readonly string[];
  omissions: readonly string[];
  policyVersion: number;
}

/** Closed set of projection failure kinds the service maps onto safe errors. */
export type SpeechPreparationError =
  | "source_too_large"
  | "transcript_too_large";

export class SpeechTextError extends Error {
  constructor(
    readonly kind: SpeechPreparationError,
    message: string,
  ) {
    super(message);
    this.name = "SpeechTextError";
  }
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  align?: unknown;
  checked?: boolean | null;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

// Modest-table ceiling: larger tables are skipped with a notice instead of a
// invented summary (plan §5). Generous enough for typical model output.
const MAX_TABLE_ROWS = 12;
const MAX_TABLE_COLUMNS = 6;

class Projection {
  readonly blocks: string[] = [];
  private block: string[] = [];
  readonly omissions: string[] = [];
  private reading: SpeechReadingPreferences = {
    inlineCode: true,
    fencedCode: true,
  };

  private notice(label: string): void {
    if (!this.omissions.includes(label)) this.omissions.push(label);
  }

  private pushInline(text: string): void {
    if (text) this.block.push(text);
  }

  endBlock(): void {
    const joined = this.block
      .join("")
      .replace(/[ \t]+/gu, " ")
      .trim();
    this.block = [];
    if (joined) this.blocks.push(joined);
  }

  /** Inline projection: returns the visible label text of a node's children. */
  inlineChildren(node: MdastNode): string {
    if (!node.children?.length) return "";
    return node.children
      .map((child) => this.inline(child))
      .filter(Boolean)
      .join("")
      .replace(/[ \t]+/gu, " ");
  }

  inline(node: MdastNode): string {
    switch (node.type) {
      case "text":
        return (node.value ?? "").replace(/\s+/gu, " ");
      case "emphasis":
      case "strong":
      case "delete":
      case "heading":
      case "paragraph":
        return this.inlineChildren(node);
      case "inlineCode": {
        if (!this.reading.inlineCode) {
          this.notice("Inline code skipped");
          return "";
        }
        return node.value ?? "";
      }
      case "link":
        return this.inlineChildren(node);
      case "linkReference":
        return this.inlineChildren(node);
      case "image":
      case "imageReference":
        this.notice("Images skipped");
        return "";
      case "inlineMath":
        return node.value ?? "";
      case "footnoteReference":
        return "";
      case "html":
        this.notice("Embedded content skipped");
        return "";
      case "break":
        return " ";
      case "tableCell":
      case "tableRow":
        return this.inlineChildren(node);
      default:
        return this.inlineChildren(node);
    }
  }

  visit(node: MdastNode, reading: SpeechReadingPreferences): void {
    this.reading = reading;
    switch (node.type) {
      case "root":
        for (const child of node.children ?? []) this.visit(child, reading);
        return;
      case "paragraph": {
        this.pushInline(this.inline(node));
        this.endBlock();
        return;
      }
      case "heading": {
        this.pushInline(this.inline(node));
        this.endBlock();
        return;
      }
      case "blockquote":
        for (const child of node.children ?? []) this.visit(child, reading);
        return;
      case "list": {
        let index =
          node.ordered && typeof node.start === "number" && node.start > 0
            ? node.start
            : 1;
        for (const item of node.children ?? []) {
          if (item.type !== "listItem") continue;
          const label = node.ordered ? `${index}. ` : "";
          this.pushInline(label);
          const pieces: string[] = [];
          for (const child of item.children ?? []) {
            if (child.type === "list") {
              this.pushInline(pieces.join("").replace(/[ \t]+/gu, " ").trim());
              this.endBlock();
              pieces.length = 0;
              this.visit(child, reading);
            } else {
              pieces.push(this.inline(child));
            }
          }
          this.pushInline(pieces.join("").replace(/[ \t]+/gu, " ").trim());
          this.endBlock();
          if (node.ordered) index += 1;
        }
        return;
      }
      case "code": {
        if (!reading.fencedCode) {
          this.notice("Code blocks skipped");
          return;
        }
        for (const line of (node.value ?? "").split("\n")) {
          this.pushInline(line.trim());
          this.endBlock();
        }
        return;
      }
      case "inlineCode": {
        if (!reading.inlineCode) {
          this.notice("Inline code skipped");
          return;
        }
        this.pushInline(node.value ?? "");
        return;
      }
      case "math": {
        this.pushInline((node.value ?? "").trim());
        this.endBlock();
        return;
      }
      case "table": {
        const rows = (node.children ?? []).filter(
          (row) => row.type === "tableRow",
        );
        if (rows.length > MAX_TABLE_ROWS) {
          this.notice("Large tables skipped");
          return;
        }
        const headerCells =
          rows[0]?.children?.filter((c) => c.type === "tableCell") ?? [];
        if (headerCells.length > MAX_TABLE_COLUMNS) {
          this.notice("Large tables skipped");
          return;
        }
        const headers = headerCells.map((cell) => this.inline(cell).trim());
        for (const row of rows.slice(1)) {
          const cells =
            row.children?.filter((c) => c.type === "tableCell") ?? [];
          const pairs: string[] = [];
          cells.forEach((cell, index) => {
            const value = this.inline(cell).trim();
            const header = headers[index];
            pairs.push(header && header !== value ? `${header}: ${value}` : value);
          });
          const line = pairs.filter(Boolean).join("; ");
          if (line) {
            this.pushInline(line);
            this.endBlock();
          }
        }
        return;
      }
      case "image":
        this.notice("Images skipped");
        return;
      case "html": {
        this.notice("Embedded content skipped");
        return;
      }
      case "footnoteDefinition":
      case "thematicBreak":
      case "definition":
        return;
      case "listItem":
        // Handled by list; a bare listItem is defensive only.
        this.pushInline(this.inlineChildren(node));
        this.endBlock();
        return;
      default:
        this.pushInline(this.inline(node));
        this.endBlock();
        return;
    }
  }
}

/**
 * Project one response's Markdown body onto speakable plain text plus
 * segmentation and omission notices. Returns null when nothing is speakable.
 * Throws SpeechTextError for bounded-size violations.
 */
export function prepareSpeechText(input: {
  markdown: string;
  reading: SpeechReadingPreferences;
}): SpeechPreparation | null {
  const source = input.markdown;
  if (Buffer.byteLength(source, "utf8") > TTS_LIMITS.sourceMaxBytes) {
    throw new SpeechTextError(
      "source_too_large",
      "This response is too large to read aloud.",
    );
  }
  const projection = new Projection();
  const tree = parser.parse(source) as MdastNode;
  projection.visit(tree, input.reading);
  projection.endBlock();
  const text = projection.blocks.join("\n\n").trim();
  if (!text) return null;
  if (Buffer.byteLength(text, "utf8") > TTS_LIMITS.transcriptMaxBytes) {
    throw new SpeechTextError(
      "transcript_too_large",
      "This response is too large to read aloud.",
    );
  }
  return {
    text,
    segments: segmentSpeechText(text),
    omissions: projection.omissions,
    policyVersion: SPEECH_TEXT_POLICY_VERSION,
  };
}

const SENTENCE_BOUNDARY = /(?<=[.!?;])\s+/u;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Split a long block at sentence boundaries, then at safe character points. */
function splitOversizedBlock(block: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const sentence of block.split(SENTENCE_BOUNDARY)) {
    if (
      current &&
      utf8Bytes(current) + 1 + utf8Bytes(sentence) >
        TTS_LIMITS.segmentMaxBytes
    ) {
      out.push(current);
      current = "";
    }
    if (utf8Bytes(sentence) <= TTS_LIMITS.segmentMaxBytes) {
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }
    if (current) {
      out.push(current);
      current = "";
    }
    // Sentence itself exceeds the hard bound: split at safe boundaries.
    let piece = "";
    let pieceChars = 0;
    for (const char of sentence) {
      if (
        piece &&
        utf8Bytes(piece) + utf8Bytes(char) > TTS_LIMITS.segmentMaxBytes
      ) {
        out.push(piece);
        piece = char;
        pieceChars = 1;
        continue;
      }
      piece += char;
      pieceChars += 1;
    }
    if (piece) out.push(piece);
  }
  if (current) out.push(current);
  return out.filter((part) => part.trim().length > 0).map((p) => p.trim());
}

/**
 * Segment prepared text for sequential synthesis. Paragraph boundaries are
 * preferred, sentences next, and never a surrogate pair or important unit.
 */
export function segmentSpeechText(text: string): string[] {
  const blocks = text.split(/\n{2,}/u).map((b) => b.trim()).filter(Boolean);
  const segments: string[] = [];
  let current = "";
  for (const block of blocks) {
    const blockBytes = utf8Bytes(block);
    if (blockBytes > TTS_LIMITS.segmentMaxBytes) {
      if (current) {
        segments.push(current);
        current = "";
      }
      segments.push(...splitOversizedBlock(block));
      continue;
    }
    if (
      current &&
      utf8Bytes(current) + 2 + blockBytes > TTS_LIMITS.segmentTargetMaxChars
    ) {
      segments.push(current);
      current = block;
      continue;
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) segments.push(current);
  return segments;
}
