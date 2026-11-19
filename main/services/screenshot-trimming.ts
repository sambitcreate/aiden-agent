// Screenshots in a model request, trimmed in batches.
//
// A prompt cache reuses only a byte-identical prefix. Dropping the oldest
// screenshot on every step (a fixed window) edits an earlier message on every
// request, so the cache misses from that message on, every time. Instead a
// request carries every screenshot until the kept ones pass a high-water mark
// (`maxImages` or `maxBytes`), and then the oldest are cut in one go, down to
// `keepImages` and `keepBytes`. Between cuts earlier messages stay
// byte-identical and only new ones are appended.
//
// The cut is a pure function of the transcript, simulated in order: replaying
// the same history always cuts at the same screenshot, so a retried or resumed
// request renders the same bytes. A cut image leaves its tool's fixed note in
// its place, so the replacement is the same bytes every time too.
//
// The workspace chat projection (`generation-context.ts`) and the Bot runtime
// (`bot-runtime/bot-extension.ts`, on the desktop and under `aiden serve`) both
// trim through this module, with the same thresholds and the same screenshot
// tools, counted together: one request limit covers them all. Only the request
// is trimmed; the stored transcript keeps every image.

import { BOT_COMPUTER_TOOL_NAME } from "./bot-computers/types.js";
import { COMPUTER_USE_TOOL_NAME } from "./computer-use/tool.js";

/** The batch thresholds, shared by workspace chats and Bots. */
export interface ScreenshotTrimLimits {
  /** A cut happens once more than this many screenshots are kept. */
  readonly maxImages: number;
  /** ...or once the kept screenshots pass this many bytes (base64, as sent). */
  readonly maxBytes: number;
  /** A cut leaves at most this many screenshots... */
  readonly keepImages: number;
  /** ...and at most this many bytes. The newest screenshot always stays. */
  readonly keepBytes: number;
}

const MIB = 1024 * 1024;

/**
 * The byte marks stay below the smallest whole-request inline image limit of
 * the providers that take screenshots (Gemini's is about 20 MB), so a cut
 * comes before a provider refuses the request. One fixed rule for every
 * provider keeps the cut a function of the transcript alone.
 */
export const SCREENSHOT_TRIM_LIMITS: ScreenshotTrimLimits = Object.freeze({
  maxImages: 8,
  maxBytes: 15 * MIB,
  keepImages: 3,
  keepBytes: 8 * MIB,
});

/** What a cut browser screenshot leaves in a request, so the model knows to look again. */
export const OLDER_BROWSER_SCREENSHOT_NOTE =
  "An older screenshot was left out of this request. Take a new snapshot to see the page now.";

/** What a cut screen capture leaves in a request. */
export const OLDER_COMPUTER_SCREENSHOT_NOTE =
  "An older screenshot was left out of this request. Take a new capture to see the screen now.";

/**
 * The tools whose screenshots are trimmed, with the note each cut screenshot
 * leaves: Computer Use on this Mac, a Bot's own computer, and the browser.
 * Images from any other tool, or that the person attached, are never cut.
 */
export const SCREENSHOT_TOOL_NOTES: Readonly<Record<string, string>> = Object.freeze({
  [COMPUTER_USE_TOOL_NAME]: OLDER_COMPUTER_SCREENSHOT_NOTE,
  [BOT_COMPUTER_TOOL_NAME]: OLDER_COMPUTER_SCREENSHOT_NOTE,
  browser_snapshot: OLDER_BROWSER_SCREENSHOT_NOTE,
});

/**
 * How many of the oldest screenshots a request leaves out, given every
 * screenshot's size in transcript order. Cuts only ever drop the oldest kept
 * screenshots, so the answer for a longer history never un-drops one that a
 * shorter history dropped.
 */
export function screenshotsLeftOut(
  sizes: readonly number[],
  limits: ScreenshotTrimLimits = SCREENSHOT_TRIM_LIMITS,
): number {
  let first = 0;
  let bytes = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    bytes += sizes[index]!;
    const kept = index + 1 - first;
    if (kept <= limits.maxImages && bytes <= limits.maxBytes) continue;
    while (index + 1 - first > 1 && (index + 1 - first > limits.keepImages || bytes > limits.keepBytes)) {
      bytes -= sizes[first]!;
      first += 1;
    }
  }
  return first;
}

type TrimmablePart = { type: string; data?: unknown };
type TrimmableMessage = { role?: unknown; toolName?: unknown; content?: unknown };

/**
 * The request's messages with the screenshots a batch cut leaves out replaced
 * by their tool's note. `notes` maps each screenshot tool's name to its note;
 * images from any other tool or from the person are untouched and not
 * counted. Returns `messages` itself when nothing is cut.
 */
export function trimScreenshots<M>(
  messages: readonly M[],
  notes: Readonly<Record<string, string>> = SCREENSHOT_TOOL_NOTES,
  limits: ScreenshotTrimLimits = SCREENSHOT_TRIM_LIMITS,
): readonly M[] {
  const positions: Array<{ message: number; part: number }> = [];
  const sizes: number[] = [];
  messages.forEach((value, message) => {
    const candidate = value as TrimmableMessage;
    if (candidate.role !== "toolResult" || typeof candidate.toolName !== "string") return;
    if (!Object.prototype.hasOwnProperty.call(notes, candidate.toolName) || !Array.isArray(candidate.content)) return;
    (candidate.content as TrimmablePart[]).forEach((part, index) => {
      if (part?.type !== "image") return;
      positions.push({ message, part: index });
      sizes.push(typeof part.data === "string" ? part.data.length : 0);
    });
  });
  const leftOut = screenshotsLeftOut(sizes, limits);
  if (leftOut === 0) return messages;
  const cut = new Map<number, Set<number>>();
  for (const { message, part } of positions.slice(0, leftOut)) {
    const parts = cut.get(message) ?? new Set<number>();
    parts.add(part);
    cut.set(message, parts);
  }
  return messages.map((value, message) => {
    const parts = cut.get(message);
    if (!parts) return value;
    const candidate = value as TrimmableMessage & { toolName: string; content: TrimmablePart[] };
    const note = notes[candidate.toolName]!;
    return {
      ...candidate,
      content: candidate.content.map((part, index) => (parts.has(index) ? { type: "text", text: note } : part)),
    } as M;
  });
}
