import * as React from "react";
import {
  resolveBotAvatar,
  type BotAvatar as BotAvatarValue,
} from "../shared/bots";
import type { BotActivityPhase } from "../shared/bot-activity";
import {
  BOT_SPRITE_SMALL_GLINT_HEX,
  BOT_SPRITE_TONES,
  BOT_SPRITE_VIEWBOX,
  botAvatarEndsQuietly,
  botAvatarStateIsWorking,
  botAvatarTarget,
  botSpriteFace,
  botSpriteGrid,
  botSpriteIsSmall,
  botSpriteProps,
  botSpriteRows,
  createBotAvatarSettler,
  type BotAvatarActivityInput,
  type BotAvatarState,
  type BotSpriteCell,
  type BotSpriteTones,
} from "../shared/bot-sprite";
import { AidenActivityMark } from "./aiden-activity-mark";
import { observeOffscreen } from "../lib/offscreen-pause";
import { useBotCanonicalPhoto } from "../lib/bot-canonical-photo-cache";

const SPRITE_FILL: Record<Exclude<BotSpriteCell, ".">, keyof BotSpriteTones> = {
  o: "shade",
  b: "tint",
  h: "light",
};

type SpriteStyle = React.CSSProperties & Record<`--${string}`, string | number>;

/**
 * A Bot's fallback face: its Hi-bit pixel sprite in the Bot's tint, posed for `state`.
 * `small` is the small cut for faces drawn at 24 px or less: no highlight cells, and larger
 * `deep` eyes with a white glint in place of the `light` one. The glint rides inside the lid, so
 * it closes with the blink; the happy and wince marks have none.
 * The pose is markup and CSS still poses; the stepped motion runs only inside a live
 * `.bot-avatar` with Reduce Motion off (renderer/styles.css).
 */
export function AvatarFace({
  avatar,
  small = false,
  state = "idle",
}: {
  avatar: BotAvatarValue;
  small?: boolean;
  state?: BotAvatarState;
}) {
  const appearance = resolveBotAvatar(avatar);
  const tones = BOT_SPRITE_TONES[appearance.color];
  const grid = React.useMemo(() => botSpriteGrid(appearance.shape, small), [appearance.shape, small]);
  const rows = React.useMemo(() => botSpriteRows(grid), [grid]);
  const face = botSpriteFace(small);
  const props = botSpriteProps(grid);
  const mark = `var(--bs-mark, ${tones.markLight})`;
  const glint = small ? BOT_SPRITE_SMALL_GLINT_HEX : tones.light;
  const strokes = {
    fill: "none",
    stroke: tones.deep,
    strokeWidth: face.strokeWidth,
    strokeLinecap: "square",
    strokeLinejoin: "miter",
  } as const;
  return (
    <svg
      viewBox={`0 0 ${BOT_SPRITE_VIEWBOX} ${BOT_SPRITE_VIEWBOX}`}
      shapeRendering="crispEdges"
      focusable="false"
      className="bot-sprite"
      data-state={state}
      data-cut={small ? "small" : "full"}
      style={
        {
          "--bs-mark-light": tones.markLight,
          "--bs-mark-dark": tones.markDark,
        } as SpriteStyle
      }
    >
      <g className="bs-rig">
        <g className="bs-body">
          {rows.map((row) => (
            <g key={row.y} className="bs-row" data-odd={row.pair % 2 === 1 ? "" : undefined} style={{ "--r": row.pair } as SpriteStyle}>
              {row.runs.map((run) => (
                <rect
                  key={run.x}
                  className="bs-px"
                  data-cell={run.cell}
                  x={run.x}
                  y={run.y}
                  width={run.width}
                  height={run.height}
                  fill={tones[SPRITE_FILL[run.cell]]}
                  style={{ "--c": run.column } as SpriteStyle}
                />
              ))}
            </g>
          ))}
        </g>
        <g className="bs-face">
          {state === "done" ? (
            <g className="bs-happy" {...strokes}>
              {face.happy.map((d) => <path key={d} d={d} />)}
            </g>
          ) : state === "error" ? (
            <g className="bs-wince" {...strokes}>
              {face.wince.map((d) => <path key={d} d={d} />)}
            </g>
          ) : (
            <g className="bs-look">
              <g className="bs-lid">
                <g className="bs-open">
                  {face.eyes.map((eye) => <rect key={eye.x} className="bs-eye" {...eye} fill={tones.deep} />)}
                  {face.glints.map((rect) => <rect key={rect.x} className="bs-glint" {...rect} fill={glint} />)}
                </g>
              </g>
            </g>
          )}
        </g>
        {state === "thinking" ? (
          <g className="bs-think" data-sprite-prop="think">
            {props.thinkDots.map((dot, index) => (
              <rect key={dot.x} className="bs-dot" {...dot} fill={mark} style={{ "--i": index } as SpriteStyle} />
            ))}
          </g>
        ) : null}
        {state === "tool" ? (
          <g className="bs-plug" data-sprite-prop="plug">
            <rect {...props.plug.arm} fill={tones.shade} />
            <rect {...props.plug.head} fill={mark} />
          </g>
        ) : null}
        {state === "editing" ? (
          <g className="bs-cursor" data-sprite-prop="cursor">
            <rect {...props.cursor} fill={mark} />
          </g>
        ) : null}
      </g>
    </svg>
  );
}

const browserTimers = {
  setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
};

/**
 * What a Bot's avatar shows for its live activity: working states after a short debounce,
 * then a done (or error) moment when the turn ends, then idle. A turn the person stopped,
 * either flagged by `stopped` or seen as its last live phase (`stopping`), a paused Bot, and a
 * card answered while no turn runs settle straight to idle.
 */
export function useBotAvatarState(input: BotAvatarActivityInput): BotAvatarState {
  const target = botAvatarTarget(input);
  const phase = input.phase ?? null;
  const running = input.session === "running";
  const endsQuietly = botAvatarEndsQuietly(input);
  const [state, setState] = React.useState<BotAvatarState>(() => (botAvatarStateIsWorking(target) ? target : "idle"));
  const [settler] = React.useState(() =>
    createBotAvatarSettler({ timers: browserTimers, onChange: setState, initial: state }),
  );
  // The newest phase this turn showed; it outlives the phase itself, which clears as the turn
  // ends, and is forgotten once that end is settled so the next turn starts fresh.
  const lastPhase = React.useRef<BotActivityPhase | null>(null);
  // The previous target, to tell a card answered with no turn running from a turn that ended.
  const lastTarget = React.useRef<BotAvatarState>(target);
  React.useEffect(() => {
    if (phase) lastPhase.current = phase;
    const resolvedWithoutTurn = lastTarget.current === "waiting" && target === "idle" && !running;
    settler.update(target, endsQuietly || lastPhase.current === "stopping" || resolvedWithoutTurn);
    lastTarget.current = target;
    if (!botAvatarStateIsWorking(target)) lastPhase.current = null;
  }, [settler, target, phase, running, endsQuietly]);
  React.useEffect(() => () => settler.dispose(), [settler]);
  return state;
}

/** Monochrome Aiden bot mark sized to match the sidebar's Lucide icon rhythm. */
export function BotSidebarIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" focusable="false">
      <path
        d="M12 2.9C14.8 2.9 15.5 5 17.8 5.8C20.1 6.6 21.1 8.8 20 10.9C19.2 12.5 20.5 14.1 19.1 16.5C17.9 18.7 15.9 18.2 13.6 19.6C11.3 21 9.7 19.3 7.3 19.1C4.9 18.8 4.2 16.7 4.4 14.4C4.6 12.4 2.9 11.2 4 8.9C5 6.6 7.1 6.7 8.6 5C9.6 3.7 10.6 2.9 12 2.9Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <ellipse cx="9.2" cy="11.3" rx="1.05" ry="1.45" fill="currentColor" />
      <ellipse cx="14.8" cy="11.3" rx="1.05" ry="1.45" fill="currentColor" />
    </svg>
  );
}

type BotAvatarSize = "small" | "medium" | "large" | "preview";

/** The face's drawn size inside each avatar tile (tile minus padding), which picks the sprite's cut. */
const BOT_AVATAR_FACE_PX: Record<BotAvatarSize, number> = { small: 20, medium: 24, large: 36, preview: 104 };

export function BotAvatar({
  avatar,
  botId,
  name,
  photoLoading = "none",
  size = "medium",
  state,
  working = false,
}: {
  avatar: BotAvatarValue;
  botId?: string;
  name: string;
  photoLoading?: "none" | "visible" | "immediate";
  size?: BotAvatarSize;
  /**
   * The live pose (see `useBotAvatarState`). Set, the face animates it while on screen and
   * Reduce Motion is off; unset, the face is a static idle sprite.
   */
  state?: BotAvatarState;
  /** Shorthand for a running turn without a known phase: `state="thinking"`. */
  working?: boolean;
}) {
  const shownState = state ?? (working ? "thinking" : undefined);
  const live = shownState !== undefined;
  const busy = live && botAvatarStateIsWorking(shownState);
  const avatarRef = React.useRef<HTMLSpanElement>(null);
  const [nearViewport, setNearViewport] = React.useState(photoLoading === "immediate");
  React.useEffect(() => {
    if (photoLoading === "none") {
      setNearViewport(false);
      return;
    }
    if (photoLoading === "immediate") {
      setNearViewport(true);
      return;
    }
    const element = avatarRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setNearViewport(entries.some(({ isIntersecting }) => isIntersecting));
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [photoLoading]);
  const photoEnabled = Boolean(botId) && nearViewport && photoLoading !== "none";
  const photo = useBotCanonicalPhoto(
    botId,
    photoEnabled,
    photoLoading === "immediate" ? "selected" : "visible",
  );
  const [failedRevision, setFailedRevision] = React.useState<string>();
  const showPhoto = photo && failedRevision !== photo.assetRevision;
  React.useEffect(() => {
    const node = avatarRef.current;
    if (!live || !node) return;
    return observeOffscreen(node);
  }, [live]);
  return (
    <span
      ref={avatarRef}
      aria-hidden="true"
      title={name}
      data-working={busy ? "" : undefined}
      data-live={live ? "" : undefined}
      data-state={shownState ?? "idle"}
      className={`bot-avatar relative grid shrink-0 place-items-center overflow-hidden bg-control shadow-control ${
        size === "small"
          ? "size-7 rounded-card p-1"
          : size === "large"
            ? "size-12 rounded-card p-1.5"
            : size === "preview"
              ? "size-36 rounded-[2rem] p-5"
              : "size-9 rounded-card p-1.5"
      }`}
    >
      {showPhoto ? null : (
        <AvatarFace avatar={avatar} small={botSpriteIsSmall(BOT_AVATAR_FACE_PX[size])} state={shownState} />
      )}
      {showPhoto ? (
        <img
          alt=""
          className="absolute inset-0 size-full object-cover"
          draggable={false}
          src={photo.dataUrl}
          onError={() => setFailedRevision(photo.assetRevision)}
        />
      ) : null}
      {showPhoto && busy ? (
        <span className="absolute bottom-0 right-0 grid place-items-center rounded-full bg-background p-px text-primary">
          <AidenActivityMark mark="glance" size={size === "large" || size === "preview" ? 14 : 10} />
        </span>
      ) : null}
    </span>
  );
}
