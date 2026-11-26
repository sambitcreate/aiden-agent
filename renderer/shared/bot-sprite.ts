// Hi-bit pixel sprites, the one Bot avatar look (plan: docs/plans/hibit-sprite-avatars-plan.md).
// Pure data and geometry shared by every desktop surface that draws a Bot's fallback face: the
// eight curated bodies, the twelve tone sets, the 16×16 expansion, the face and prop geometry,
// and the avatar states with their mapping from a Bot's live activity. iOS and Android implement
// the same contract; `protocol/aiden-remote/v1/fixtures/contract.json` (`botAvatarSprite`) is the
// shared oracle every platform's tests compare against. No React here.

import type { BotActivityPhase } from "./bot-activity.js";
import { BOT_AVATAR_COLOR_HEX, type BotAvatarColor, type BotAvatarShape } from "./bots.js";

export const BOT_SPRITE_GRID_SIZE = 16;
export const BOT_SPRITE_VIEWBOX = 48;
/**
 * At or below this rendered size the sprite uses the small cut: no highlight cells, larger eyes,
 * and a white eye glint in place of the `light` one.
 */
export const BOT_SPRITE_SMALL_MAX_PX = 24;
/**
 * The small cut's eye glint, the same in light and dark appearance since it sits on the `deep`
 * eye. Eyes stay `deep` at every size; the glint shows only while they are open.
 */
export const BOT_SPRITE_SMALL_GLINT_HEX = "#FFFFFF";
const CELL = BOT_SPRITE_VIEWBOX / BOT_SPRITE_GRID_SIZE;

/**
 * Half-bodies: twelve rows of six half-columns, mirrored around the centre.
 * `1` is body, `2` is an inner outline cell, `0` is empty (the outline is added automatically).
 */
export const BOT_SPRITE_BODIES: Readonly<Record<BotAvatarShape, string>> = {
  wisp: "000000/000011/000111/002111/002111/001111/111111/111211/012111/001111/001101/001000",
  orb: "000000/000011/000111/001111/001111/011111/121111/012111/002112/001111/000010/001000",
  drop: "000010/000111/000111/002111/001111/011111/111111/121111/001111/001111/000111/001100",
  hex: "000010/000111/000121/011111/011111/001111/021111/021211/011111/001101/000000/000000",
  cloud: "000001/000011/000211/001111/002111/011111/021111/021111/011112/012101/001111/000000",
  peak: "000010/000011/000111/001111/001111/001111/011111/111111/002111/011111/001000/001100",
  squircle: "000000/000111/000111/001111/012111/011111/021111/011111/012111/012111/001111/001000",
  capsule: "000001/000122/001111/011111/011111/001111/011111/011211/012111/001111/001011/001000",
};

export interface BotSpriteTones {
  /** Body cells. */
  tint: string;
  /** Outline cells and the plug arm. */
  shade: string;
  /** Eyes at every size and pose, and the happy/wince strokes. */
  deep: string;
  /** Highlight cells and the full-size eye glint. */
  light: string;
  /** State props (thought dots, plug, cursor) in light appearance. */
  markLight: string;
  /** State props in dark appearance. */
  markDark: string;
}

/** The tones each tint adds; `tint` and `markDark` are the tint itself (`BOT_AVATAR_COLOR_HEX`). */
const BOT_SPRITE_SHADES: Readonly<Record<BotAvatarColor, Pick<BotSpriteTones, "shade" | "deep" | "light" | "markLight">>> = {
  lilac: { shade: "#A87EEE", deep: "#42246C", light: "#F8F5FE", markLight: "#8C58D8" },
  sky: { shade: "#2EB7EB", deep: "#003E54", light: "#EFF9FD", markLight: "#0686B0" },
  mint: { shade: "#35CB84", deep: "#004427", light: "#E8FDF0", markLight: "#0E915A" },
  sun: { shade: "#E4B416", deep: "#463502", light: "#FEF6E2", markLight: "#96760D" },
  periwinkle: { shade: "#8C96EE", deep: "#2C2C74", light: "#F5F6FC", markLight: "#676ED0" },
  coral: { shade: "#EB6F6E", deep: "#681118", light: "#FFF4F3", markLight: "#CE4146" },
  peach: { shade: "#E89858", deep: "#562B01", light: "#FDF5EF", markLight: "#B4620A" },
  aqua: { shade: "#16C8BE", deep: "#06413E", light: "#E3FDFA", markLight: "#008D86" },
  rose: { shade: "#E973A6", deep: "#63123B", light: "#FEF4F7", markLight: "#C64080" },
  lime: { shade: "#9DCB1D", deep: "#2E3F01", light: "#F2FAE6", markLight: "#678800" },
  plum: { shade: "#C27CDD", deep: "#4F1E60", light: "#FBF4FE", markLight: "#A251C0" },
  graphite: { shade: "#A2A1B3", deep: "#36354B", light: "#F6F6F9", markLight: "#797988" },
};

export const BOT_SPRITE_TONES: Readonly<Record<BotAvatarColor, BotSpriteTones>> = Object.fromEntries(
  Object.entries(BOT_SPRITE_SHADES).map(([color, shades]) => {
    const tint = BOT_AVATAR_COLOR_HEX[color as BotAvatarColor];
    return [color, { tint, ...shades, markDark: tint }];
  }),
) as Record<BotAvatarColor, BotSpriteTones>;

/** One grid cell: `.` empty, `o` outline (shade), `b` body (tint), `h` highlight (light). */
export type BotSpriteCell = "." | "o" | "b" | "h";

/** Whether a sprite drawn at `renderedPx` CSS pixels uses the small cut. */
export function botSpriteIsSmall(renderedPx: number): boolean {
  return renderedPx <= BOT_SPRITE_SMALL_MAX_PX;
}

/**
 * Expands a body into its 16×16 grid, one string per row (spec steps 1–5). `small` is the
 * small cut: every body cell is `b`, with no highlight.
 */
export function botSpriteGrid(shape: BotAvatarShape, small: boolean): string[] {
  const n = BOT_SPRITE_GRID_SIZE;
  const body = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const outline = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  BOT_SPRITE_BODIES[shape].split("/").forEach((row, ry) => {
    [...row].forEach((value, h) => {
      const y = ry + 2;
      const target = value === "1" ? body : value === "2" ? outline : null;
      if (target) target[y]![2 + h] = target[y]![13 - h] = true;
    });
  });
  const isBody = (y: number, x: number) => body[y]?.[x] === true;
  const four = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const;
  const eight = [...four, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!isBody(y, x) && four.some(([dy, dx]) => isBody(y + dy, x + dx))) outline[y]![x] = true;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (outline[y]![x] && !eight.some(([dy, dx]) => isBody(y + dy, x + dx))) outline[y]![x] = false;
    }
  }
  return body.map((row, y) =>
    row
      .map((b, x): BotSpriteCell => {
        if (b) return !small && y < 9 && !isBody(y - 1, x) ? "h" : "b";
        return outline[y]![x] ? "o" : ".";
      })
      .join(""),
  );
}

/** The first grid row with any body or outline cell. */
function botSpriteTop(grid: readonly string[]): number {
  const index = grid.findIndex((row) => /[obh]/u.test(row));
  return index === -1 ? BOT_SPRITE_GRID_SIZE - 1 : index;
}

export interface BotSpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A run of same-tone cells in one row, drawn as one rect. Runs never cross a column pair. */
interface BotSpriteRun extends BotSpriteRect {
  cell: Exclude<BotSpriteCell, ".">;
  /** Column pair (`x >> 1`), the typing stagger. */
  column: number;
}

interface BotSpriteRow {
  /** Grid row. */
  y: number;
  /** Row pair (`y >> 1`), the scan stagger. */
  pair: number;
  runs: BotSpriteRun[];
}

/** The grid as drawable rows on the 48 viewBox (spec step 6), merging cells within a column pair. */
export function botSpriteRows(grid: readonly string[]): BotSpriteRow[] {
  const rows: BotSpriteRow[] = [];
  grid.forEach((line, y) => {
    const runs: BotSpriteRun[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line[x] as BotSpriteCell;
      if (cell === ".") continue;
      const previous = runs[runs.length - 1];
      if (previous && previous.cell === cell && previous.column === x >> 1 && previous.x + previous.width === x * CELL) {
        previous.width += CELL;
      } else {
        runs.push({ cell, column: x >> 1, x: x * CELL, y: y * CELL, width: CELL, height: CELL });
      }
    }
    if (runs.length) rows.push({ y, pair: y >> 1, runs });
  });
  return rows;
}

const EYE_COLUMNS = [15, 27] as const;
const EYE_Y = 18;

export interface BotSpriteFace {
  /** Open eyes, left then right. */
  eyes: [BotSpriteRect, BotSpriteRect];
  /**
   * The glint at each eye's top-left, 0.42 × the eye's shorter side: `light` at full size,
   * white (`BOT_SPRITE_SMALL_GLINT_HEX`) at the small cut. Open eyes only.
   */
  glints: [BotSpriteRect, BotSpriteRect];
  /** Stroke width of the happy and wince eyes. */
  strokeWidth: number;
  /** `^ ^` for done. */
  happy: [string, string];
  /** `> <` for error. */
  wince: [string, string];
}

const fmt = (value: number) => String(Math.round(value * 1000) / 1000);

export function botSpriteFace(small: boolean): BotSpriteFace {
  const eyes = EYE_COLUMNS.map((x) =>
    small ? { x, y: EYE_Y, width: 6, height: 6 } : { x: x + 0.5, y: EYE_Y, width: 5, height: 6 },
  ) as [BotSpriteRect, BotSpriteRect];
  const sw = small ? 2.4 : 1.6;
  const glints = eyes.map((eye) => {
    const size = Math.min(eye.width, eye.height) * 0.42;
    return { x: eye.x, y: eye.y, width: size, height: size };
  }) as [BotSpriteRect, BotSpriteRect];
  const happy = eyes.map(({ x, y, width: w, height: h }) =>
    `M${fmt(x + sw / 2)} ${fmt(y + h * 0.78)}L${fmt(x + w / 2)} ${fmt(y + h * 0.2)}L${fmt(x + w - sw / 2)} ${fmt(y + h * 0.78)}`,
  ) as [string, string];
  const wince = eyes.map(({ x, y, width: w, height: h }, index) => {
    const near = x + sw / 2;
    const far = x + w - sw / 2;
    const [x0, x1] = index === 0 ? [near, far] : [far, near];
    return `M${fmt(x0)} ${fmt(y + sw / 2)}L${fmt(x1)} ${fmt(y + h / 2)}L${fmt(x0)} ${fmt(y + h - sw / 2)}`;
  }) as [string, string];
  return { eyes, glints, strokeWidth: sw, happy, wince };
}

export interface BotSpriteProps {
  /** Three thought dots above the head's right side (thinking). */
  thinkDots: [BotSpriteRect, BotSpriteRect, BotSpriteRect];
  /** The plug's arm in shade and its head in the mark tone (tool). */
  plug: { arm: BotSpriteRect; head: BotSpriteRect };
  /** A text cursor beside the face (editing). */
  cursor: BotSpriteRect;
}

export function botSpriteProps(grid: readonly string[]): BotSpriteProps {
  const u = 2.6;
  const dotY = Math.max(0.5, botSpriteTop(grid) * CELL - 4);
  const arm = { x: 42, y: 27, width: 4.5, height: 3 };
  return {
    thinkDots: [0, 1, 2].map((i) => ({ x: 36 + i * u * 1.5, y: dotY, width: u, height: u })) as BotSpriteProps["thinkDots"],
    plug: {
      arm,
      head: { x: arm.x + arm.width - arm.height * 0.2, y: arm.y - arm.height * 0.35, width: arm.height * 1.1, height: arm.height * 1.7 },
    },
    cursor: { x: 45, y: 16.5, width: 2, height: 8 },
  };
}

export const BOT_AVATAR_STATES = [
  "idle",
  "thinking",
  "reading",
  "tool",
  "writing",
  "editing",
  "waiting",
  "done",
  "error",
] as const;
export type BotAvatarState = (typeof BOT_AVATAR_STATES)[number];

/** States shown while a turn runs or waits on the person. */
export function botAvatarStateIsWorking(state: BotAvatarState): boolean {
  return state !== "idle" && state !== "done" && state !== "error";
}

const PHASE_STATES: Record<BotActivityPhase, BotAvatarState> = {
  preparing: "thinking",
  thinking: "thinking",
  tidying: "thinking",
  resuming: "thinking",
  reconnecting: "thinking",
  stopping: "thinking",
  reading: "reading",
  photo: "reading",
  searching: "reading",
  editing: "editing",
  command: "tool",
  app: "tool",
  helper: "tool",
  computer: "tool",
  remembering: "tool",
  routine: "tool",
  working: "tool",
  writing: "writing",
  waiting: "waiting",
};

export interface BotAvatarActivityInput {
  /** The session's state kind (`BotSessionState["kind"]`); absent while it loads. */
  session?: string;
  /** The running turn's live phase (`BotLiveActivity.phase`), when the surface has it. */
  phase?: BotActivityPhase | null;
  /** An approval, question, hand-off, access request or pending plan waits on the person. */
  awaitingPerson?: boolean;
  /** The newest turn failed: a provider or tool failure that left the session idle (`failed_turn`). */
  failed?: boolean;
  /** The person stopped the newest turn. */
  stopped?: boolean;
}

/** Session kinds that mean the turn failed and the Bot can't carry on by itself. */
const FAILED_SESSIONS = new Set(["model_error", "interrupted", "needs_model"]);

/**
 * The state a Bot's avatar is heading to, from the signal that already drives its working
 * indicator. `done` is not a target: the settler shows it when a working target turns idle.
 * A running turn without a phase (the sidebar only knows the session) reads as thinking.
 */
export function botAvatarTarget({ session, phase, awaitingPerson, failed }: BotAvatarActivityInput): BotAvatarState {
  if (awaitingPerson) return "waiting";
  if (session === "running") return phase ? PHASE_STATES[phase] : "thinking";
  return failed || (session !== undefined && FAILED_SESSIONS.has(session)) ? "error" : "idle";
}

/**
 * Whether the end of the turn settles quietly, straight to idle with no done or error moment:
 * the person stopped it, or paused the Bot. A session that failed (interrupted, needing a model)
 * still shows its error, even when the person had pressed Stop.
 */
export function botAvatarEndsQuietly({ session, stopped }: BotAvatarActivityInput): boolean {
  if (session !== undefined && FAILED_SESSIONS.has(session)) return false;
  return stopped === true || session === "paused";
}

export interface BotAvatarSettlerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BotAvatarSettler {
  /** Feed the newest target; `quiet` (`botAvatarEndsQuietly`) skips the done or error moment. */
  update(target: BotAvatarState, quiet?: boolean): void;
  /** The state on screen now. */
  current(): BotAvatarState;
  /** Cancels pending timers. */
  dispose(): void;
}

/**
 * Turns a stream of targets into what the avatar shows. Working targets wait `debounceMs`
 * (about 250 ms) so quick tool bursts don't flicker; when work ends the avatar shows `done`
 * (or `error`) at once, then returns to idle after `settleMs` (about 1.5 s). An error that
 * didn't follow work, such as a Bot that opens already needing a model, stays idle; one that
 * lands during the done moment (the failure reported just after the turn ended) replaces it.
 * A quiet end (a Stop or a pause) returns to idle at once, with no done or error moment.
 */
export function createBotAvatarSettler({
  timers,
  onChange,
  initial = "idle",
  debounceMs = 250,
  settleMs = 1500,
}: {
  timers: BotAvatarSettlerTimers;
  onChange(state: BotAvatarState): void;
  initial?: BotAvatarState;
  debounceMs?: number;
  settleMs?: number;
}): BotAvatarSettler {
  let shown: BotAvatarState = botAvatarStateIsWorking(initial) ? initial : "idle";
  let target: BotAvatarState = shown;
  let handle: unknown;
  const show = (state: BotAvatarState) => {
    if (state === shown) return;
    shown = state;
    onChange(state);
  };
  const clear = () => {
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
  };
  const schedule = (ms: number, next: BotAvatarState) => {
    clear();
    handle = timers.setTimeout(() => {
      handle = undefined;
      show(next);
    }, ms);
  };
  return {
    update(next, quiet = false) {
      if (next === "done") next = "idle";
      if (quiet && !botAvatarStateIsWorking(next)) {
        target = next;
        clear();
        show("idle");
        return;
      }
      if (next === target) return;
      const wasWorking = botAvatarStateIsWorking(target);
      target = next;
      if (botAvatarStateIsWorking(next)) {
        if (shown === next) clear();
        else schedule(debounceMs, next);
        return;
      }
      if (wasWorking && botAvatarStateIsWorking(shown)) {
        clear();
        show(next === "error" ? "error" : "done");
        schedule(settleMs, "idle");
        return;
      }
      if (next === "error" && shown === "done") {
        show("error");
        schedule(settleMs, "idle");
        return;
      }
      // Work ended before the debounce showed it, or nothing was running: settle quietly.
      // A done or error face still on screen finishes its moment before returning to idle.
      if (shown === "done" || shown === "error") schedule(settleMs, "idle");
      else {
        clear();
        show("idle");
      }
    },
    current: () => shown,
    dispose: clear,
  };
}
